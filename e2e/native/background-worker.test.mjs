import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chromium, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { REPO_ROOT } from '../lib/paths.ts';

test('phone explicit continue and new-session run actual installed native Pi workers', { timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-native-workers-'));
  const firstCWD = join(root, 'first-project'), newCWD = join(root, 'new-project');
  mkdirSync(firstCWD); mkdirSync(newCWD);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [REPO_ROOT], extensions: [join(REPO_ROOT, 'e2e/lib/native-provider.mjs')],
    defaultProvider: 'lifecycle-test', defaultModel: 'local' }));
  const manager = SessionManager.create(firstCWD, join(root, 'sessions', '--first-project--'));
  manager.appendMessage({ role: 'user', content: 'Inactive native worker history', timestamp: Date.now() });
  const firstID = basename(manager.getSessionFile());
  const token = randomBytes(24).toString('hex');
  let server, browser;
  t.after(async () => {
    await browser?.close();
    if (server) await stopServer(server.child);
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  server = await startServer({ agentDir: root, token, nativeWorkers: true });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, locale: 'en-US' });
  await context.addCookies([{ name: 'pi_token', value: token, url: server.baseURL, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const ownerFile = (id) => join(root, 'pi-web', 'owners', id + '.json');
  const owner = (id) => JSON.parse(readFileSync(ownerFile(id), 'utf8'));
  const api = async (path, body) => {
    const response = await fetch(server.baseURL + path, { headers: { authorization: `Bearer ${token}`, origin: server.baseURL, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  await page.goto(server.baseURL + '/session?id=' + encodeURIComponent(firstID));
  await expect(page.getByRole('article').getByText('Inactive native worker history', { exact: true })).toBeVisible();
  assert.equal(existsSync(ownerFile(firstID)), false, 'reading must not start a native process');
  const continuing = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session/continue');
  await page.getByRole('button', { name: "在后台继续", exact: true }).click();
  const continuation = await continuing;
  assert.equal(continuation.status(), 200, await continuation.text());
  await expect.poll(() => existsSync(ownerFile(firstID)), { timeout: 45000 }).toBe(true);
  const firstOwner = owner(firstID);
  assert.notEqual(firstOwner.pid, process.pid); assert.notEqual(firstOwner.pid, server.child.pid);
  process.kill(firstOwner.pid, 0);
  await expect.poll(async () => (await api('/api/status?id=' + encodeURIComponent(firstID))).canControl).toBe(true);
  await page.getByRole('textbox', { name: "给 Pi 发消息…", exact: true }).fill('Actual background continue');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.getByText('Native lifecycle reply: Actual background continue', { exact: true })).toBeVisible();
  const continued = SessionManager.open(manager.getSessionFile());
  assert.ok(continued.getBranch().some((entry) => entry.type === 'message' && entry.message.role === 'assistant' && JSON.stringify(entry.message.content).includes('Actual background continue')));
  await api('/api/session/continue?id=' + encodeURIComponent(firstID), {});
  assert.equal(owner(firstID).pid, firstOwner.pid, 'repeated explicit continue reuses one actual worker');

  await page.getByRole('button', { name: "新建会话", exact: true }).click();
  const editor = page.getByRole('dialog', {name:'新对话',exact:true});
  await editor.getByRole('button', {name:'选择项目',exact:true}).click();
  const picker = page.getByRole('dialog', {name:'选择项目',exact:true});
  await picker.getByRole('textbox', {name:'文件夹路径',exact:true}).fill(newCWD);
  await picker.getByRole('button', {name:'前往',exact:true}).click();
  await picker.getByRole('button', {name:'使用此文件夹',exact:true}).click();
  await editor.getByRole('textbox', {name:'给 Pi 发消息…',exact:true}).fill('Actual newly created background session');
  await editor.getByRole('button', {name:'发送',exact:true}).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 45000 }).not.toBe(firstID);
  const nextID = new URL(page.url()).searchParams.get('id'); assert.ok(nextID);
  await expect.poll(() => existsSync(ownerFile(nextID)), { timeout: 45000 }).toBe(true);
  const nextOwner = owner(nextID);
  assert.notEqual(nextOwner.pid, firstOwner.pid); process.kill(nextOwner.pid, 0);
  await expect.poll(async () => (await api('/api/status?id=' + encodeURIComponent(nextID))).canControl).toBe(true);
  assert.equal((await api('/api/status?id=' + encodeURIComponent(nextID))).cwd, newCWD);
  await expect(page.getByText('Native lifecycle reply: Actual newly created background session', { exact: true })).toBeVisible();
  assert.equal(readdirSync(join(root, 'pi-web', 'owners')).length, 2);
  console.log(JSON.stringify({ phoneProductionUI: true, authenticatedGo: true, nativeCLIWorkers: true, passiveHistory: true,
    explicitContinueAndReuse: true, manualDirectoryNewSession: true, independentNativePIDs: true,
    nativePersistedAssistant: true, provider: 'deterministic offline adapter; no commercial request' }));
});
