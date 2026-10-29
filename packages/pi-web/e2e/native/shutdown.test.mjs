import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chromium, webkit, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { launchTestBrowser } from '../lib/browser.mjs';
import { REPO_ROOT } from '../lib/paths.ts';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engineName}: close the selected Pi process tree, release its directory and resume without losing drafts`, { timeout: 120000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-web-shutdown-'));
    const project = join(root, 'project'), otherProject = join(root, 'other-project');
    mkdirSync(project); mkdirSync(otherProject);
    mkdirSync(join(root, 'extension-data', 'pi-title-glyphs'), { recursive: true });
    writeFileSync(join(root, 'extension-data', 'pi-title-glyphs', 'config.json'), JSON.stringify({ model: 'lifecycle-test/local' }));
    const childExtension = join(root, 'owned-child.mjs');
    writeFileSync(childExtension, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export default function(pi) {
        pi.on('session_start', (_event, ctx) => {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ctx.cwd, stdio: 'ignore', windowsHide: true });
          writeFileSync(join(ctx.cwd, 'owned-child.json'), JSON.stringify({ pid: child.pid }));
        });
      }
    `);
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [REPO_ROOT],
      extensions: [join(REPO_ROOT, 'e2e/lib/native-provider.mjs'), childExtension], defaultProvider: 'lifecycle-test', defaultModel: 'local' }));
    const manager = SessionManager.create(project, join(root, 'sessions', 'selected'));
    manager.appendMessage({ role: 'user', content: '需要保留的历史', timestamp: Date.now() });
    const other = SessionManager.create(otherProject, join(root, 'sessions', 'other'));
    other.appendMessage({ role: 'user', content: '其他会话', timestamp: Date.now() });
    const id = basename(manager.getSessionFile()), otherID = basename(other.getSessionFile());
    const token = randomBytes(24).toString('hex');
    let server, ownedBrowser;
    t.after(async () => {
      await ownedBrowser?.close();
      if (server) await stopServer(server.child);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    });
    server = await startServer({ agentDir: root, nativeWorkers: true, token });
    const endpoint = (path, sessionID = id) => server.baseURL + path + '?id=' + encodeURIComponent(sessionID);
    const headers = { authorization: `Bearer ${token}`, origin: server.baseURL };
    const status = async () => (await fetch(endpoint('/api/status'), { headers })).json();
    const ownerPath = (sessionID = id) => join(root, 'pi-web', 'owners', sessionID + '.json');
    const owner = (sessionID = id) => JSON.parse(readFileSync(ownerPath(sessionID), 'utf8'));
    const hostPath = join(root, 'pi-web', 'workers', id + '.json');
    const send = async (message, sessionID = id, delivery = '') => {
      const body = new FormData(); body.set('message', message);
      if (delivery) body.set('delivery', delivery);
      const response = await fetch(endpoint('/api/chat', sessionID), { method: 'POST', headers, body });
      assert.equal(response.status, 202, await response.text());
    };
    const dormant = await fetch(endpoint('/api/session/shutdown'), { method: 'POST', headers });
    assert.equal(dormant.status, 409, 'closing a dormant session must not start a worker');
    assert.equal(existsSync(ownerPath()), false);
    const anonymous = await fetch(endpoint('/api/session/shutdown'), { method: 'POST', headers: { origin: server.baseURL } });
    assert.equal(anonymous.status, 401);
    const foreign = await fetch(endpoint('/api/session/shutdown'), { method: 'POST', headers: { ...headers, origin: 'https://example.com' } });
    assert.equal(foreign.status, 403);

    ownedBrowser = await launchTestBrowser(engine);
    const context = await ownedBrowser.browser.newContext({ viewport: { width: 320, height: 568 }, locale: 'zh-CN' });
    await context.addCookies([{ name: 'pi_token', value: token, url: server.baseURL, sameSite: 'Lax' }]);
    const page = await context.newPage();
    await page.goto(endpoint('/session'));
    await expect(page.getByRole('article').getByText('需要保留的历史', { exact: true })).toBeVisible();
    await page.getByLabel('更多', { exact: true }).click();
    const closeButton = page.getByRole('button', { name: '关闭进程', exact: true });
    await expect(closeButton).toBeDisabled();
    await page.getByLabel('更多', { exact: true }).click();
    await send('正常后台任务');
    await send('不受关闭影响的会话', otherID);
    await expect.poll(async () => (await status()).canControl).toBe(true);
    await expect(page.getByText('Native lifecycle reply: 正常后台任务', { exact: true })).toBeVisible();
    const selectedOwner = owner(), peer = owner(otherID);
    const selectedHost = JSON.parse(readFileSync(hostPath, 'utf8'));
    const toolChild = JSON.parse(readFileSync(join(project, 'owned-child.json'), 'utf8'));
    const otherChild = JSON.parse(readFileSync(join(otherProject, 'owned-child.json'), 'utf8'));
    assert.equal(alive(toolChild.pid), true);
    const original = readFileSync(manager.getSessionFile(), 'utf8');
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await draft.fill('关闭后仍然保留的草稿');
    let calls = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/session/shutdown') calls++; });
    const chooseClose = async (accept) => {
      await draft.blur();
      await page.getByLabel('更多', { exact: true }).click();
      await closeButton.scrollIntoViewIfNeeded();
      await expect(closeButton).toBeEnabled();
      const box = await closeButton.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 320 && box.height >= 44);
      mkdirSync(join(REPO_ROOT, 'build', 'test-results'), { recursive: true });
      await page.screenshot({ path: join(REPO_ROOT, 'build', 'test-results', `shutdown-${engineName}-menu.png`) });
      const dialog = page.waitForEvent('dialog');
      const clicking = closeButton.click();
      const confirmation = await dialog;
      assert.match(confirmation.message(), /强制结束/);
      if (accept) await confirmation.accept(); else await confirmation.dismiss();
      await clicking;
    };
    await chooseClose(false);
    assert.equal(calls, 0, 'cancelling must not send a control request');
    assert.equal(alive(selectedOwner.pid), true);
    if (process.platform === 'win32') {
      assert.throws(() => renameSync(project, project + '-moved'), error => ['EBUSY', 'EPERM'].includes(error.code), 'the live native process holds the project directory');
    }
    const closed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/shutdown');
    await chooseClose(true);
    assert.equal((await closed).status(), 200);
    await expect.poll(() => alive(selectedOwner.pid)).toBe(false);
    await expect.poll(() => alive(selectedHost.pid)).toBe(false);
    await expect.poll(() => alive(toolChild.pid)).toBe(false);
    assert.equal(alive(otherChild.pid), true);
    await expect.poll(async () => (await status()).availability).toBe('disconnected');
    assert.equal(calls, 1, 'closing is never replayed');
    assert.equal(alive(peer.pid), true, 'another session must stay alive');
    assert.equal(alive(server.child.pid), true, 'the web service must stay alive');
    assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), original, 'closing does not rewrite saved history');
    await expect(draft).toHaveValue('关闭后仍然保留的草稿');
    const resuming = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const resumedSend = await resuming;
    assert.equal(resumedSend.status(), 202, await resumedSend.text());
    await expect(page.getByText('Native lifecycle reply: 关闭后仍然保留的草稿', { exact: true })).toBeVisible();
    const resumed = owner();
    assert.notEqual(resumed.pid, selectedOwner.pid);
    assert.equal(SessionManager.open(manager.getSessionFile()).getSessionId(), manager.getSessionId());
    await expect(page.getByRole('article').getByText('需要保留的历史', { exact: true })).toBeVisible();

    await send('hold-until-release 关闭运行中的任务');
    await expect.poll(async () => (await status()).mainRunning).toBe(true);
    await send('不会自动执行的排队消息', id, 'followUp');
    await expect.poll(async () => (await status()).queueCount).toBe(1);
    await draft.fill('任务中断后保留的草稿');
    const beforeRunningClose = readFileSync(manager.getSessionFile(), 'utf8');
    const resumedHost = JSON.parse(readFileSync(hostPath, 'utf8'));
    const resumedChild = JSON.parse(readFileSync(join(project, 'owned-child.json'), 'utf8'));
    await page.setViewportSize({ width: 320, height: 390 });
    const interrupted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/shutdown');
    await chooseClose(true);
    assert.equal((await interrupted).status(), 200);
    await expect.poll(() => alive(resumed.pid)).toBe(false);
    await expect.poll(() => alive(resumedHost.pid)).toBe(false);
    await expect.poll(() => alive(resumedChild.pid)).toBe(false);
    await expect(draft).toHaveValue('任务中断后保留的草稿');
    assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), beforeRunningClose);
    assert.equal(alive(peer.pid), true);
    await expect.poll(() => {
      try { renameSync(project, project + '-moved'); return true; }
      catch (error) { if (['EBUSY', 'EPERM'].includes(error.code)) return false; throw error; }
    }).toBe(true);
    renameSync(project + '-moved', project);
  });
}
