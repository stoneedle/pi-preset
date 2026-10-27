import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { chromium, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { REPO_ROOT } from '../lib/paths.ts';

// The provider is deterministic; Pi, package loading, queues, native persistence, auth,
// loopback subscriptions, SQLite, Go and the production phone UI are real.
test('authenticated phone controls the installed merged extension in the same native Pi runtime', { timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-integrated-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session, server, browser;
  let releaseQueue = () => {};
  t.after(async () => {
    releaseQueue();
    await browser?.close();
    if (server) await stopServer(server.child);
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  try {
  const manager = SessionManager.create(root, join(root, 'sessions', '--native--'));
  manager.appendMessage({ role: 'user', content: 'Native remote integration', timestamp: Date.now() });
  const historicalResult = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Restored historical result' }], api: 'remote-test', provider: 'remote-test', model: 'one', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const eventBus = createEventBus();
  const initialSettings = { packages: [REPO_ROOT],
    extensions: [], defaultProvider: 'remote-test', defaultModel: 'one', defaultThinkingLevel: 'medium', theme: 'dark' };
  writeFileSync(join(root, 'settings.json'), JSON.stringify(initialSettings));
  const settings = SettingsManager.create(root, root);
  const modelCalls = [];
  const provider = (pi) => pi.registerProvider('remote-test', {
    baseUrl: 'http://127.0.0.1', apiKey: 'isolated-test-key', api: 'remote-test',
    models: ['one', 'two'].map((id) => ({ id, name: id, reasoning: true, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.filter((message) => message.role === 'user').at(-1);
      const text = typeof user.content === 'string' ? user.content : user.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      modelCalls.push({ model: model.id, text, images: Array.isArray(user.content) ? user.content.filter((part) => part.type === 'image').length : 0 });
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
        timestamp: Date.now(), stopReason: 'pending', usage: { input: 40, output: 10, cacheRead: 60, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          await options?.onPayload?.({ text }, model);
          stream.push({ type: 'start', partial: message });
          await new Promise((resolve) => {
            const timeout = text === 'queue boundary' ? undefined : setTimeout(done, text.includes('silent') ? 16000 : text === 'delivery boundary' ? 2500 : 80);
            if (text === 'queue boundary') releaseQueue = done;
            function done() { clearTimeout(timeout); options?.signal?.removeEventListener('abort', done); resolve(); }
            options?.signal?.addEventListener('abort', done, { once: true });
          });
          if (options?.signal?.aborted) throw new Error('Aborted');
          message.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content[0].text = `Native reply: ${text}`;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: message.content[0].text, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
          if (text === 'photo') message.content.push({ type: 'thinking', thinking: 'Native image reasoning' });
          message.stopReason = 'stop';
          stream.push({ type: 'done', reason: 'stop', message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; message.errorMessage = String(error);
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
  const skillDir = join(root, '.pi', 'skills', 'probe');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: probe\ndescription: Native available skill\n---\nInspect this task.\n');
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, eventBus,
    extensionFactories: [provider], noContextFiles: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const product = loader.getExtensions().extensions.filter((extension) => extension.path.replaceAll('\\', '/').startsWith(REPO_ROOT.replaceAll('\\', '/').replace(/\/$/, '')));
  assert.equal(product.length, 1, 'one product entrypoint is installed');
  assert.match(product[0].path.replaceAll('\\', '/'), /\.pi\/extensions\/index\.ts$/);
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.sqlite'), allowModelNetwork: false, refreshOnCreate: false });
  ({ session } = await createAgentSession({ cwd: root, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: true }));
  const errors = [];
  const bind = () => session.bindExtensions({ mode: 'rpc', uiContext: { notify: (message) => errors.push(message) }, onError: (error) => errors.push(error.error) });
  await bind();
  await session.setModel(session.modelRuntime.getModel('remote-test', 'one'));
  const token = randomBytes(24).toString('hex');
  server = await startServer({ agentDir: root, token });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 393, height: 851 } });
  const page = await context.newPage();
  const id = basename(manager.getSessionFile());
  const ownerFile = join(root, 'pi-web', 'owners', id + '.json');
  const originalOwner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  assert.equal(originalOwner.pid, process.pid);
  const api = async (path, body) => {
    const response = await fetch(server.baseURL + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: server.baseURL }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200); return response.json();
  };
  const status = () => api(`/api/status?id=${encodeURIComponent(id)}`);
  const fork = async (body = {}, expected = 201) => {
    const response = await fetch(server.baseURL + '/api/session/fork?id=' + encodeURIComponent(id), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, origin: server.baseURL, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    if (expected !== 201) return result;
    const copy = SessionManager.open(join(root, 'sessions', '--native--', result.id));
    assert.notEqual(copy.getSessionId(), manager.getSessionId());
    assert.equal(copy.getHeader().parentSession, manager.getSessionFile());
    assert.equal(existsSync(join(root, 'pi-web', 'owners', result.id + '.json')), false);
    return copy;
  };
  const pushPublicKey = (await api('/api/push/config')).publicKey;
  const completedEvents = (resultId) => {
    const db = new DatabaseSync(join(root, 'pi-web.sqlite'), { readOnly: true });
    try {
      return db.prepare("SELECT value FROM push_events WHERE json_extract(value,'$.kind')='completed' AND json_extract(value,'$.identity')=?").all(resultId).map((row) => JSON.parse(row.value));
    } finally { db.close(); }
  };
  await expect.poll(async () => (await status()).availability).toBe('connected');
  assert.equal((await status()).completed, false, 'historical restore cannot manufacture a completion');
  assert.deepEqual((await status()).usage, { input: 1, output: 1 });
  assert.equal((await status()).canQueue, true);
  assert.equal(completedEvents(historicalResult).length, 0, 'historical restore must not enter the notification outbox');
  assert.equal((await fetch(server.baseURL + '/api/status?id=' + encodeURIComponent(id))).status, 401);
  await page.goto(`${server.baseURL}/session?id=${encodeURIComponent(id)}&token=${token}`);
  await expect(page.locator('.model-trigger')).toContainText('one');
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('phone text');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: phone text');
  assert.ok(manager.getBranch().some((entry) => entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes('phone text')));
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('/pro');
  await page.getByRole('button', { name: /skill:probe/ }).click();
  assert.ok(!readFileSync(manager.getSessionFile(), 'utf8').includes('/skill:probe'));
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('photo');
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png',
    buffer: await page.screenshot() });
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: photo');
  assert.equal(modelCalls.at(-1).images, 1);
  await session.waitForIdle();
  const photoLeaf = manager.getLeafId();
  const firstResult = manager.getBranch().find((entry) => entry.message?.role === 'assistant' && JSON.stringify(entry.message.content).includes('Native reply: phone text')).id;
  await session.navigateTree(firstResult, { summarize: false });
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: phone text');
  await expect(page.locator('.remote-main')).not.toContainText('Native reply: photo');
  assert.equal((await status()).unread, false);
  const sourceBeforeFork = readFileSync(manager.getSessionFile(), 'utf8');
  const branchCopy = await fork();
  assert.ok(branchCopy.getEntry(firstResult), 'includes the current entry');
  assert.equal(branchCopy.getEntry(photoLeaf), undefined, 'uses live leaf, not the later disk tail');
  assert.equal(manager.getLeafId(), firstResult, 'fork cannot move the source runtime');
  assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), sourceBeforeFork);
  assert.deepEqual(JSON.parse(readFileSync(ownerFile, 'utf8')), originalOwner);
  await fork({ entryId: photoLeaf }, 409);
  await session.navigateTree(photoLeaf, { summarize: false });
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: photo');
  const imageEntry = manager.getBranch().find((entry) => entry.message?.role === 'user' && Array.isArray(entry.message.content) && entry.message.content.some((part) => part.type === 'image'));
  assert.equal((await api(`/api/session/block?id=${encodeURIComponent(id)}&entry=${photoLeaf}&index=1`)).text, 'Native image reasoning');
  manager.resetLeaf();
  await session.extensionRunner.emit({ type: 'session_tree', newLeafId: null });
  assert.equal(manager.getBranch().length, 0);
  await fork({}, 409);
  await expect.poll(async () => (await api(`/api/session?id=${encodeURIComponent(id)}`)).window.messages.length).toBe(0);
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  for (const path of [`/api/session/block?id=${encodeURIComponent(id)}&entry=${photoLeaf}&index=1`, `/api/session/image?id=${encodeURIComponent(id)}&entry=${imageEntry.id}&index=0`])
    assert.equal((await fetch(server.baseURL + path, { headers: { authorization: `Bearer ${token}` } })).status, 404, 'known empty root must not expose previous-branch bodies');
  await session.navigateTree(photoLeaf, { summarize: false });
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: photo');
  const previewDir = join(root, 'native-preview');
  mkdirSync(previewDir);
  writeFileSync(join(previewDir, 'index.html'), '<!doctype html><h1>Native prototype</h1><button>Try prototype</button><p></p><script type="module" src="./app.mjs"></script>');
  writeFileSync(join(previewDir, 'app.mjs'), "document.querySelector('button').onclick=async()=>document.querySelector('p').textContent=(await(await fetch('./data.json')).json()).message");
  writeFileSync(join(previewDir, 'data.json'), JSON.stringify({ message: 'Native relative resources work' }));
  const nativeDocument = '# Native downloadable document\n\n**Rendered in isolation**';
  writeFileSync(join(previewDir, 'readme.md'), nativeDocument);
  const previewPath = pathToFileURL(join(previewDir, 'index.html')).href;
  await session.prompt(`[Native prototype](${previewPath}) and [Native document](${pathToFileURL(join(previewDir, 'readme.md')).href})`, { source: 'extension' });
  await expect(page.locator('[data-message-id]').last()).toContainText('Native prototype');
  assert.equal((await context.cookies()).find((cookie) => cookie.name === 'pi_token').value, token);
  await page.getByRole('group', { name: 'index.html', exact: true }).last().getByRole('button', { name: "预览" }).click();
  const previewFrame = page.frameLocator('.remote-preview iframe');
  await previewFrame.getByRole('button', { name: 'Try prototype' }).click();
  await expect(previewFrame.locator('p')).toHaveText('Native relative resources work');
  const isolated = page.frames().find((frame) => frame.parentFrame());
  assert.deepEqual(await isolated.evaluate(async (id) => {
    let parentBlocked = false, cookiesBlocked = false, readBlocked = false, controlBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    try { void document.cookie; } catch { cookiesBlocked = true; }
    try { await fetch('/api/status?id=' + id, { credentials: 'include' }); } catch { readBlocked = true; }
    try { await fetch('/api/chat/cancel?id=' + id, { method: 'POST', credentials: 'include' }); } catch { controlBlocked = true; }
    return { parentBlocked, cookiesBlocked, readBlocked, controlBlocked };
  }, id), { parentBlocked: true, cookiesBlocked: true, readBlocked: true, controlBlocked: true });
  const scopedPreview = await page.locator('.remote-preview iframe').getAttribute('src');
  const publicPreview = await fetch(server.baseURL + scopedPreview);
  assert.equal(publicPreview.status, 200, 'preview capability does not require the remote-control cookie');
  assert.ok(!(await publicPreview.text()).includes(token));
  assert.equal((await fetch(server.baseURL + '/api/status?id=' + id)).status, 401, 'preview capability has no control authority');
  await page.getByRole('button', { name: "关闭", exact: true }).click();
  await expect.poll(async () => (await fetch(server.baseURL + scopedPreview)).status).toBe(404);
  const nativeDownloadPromise = page.waitForEvent('download');
  await page.getByRole('group', { name: 'readme.md', exact: true }).last().getByRole('link', { name: "下载" }).click();
  const nativeDownload = await nativeDownloadPromise;
  const nativeChunks = [];
  for await (const chunk of await nativeDownload.createReadStream()) nativeChunks.push(chunk);
  assert.equal(Buffer.concat(nativeChunks).toString(), nativeDocument);
  await session.navigateTree(firstResult, { summarize: false });
  await session.prompt('A different native branch', { source: 'extension' });
  await expect(page.locator('[data-message-id]').last()).toContainText('A different native branch');
  await session.navigateTree(photoLeaf, { summarize: false });
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: photo');
  await expect.poll(() => page.locator('.remote-image-preview img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.remote-image-preview img')).toHaveAttribute('src', /thumbnail=1/);
  await expect(page.getByRole('link', { name: "打开图片", exact: true })).not.toHaveAttribute('href', /[?&]thumbnail=/);
  const photoEntry = manager.getBranch().find((entry) => entry.message?.role === 'user' && Array.isArray(entry.message.content) && entry.message.content.some((part) => part.type === 'image'));
  await expect(page.locator('.remote-image').getByRole('link', { name: '下载', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '打开图片', exact: true }).click();
  const imagePreview = page.getByRole('dialog', { name: '预览', exact: true });
  const nativeImagePromise = page.waitForEvent('download');
  await imagePreview.getByRole('link', { name: '下载', exact: true }).click();
  const nativeImageChunks = [];
  for await (const chunk of await (await nativeImagePromise).createReadStream()) nativeImageChunks.push(chunk);
  assert.deepEqual(Buffer.concat(nativeImageChunks), Buffer.from(photoEntry.message.content.find((part) => part.type === 'image').data, 'base64'));
  await imagePreview.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', {name:'模型设置',exact:true}).click();
  const modelSettings = page.getByRole('dialog', {name:'模型设置',exact:true});
  await modelSettings.getByRole('group', {name:'模型',exact:true}).getByRole('button', {name:'two remote-test',exact:true}).click();
  await modelSettings.getByRole('group', {name:'思考强度',exact:true}).getByRole('button', {name:'高',exact:true}).click();
  await modelSettings.getByRole('button', {name:'关闭模型设置',exact:true}).click();
  await page.locator('.remote-info summary').click();
  await expect.poll(() => session.model.id).toBe('two');
  await expect.poll(() => session.thinkingLevel).toBe('high');
  const savedSettings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
  assert.equal(savedSettings.defaultModel, 'one');
  assert.equal(savedSettings.defaultThinkingLevel, 'medium');
  session.setThinkingLevel('low');
  await expect(page.locator('.model-thinking')).toHaveText('低');
  await page.locator('.remote-info summary').click();
  const deliveryStart = modelCalls.length;
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('delivery boundary');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
  await expect(page.getByRole('combobox', { name: "消息投递" })).toHaveCount(0);
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('change direction');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: change direction');
  assert.deepEqual(modelCalls.slice(deliveryStart).map((call) => call.text), ['delivery boundary', 'change direction']);
  await session.waitForIdle();
  const queueStart = modelCalls.length;
  const queueRun = session.prompt('queue boundary', { source: 'extension' });
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('native follow-up only');
  await page.getByRole('button', { name: '发送', exact: true }).click({ button: 'right' });
  await page.getByRole('menu', { name: '发送选项', exact: true }).getByRole('menuitem', { name: '排队', exact: true }).click();
  await expect(page.locator('[data-queue-id]')).toHaveCount(1);
  const queued = await api('/api/session/queue?id=' + encodeURIComponent(id));
  assert.equal(queued.items[0].message, 'native follow-up only');
  const consumedQueueId = queued.items[0].id;
  assert.deepEqual(session.getFollowUpMessages(), [], 'web items stay retractable until native settlement');
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('cancel this native follow-up');
  const queuedImage = Buffer.concat([await page.screenshot({ clip: { x: 0, y: 0, width: 10, height: 10 } }), Buffer.alloc(2 << 20)]);
  await page.locator('input[type=file]').setInputFiles({ name: 'withdraw.png', mimeType: 'image/png', buffer: queuedImage });
  await page.getByRole('button', { name: '发送', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '排队', exact: true }).click();
  await expect(page.locator('[data-queue-id]')).toHaveCount(2);
  const beforeTake = await api('/api/session/queue?id=' + encodeURIComponent(id));
  const imageDetail = await api('/api/session/queue?id=' + encodeURIComponent(id) + '&item=' + beforeTake.items[1].id);
  assert.equal(imageDetail.item.images[0].data, queuedImage.toString('base64'), 'original image larger than ordinary control replies remains readable');
  assert.ok(!JSON.stringify(await status()).includes('native follow-up only'), 'status snapshots carry no queued content');
  await page.locator('[data-queue-id]').last().getByRole('button', { name: '取回编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('cancel this native follow-up');
  await expect(page.locator('.remote-images img')).toHaveCount(1);
  await page.getByRole('button', { name: '发送', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '排队', exact: true }).click();
  await expect(page.locator('[data-queue-id]')).toHaveCount(2);
  await page.locator('[data-queue-id]').last().getByRole('button', { name: '取消排队', exact: true }).click();
  await expect(page.locator('[data-queue-id]')).toHaveCount(1);
  assert.deepEqual(modelCalls.slice(queueStart).map((call) => call.text), ['queue boundary']);
  assert.equal(manager.getBranch().some((entry) => entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes('native follow-up only')), false);
  releaseQueue();
  await queueRun;
  await expect(page.locator('[data-message-id]').last()).toContainText('Native reply: native follow-up only');
  assert.deepEqual(modelCalls.slice(queueStart).map((call) => call.text), ['queue boundary', 'native follow-up only']);
  await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
  await expect(page.locator('[data-queue-id]')).toHaveCount(0);
  const lateCancel = await fetch(server.baseURL + '/api/session/queue?id=' + encodeURIComponent(id), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, origin: server.baseURL, 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: consumedQueueId }),
  });
  assert.equal(lateCancel.status, 409, 'already delivered queue item cannot be cancelled');
  assert.equal(typeof (await status()).usage.input, 'number');
  assert.ok((await status()).usage.input > 0);
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('silent task');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('preserve pending across native reload');
  await page.getByRole('button', { name: '发送', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '排队', exact: true }).click();
  await expect(page.locator('[data-queue-id]')).toHaveCount(1);
  const pendingBeforeStop = (await api('/api/session/queue?id=' + encodeURIComponent(id))).items;
  const runningLeaf = manager.getLeafId();
  const runningSource = readFileSync(manager.getSessionFile(), 'utf8');
  const runningCopy = await fork();
  assert.ok(runningCopy.getEntry(runningLeaf));
  assert.equal(session.isStreaming, true, 'fork must not abort an active response');
  assert.equal(manager.getLeafId(), runningLeaf);
  assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), runningSource);
  assert.deepEqual(JSON.parse(readFileSync(ownerFile, 'utf8')), originalOwner);
  await page.waitForTimeout(11000);
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
  await page.getByRole('button', { name: "停止主代理", exact: true }).click();
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'idle');
  assert.equal((await status()).outcome, 'aborted');
  assert.deepEqual((await api('/api/session/queue?id=' + encodeURIComponent(id))).items, pendingBeforeStop, 'stop leaves pending items retractable');
  await session.reload();
  assert.deepEqual((await api('/api/session/queue?id=' + encodeURIComponent(id))).items, pendingBeforeStop, 'extension reload preserves exact queue identities');
  await api('/api/session/queue?id=' + encodeURIComponent(id), { itemId: pendingBeforeStop[0].id });
  assert.equal((await api('/api/session/queue?id=' + encodeURIComponent(id))).items.length, 0);
  await page.evaluate(() => { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await session.prompt('terminal result', { source: 'extension' });
  await expect.poll(async () => (await status()).unread).toBe(true, { message: 'list browsing must not acknowledge' });
  const notifiedResult = (await status()).replyId;
  await expect.poll(() => completedEvents(notifiedResult).length).toBe(1);
  assert.equal(completedEvents(notifiedResult)[0].sessionId, manager.getSessionId());
  assert.ok(!JSON.stringify(completedEvents(notifiedResult)).includes('Native reply: terminal result'));
  await api('/api/session/acknowledge?id=' + encodeURIComponent(id), { replyId: firstResult });
  assert.equal((await status()).unread, true, 'late old confirmation cannot clear the current result');
  await page.evaluate(id => { history.pushState(null, '', '/session?id=' + encodeURIComponent(id)); window.dispatchEvent(new PopStateEvent('popstate')); }, id);
  await expect.poll(async () => (await status()).unread).toBe(false);
  await page.evaluate(() => { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await session.prompt('offline terminal result', { source: 'extension' });
  const previewBeforeRestart = await api('/api/session/preview?id=' + encodeURIComponent(id), { path: previewPath });
  await stopServer(server.child);
  await session.extensionRunner.emitInput('local interaction', undefined, 'interactive');
  server = await startServer({ agentDir: root, token });
  assert.equal((await fetch(server.baseURL + previewBeforeRestart.url)).status, 404, 'Go restart revokes preview grants');
  assert.equal((await api('/api/push/config')).publicKey, pushPublicKey, 'Go restart preserves Web Push credentials');
  assert.equal(completedEvents(notifiedResult).length, 1, 'Go restart does not manufacture another completion event');
  await expect.poll(async () => (await status()).unread).toBe(false);
  await session.extensionRunner.emit({ type: 'session_shutdown' });
  await expect.poll(async () => (await status()).availability).toBe('disconnected');
  assert.equal((await status()).state, 'unknown');
  await api('/api/session/acknowledge?id=' + encodeURIComponent(id), { replyId: (await status()).replyId });
  await bind();
  await expect.poll(async () => (await status()).unread).toBe(false);
  assert.equal(readdirSync(join(root, 'pi-web', 'owners')).length, 1);
  assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).pid, process.pid);
  assert.equal(existsSync(join(root, 'session-status')), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ runtime: 'real Pi', ownerPidMatches: true, nativeMessages: manager.getBranch().filter((entry) => entry.type === 'message').length,
    provider: 'deterministic test adapter', authenticatedHTTP: true, isolatedInteractivePreview: true, exactNativeDownload: true, returnedBranchImage: true, nativeNotificationOutbox: true, persistentPushCredentials: true, nativeBranchReturn: true, nativeSteerAndFollowUp: true, bidirectionalReceipts: true, goRestart: true, runtimeReload: true }));
  } catch (error) { console.error(error); throw error; }
});
