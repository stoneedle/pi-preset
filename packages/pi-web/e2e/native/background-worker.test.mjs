import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SessionManager, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { chromium, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { REPO_ROOT } from '../lib/paths.ts';

test('phone sends and new-session run actual installed native Pi workers', { timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-native-workers-'));
  const firstCWD = join(root, 'first-project'), newCWD = join(root, 'new-project');
  mkdirSync(firstCWD); mkdirSync(newCWD);
  const skillDir = join(newCWD, '.pi', 'skills', 'worker-skill-fixture');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: worker-skill-fixture\ndescription: Native skill loading fixture\n---\nNATIVE_SKILL_INSTRUCTION_PROOF\n');
  new ProjectTrustStore(root).set(newCWD, true);
  mkdirSync(join(root, 'extension-data', 'pi-title-glyphs'), { recursive: true });
  writeFileSync(join(root, 'extension-data', 'pi-title-glyphs', 'config.json'), JSON.stringify({ model: 'lifecycle-test/local' }));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [REPO_ROOT], extensions: [join(REPO_ROOT, 'e2e/lib/native-provider.mjs')],
    defaultProvider: 'lifecycle-test', defaultModel: 'local' }));
  writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { 'lifecycle-test': {
    baseUrl: 'http://127.0.0.1', api: 'openai-completions', apiKey: 'isolated-no-network-key',
    models: [{ id: 'selected', name: 'Selected lifecycle probe', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
  } } }));
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
  await expect(page.getByRole('button', { name: '在后台继续', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '模型设置', exact: true });
  await settings.getByRole('group', { name: '模型', exact: true }).getByRole('button', { name: 'Selected lifecycle probe lifecycle-test', exact: true }).click();
  await settings.getByRole('group', { name: '思考强度', exact: true }).getByRole('button', { name: '高', exact: true }).click();
  await settings.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  assert.equal(existsSync(ownerFile(firstID)), false, 'choosing settings must not start a process');
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Actual background continue');
  const sending = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/chat');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const sent = await sending;
  assert.equal(sent.status(), 202, await sent.text());
  await expect.poll(() => existsSync(ownerFile(firstID)), { timeout: 45000 }).toBe(true);
  const firstOwner = owner(firstID);
  assert.notEqual(firstOwner.pid, process.pid); assert.notEqual(firstOwner.pid, server.child.pid);
  process.kill(firstOwner.pid, 0);
  await expect.poll(async () => (await api('/api/status?id=' + encodeURIComponent(firstID))).canControl).toBe(true);
  await expect(page.getByText('Native lifecycle reply: Actual background continue', { exact: true })).toBeVisible();
  const firstStatus = await api('/api/status?id=' + encodeURIComponent(firstID));
  assert.equal(firstStatus.model, 'selected'); assert.equal(firstStatus.thinking, 'high');
  const continued = SessionManager.open(manager.getSessionFile());
  assert.ok(continued.getBranch().some((entry) => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.model === 'selected'), 'the selected model must execute the first prompt');
  assert.ok(continued.getBranch().some((entry) => entry.type === 'message' && entry.message.role === 'assistant' && JSON.stringify(entry.message.content).includes('Actual background continue')));
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Reuse actual worker');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Native lifecycle reply: Reuse actual worker', { exact: true })).toBeVisible();
  assert.equal(owner(firstID).pid, firstOwner.pid, 'later sends reuse one actual worker');

  process.kill(firstOwner.pid);
  await expect.poll(() => { try { process.kill(firstOwner.pid, 0); return true; } catch { return false; } }).toBe(false);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Fresh native resume after exit');
  const resuming = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/chat');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const resumedSend = await resuming;
  assert.equal(resumedSend.status(), 202, await resumedSend.text());
  await expect(page.getByText('Native lifecycle reply: Fresh native resume after exit', { exact: true })).toBeVisible();
  assert.notEqual(owner(firstID).pid, firstOwner.pid, 'confirmed process exit allows fresh native resume');
  const resumed = SessionManager.open(manager.getSessionFile());
  assert.equal(resumed.getSessionId(), manager.getSessionId(), 'resume keeps the original native UUID');
  const branch = JSON.stringify(resumed.getBranch());
  for (const text of ['Actual background continue', 'Reuse actual worker', 'Fresh native resume after exit']) assert.ok(branch.includes('Native lifecycle reply: ' + text), 'resume preserves persisted answers');
  assert.deepEqual(readdirSync(join(root, 'sessions', '--first-project--')), [firstID], 'resume does not create a recovery copy');

  await page.getByRole('button', { name: "新建会话", exact: true }).click();
  const editor = page.getByRole('dialog', {name:'新对话',exact:true});
  await editor.getByRole('button', {name:'选择项目',exact:true}).click();
  const picker = page.getByRole('dialog', {name:'选择项目',exact:true});
  await picker.locator('summary').filter({hasText:'系统路径'}).click();
  await picker.getByRole('textbox', {name:'文件夹路径',exact:true}).fill(newCWD);
  await picker.getByRole('button', {name:'前往',exact:true}).click();
  await picker.getByRole('button', {name:'使用此文件夹',exact:true}).click();
  const newPrompt = editor.getByRole('textbox', {name:'给 Pi 发消息…',exact:true});
  await newPrompt.fill('/worker-skill');
  await editor.getByRole('button', { name: 'skill:worker-skill-fixture', exact: true }).click();
  await expect(newPrompt).toHaveValue('/skill:worker-skill-fixture ');
  assert.equal(readdirSync(join(root, 'pi-web', 'owners')).length, 1, 'skill completion must not start a new native process');
  await newPrompt.fill('Actual newly created background session');
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

  // A fork is a native file first; entering it starts no worker until the user sends.
  const nextPath = join(root, 'sessions', readdirSync(join(root, 'sessions')).find((directory) =>
    existsSync(join(root, 'sessions', directory, nextID))), nextID);
  await expect(page.locator('.remote-heading h1')).toHaveText('原生命名验证');
  await expect.poll(() => SessionManager.open(nextPath).getSessionName()).toBe('原生命名验证');
  const titleEntries = () => SessionManager.open(nextPath).getEntries().filter(entry => entry.type === 'session_info');
  assert.equal(titleEntries().length, 2, 'owner send saves the opening excerpt and exactly one model title');
  const skillCommands = await api('/api/commands?id=' + encodeURIComponent(nextID));
  assert.ok(skillCommands.commands.some((command) => command.name === 'skill:worker-skill-fixture'), 'the native worker loads the trusted project skill');
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('/skill:worker-skill-fixture skill-request-proof');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => {
    const messages = SessionManager.open(nextPath).getEntries().filter((entry) => entry.type === 'message');
    return messages.some((entry) => entry.message.role === 'assistant' && JSON.stringify(entry.message.content).includes('NATIVE_SKILL_INSTRUCTION_PROOF') && JSON.stringify(entry.message.content).includes('skill-request-proof'));
  }).toBe(true);
  assert.equal(owner(nextID).pid, nextOwner.pid, 'skill invocation reuses the new session worker');
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Keep the first session title');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Native lifecycle reply: Keep the first session title', { exact: true })).toBeVisible();
  assert.equal(titleEntries().length, 2, 'follow-ups cannot restart naming');
  await api('/api/session/name?id=' + encodeURIComponent(nextID), { name: '人工保留的名称' });
  await expect(page.locator('.remote-heading h1')).toHaveText('人工保留的名称');
  const originalBytes = readFileSync(nextPath, 'utf8');
  const forkResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session/fork');
  await page.locator('[data-message-id]').last().getByRole('button', { name: '从这里分叉', exact: true }).click();
  const forked = await forkResponse;
  assert.equal(forked.status(), 201, await forked.text());
  const forkID = (await forked.json()).id;
  await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(forkID);
  await expect(page.getByText('Native lifecycle reply: Actual newly created background session', { exact: true })).toBeVisible();
  assert.equal(existsSync(ownerFile(forkID)), false);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Independent fork continuation');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Native lifecycle reply: Independent fork continuation', { exact: true })).toBeVisible();
  assert.notEqual(owner(forkID).pid, nextOwner.pid);
  assert.equal(owner(nextID).pid, nextOwner.pid);
  assert.equal(readFileSync(nextPath, 'utf8'), originalBytes, 'new work only appends to the fork');
  process.kill(nextOwner.pid, 0);
  console.log(JSON.stringify({ phoneProductionUI: true, authenticatedGo: true, nativeCLIWorkers: true, passiveHistory: true,
    silentStartOnSendAndReuse: true, settingsBeforeFirstPrompt: true, freshNativeResumeAfterExit: true,
    sameOriginalUUIDAndFile: true, manualDirectoryNewSession: true, independentNativePIDs: true,
    nativePersistedAssistant: true, ownerFirstMessageNaming: true, singleModelTitle: true, manualNameWins: true, provider: 'deterministic offline adapter; no commercial request' }));
});
