import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect } from '@playwright/test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { startServer, stopServer } from '../lib/server.ts';
import { REPO_ROOT } from '../lib/paths.ts';

for (const mode of ['tui', 'rpc']) test(`web reload replaces real ${mode} resources without replacing the session`, { timeout: 45000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-reload-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session, server;
  t.after(async () => {
    if (server) await stopServer(server.child);
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(join(REPO_ROOT, '.pi/extensions'), join(root, '.pi/extensions'), { recursive: true });
  cpSync(join(REPO_ROOT, 'shared'), join(root, 'shared'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'before-template.md'), 'Before template');
  mkdirSync(join(root, 'skills', 'probe'), { recursive: true });
  const skillFile = join(root, 'skills', 'probe', 'SKILL.md');
  const skill = name => `---\nname: ${name}\ndescription: Reload probe\n---\nProbe instructions.\n`;
  writeFileSync(skillFile, skill('before-skill'));
  const probe = join(root, 'probe.ts');
  const extension = name => `export default pi => { pi.registerCommand('${name}', { description: 'Reload probe', handler: async () => {} }); };`;
  writeFileSync(probe, extension('before-command'));
  const eventBus = createEventBus();
  let children = 0;
  eventBus.on('subagents:rpc:v1:request', request => {
    eventBus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true,
      data: { fleet: { totalActive: children }, asyncSnapshot: { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [] } } });
  });
  let modelCalls = 0;
  const provider = pi => pi.registerProvider('reload-probe', { api: 'reload-probe', apiKey: 'isolated', baseUrl: 'http://127.0.0.1',
    models: [{ id: 'local', name: 'Local', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, options) {
      modelCalls++;
      const stream = createAssistantMessageEventStream();
      options.signal.addEventListener('abort', () => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
          timestamp: Date.now(), stopReason: 'aborted', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'error', reason: 'aborted', error: message });
        stream.end();
      }, { once: true });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const manager = SessionManager.create(root, join(root, 'sessions', 'reload'));
  manager.appendSessionInfo('重载资源验收');
  manager.appendMessage({ role: 'user', content: '保留原生历史', timestamp: Date.now() });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, eventBus, settingsManager,
    additionalExtensionPaths: [join(root, '.pi/extensions/index.ts'), probe], extensionFactories: [provider],
    noExtensions: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models.sqlite'), allowModelNetwork: false, refreshOnCreate: false });
  ({ session } = await createAgentSession({ cwd: root, modelRuntime, resourceLoader: loader, settingsManager,
    sessionManager: manager, noTools: true }));
  const errors = [];
  let reloads = 0;
  await session.bindExtensions({ mode, uiContext: { setTitle() {}, notify: message => errors.push(message) },
    commandContextActions: { reload: async () => { reloads++; await session.reload(); } },
    onError: error => errors.push(error.error) });
  await session.setModel(session.modelRuntime.getModel('reload-probe', 'local'));
  server = await startServer({ agentDir: root, token: 'isolated-reload-token' });
  const id = basename(manager.getSessionFile());
  const endpoint = path => `${server.baseURL}${path}?id=${encodeURIComponent(id)}`;
  const headers = { authorization: 'Bearer isolated-reload-token', origin: server.baseURL, 'content-type': 'application/json' };
  const get = async path => {
    const response = await fetch(endpoint(path), { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = instanceId => fetch(endpoint('/api/session/reload'), { method: 'POST', headers, body: JSON.stringify({ instanceId }) });
  await expect.poll(async () => (await get('/api/status')).canReload).toBe(true);
  const before = await get('/api/status');
  const ownerFile = join(root, 'pi-web/owners', `${id}.json`);
  const originalOwner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  const catalog = async () => (await get('/api/commands')).commands.map(command => command.name);
  assert.ok((await catalog()).includes('before-command'));
  assert.ok((await catalog()).includes('before-template'));
  assert.ok((await catalog()).includes('skill:before-skill'));

  children = 1;
  eventBus.emit('subagent:child-status', {});
  await expect.poll(async () => (await get('/api/status')).canReload).toBe(false);
  assert.equal((await post(before.instanceId)).status, 409);
  assert.equal(reloads, 0);
  children = 0;
  eventBus.emit('subagent:child-status', {});
  await expect.poll(async () => (await get('/api/status')).canReload).toBe(true);
  assert.equal((await fetch(endpoint('/api/session/reload'), { method: 'POST', headers: { origin: server.baseURL, 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: before.instanceId }) })).status, 401);

  const run = session.prompt('running reload probe');
  await expect.poll(async () => (await get('/api/status')).mainRunning).toBe(true);
  assert.equal((await post(before.instanceId)).status, 409, 'running Pi must not be interrupted');
  const form = new FormData();
  form.set('message', 'queued across reload');
  form.set('delivery', 'followUp');
  const queued = await fetch(endpoint('/api/chat'), { method: 'POST', headers: { authorization: headers.authorization, origin: server.baseURL }, body: form });
  assert.equal(queued.status, 202, await queued.clone().text());
  const pendingQueue = (await get('/api/session/queue')).items;
  assert.equal(pendingQueue.length, 1);
  await session.abort();
  await run;
  await expect.poll(async () => (await get('/api/status')).canReload).toBe(true);
  const originalFile = readFileSync(manager.getSessionFile(), 'utf8');

  writeFileSync(probe, extension('after-command'));
  renameSync(join(root, 'prompts/before-template.md'), join(root, 'prompts/after-template.md'));
  writeFileSync(skillFile, skill('after-skill'));
  const response = await post(before.instanceId);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, 'reloaded');
  assert.equal(reloads, 1);
  await expect.poll(async () => (await get('/api/status')).instanceId).not.toBe(before.instanceId);
  await expect.poll(async () => (await get('/api/status')).canReload).toBe(true);
  const commands = await catalog();
  for (const name of ['after-command', 'after-template', 'skill:after-skill']) assert.ok(commands.includes(name), name);
  for (const name of ['before-command', 'before-template', 'skill:before-skill']) assert.ok(!commands.includes(name), name);
  assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).pid, originalOwner.pid);
  assert.equal(session.sessionManager.getSessionId(), manager.getSessionId());
  assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), originalFile, 'reload must not append a prompt or rewrite history');
  assert.equal((await post(before.instanceId)).status, 409, 'a stale second submission must not reload the new runtime');
  assert.equal(reloads, 1);
  const latest = await get('/api/status');
  assert.equal((await post(latest.instanceId)).status, 200, 'a fresh user request must work after the runtime replacement');
  assert.equal(reloads, 2);
  assert.equal(readFileSync(manager.getSessionFile(), 'utf8'), originalFile);
  assert.equal(modelCalls, 1, 'only the explicit test run may call the isolated provider');
  assert.deepEqual((await get('/api/session/queue')).items, pendingQueue, 'reload preserves exact queue contents and identities');
  assert.deepEqual(errors, []);
});
