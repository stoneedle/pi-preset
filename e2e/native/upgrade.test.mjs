import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chromium, webkit, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { buildUpdatedRelease } from '../lib/updated-release.ts';
import { launchTestBrowser } from '../lib/browser.mjs';
import { readDiagnostics } from '../lib/diagnostics.ts';
import { BINARY, REPO_ROOT } from '../lib/paths.ts';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const releaseMark = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pi-web-release-probe').trim());
async function refresh(page) {
  await page.locator('summary[aria-label="更多"]').click();
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await navigation;
}

test('real Go upgrades and waiting workers never replace documents; only manual refresh loads the new interface', { timeout: 240000 }, async (t) => {
  const updated = buildUpdatedRelease();
  t.after(() => updated.close());
  for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
    await t.test(name, { timeout: 90000 }, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'pi-web-upgrade-'));
      const cwd = join(root, 'project'); mkdirSync(cwd);
      const gate = join(root, 'release');
      writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [REPO_ROOT], extensions: [join(REPO_ROOT, 'e2e/lib/native-provider.mjs')], defaultProvider: 'lifecycle-test', defaultModel: 'local' }));
      const session = SessionManager.create(cwd, join(root, 'sessions', '--project--'));
      session.appendMessage({ role: 'user', content: 'Existing history before the upgrade', timestamp: Date.now() });
      const id = basename(session.getSessionFile());
      const token = randomBytes(24).toString('hex');
      let server, browserHost;
      t.after(async () => {
        writeFileSync(gate, 'release');
        if (server) await stopServer(server.child);
        await browserHost?.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
      });
      server = await startServer({ agentDir: root, token, nativeWorkers: true, env: { PI_WEB_NATIVE_GATE: gate } });
      const options = { agentDir: root, token, nativeWorkers: true, port: Number(new URL(server.baseURL).port), env: { PI_WEB_NATIVE_GATE: gate } };
      browserHost = await launchTestBrowser(engine);
      const context = await browserHost.browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: 'pi_token', value: token, url: server.baseURL, sameSite: 'Lax' }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(server.baseURL + '/session?id=' + encodeURIComponent(id));
      await expect(page.getByRole('article').getByText('Existing history before the upgrade', { exact: true })).toBeVisible();
      await page.evaluate(async () => { await navigator.serviceWorker.ready; window.__beforeUpgrade = true; });
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      const otherPage = await context.newPage();
      await otherPage.goto(server.baseURL);
      await otherPage.evaluate(() => { window.__otherDocument = true; });
      const oldStyle = await page.locator('link[rel=stylesheet][href^="/static/"]').first().getAttribute('href');
      await page.addScriptTag({ content: `{
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args);
          if (new URL(String(args[0]), location.href).pathname === '/api/chat')
            await new Promise(resolve => { window.__releaseSend = resolve; });
          return response;
        };
      }` });
      await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('hold-until-release: survive this deployment');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => window.__releaseSend);
      const ownerFile = join(root, 'pi-web', 'owners', id + '.json');
      await expect.poll(() => existsSync(ownerFile), { timeout: 35000 }).toBe(true);
      const ownerPID = JSON.parse(readFileSync(ownerFile, 'utf8')).pid;
      const hostFile = join(root, 'pi-web', 'workers', id + '.json');
      const hostPID = JSON.parse(readFileSync(hostFile, 'utf8')).pid;
      await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'running');
      await stopServer(server.child, { preserveWorkers: true });
      assert.ok(alive(ownerPID)); assert.ok(alive(hostPID));
      server = await startServer({ ...options, binary: updated.binary });

      // This is the original failure: a current document is controlled by an older worker.
      const fresh = await context.newPage();
      let freshDocuments = 0;
      let fullReads = 0;
      fresh.on('request', request => {
        if (request.isNavigationRequest()) freshDocuments++;
        const url = new URL(request.url());
        if (url.pathname === '/api/session' && !url.searchParams.has('after') && !url.searchParams.has('before')) fullReads++;
      });
      await fresh.goto(server.baseURL + '/session?id=' + encodeURIComponent(id));
      await expect.poll(() => fresh.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state), { timeout: 15000 }).toBe('installed');
      await fresh.evaluate(() => { window.__currentDocument = true; });
      await expect.poll(() => releaseMark(fresh)).toBe('updated');
      await fresh.waitForTimeout(1200);
      assert.equal(freshDocuments, 1);
      assert.equal(fullReads, 1, 'a current session must not fall back to another full read when its worker catches up');
      assert.equal(await page.evaluate(() => window.__beforeUpgrade), true);
      assert.equal(await otherPage.evaluate(() => window.__otherDocument), true);
      assert.equal(await releaseMark(page), '');
      await page.locator('summary[aria-label="更多"]').click();
      await expect(page.getByRole('button', { name: '刷新界面', exact: true })).toBeDisabled();
      await page.locator('summary[aria-label="更多"]').click();
      await page.evaluate(() => window.__releaseSend());
      await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
      await refresh(page);
      await expect.poll(() => releaseMark(page)).toBe('updated');
      assert.equal(await page.evaluate(() => window.__beforeUpgrade), undefined);
      assert.equal(await otherPage.evaluate(() => window.__otherDocument), true);
      await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'running');
      assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).pid, ownerPID);
      assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).pid, hostPID);
      assert.equal(SessionManager.open(session.getSessionFile()).getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('hold-until-release')).length, 1, 'no replay across manual refresh');

      // Cache reachability is independent of both the controller and the document release.
      const newStyle = await page.locator('link[rel=stylesheet][href^="/static/"]').first().getAttribute('href');
      assert.notEqual(oldStyle, newStyle);
      await stopServer(server.child, { preserveWorkers: true });
      const retainedStyles = await page.evaluate(async styles => Promise.all(styles.map(async style => {
        try { return { style, ok: (await fetch(style + '?retention-check', { cache: 'no-store' })).ok }; }
        catch (error) { return { style, ok: false, error: error.message }; }
      })), [oldStyle, newStyle]);
      assert.ok(retainedStyles.every(style => style.ok), JSON.stringify(retainedStyles));
      server = await startServer({ ...options, binary: updated.binary });
      assert.equal(await fresh.evaluate(() => window.__currentDocument), true);
      const keys = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat());
      assert.ok(keys.length && keys.every(path => path.startsWith('/static/assets/')), 'only public build assets may be cached');

      await stopServer(server.child, { preserveWorkers: true });
      server = await startServer({ ...options, binary: BINARY });
      assert.equal(await releaseMark(page), 'updated');
      await refresh(page);
      await expect.poll(() => releaseMark(page)).toBe('');
      assert.equal(await releaseMark(fresh), 'updated', 'refreshing one tab must not refresh another');
      assert.ok(alive(ownerPID));
      writeFileSync(gate, 'release');
      await expect(page.getByText('Native lifecycle reply: hold-until-release: survive this deployment', { exact: true })).toBeVisible({ timeout: 15000 });
      await expect.poll(() => readDiagnostics(root).filter(event => event.event === 'page.reload').length, { timeout: 15000 }).toBe(2);
      assert.ok(readDiagnostics(root).filter(event => event.event === 'page.reload').every(event => event.reason === 'manual'));
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine: name, sameNativePID: true, sameHostPID: true, manualOnly: true, currentPageOldWorkerNoReload: true, fullReads, oldAndNewAssetsWithoutServer: true, pendingControlProtected: true, noReplay: true, rollback: true, independentTabs: true }));
    });
  }
});
