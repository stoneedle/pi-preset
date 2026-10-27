import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { REPO_ROOT } from '../lib/paths.ts';

test('native command catalog, prompt expansion, max thinking and compaction use the same Pi runtime', { timeout: 45000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-native-tools-'));
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
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'probe-review.md'), '---\ndescription: Native review template\n---\n原生模板：关注 ${1:-正确性}，补充 $@\n');
  mkdirSync(join(root, '.pi', 'prompts'), { recursive: true });
  writeFileSync(join(root, '.pi', 'prompts', 'project-review.md'), '项目模板 $1\n');
  new ProjectTrustStore(root).set(root, true);
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [REPO_ROOT], compaction: { enabled: false, keepRecentTokens: 1 } }));
  const settings = SettingsManager.create(root, root, { projectTrusted: true });
  const manager = SessionManager.create(root, join(root, 'sessions', 'native'));
  manager.appendSessionInfo('原生功能验证');
  manager.appendMessage({ role: 'user', content: '历史内容：'.repeat(600), timestamp: Date.now() });
  const inputs = [];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noContextFiles: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.registerCommand('probe-command', { description: 'Native extension command', handler: () => {} });
      pi.registerProvider('native-tools-test', { apiKey: 'isolated-key', api: 'native-tools-test', baseUrl: 'http://127.0.0.1',
        models: [{ id: 'probe', name: 'Probe', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
        streamSimple(model, context) {
          inputs.push(JSON.stringify(context));
          const stream = createAssistantMessageEventStream();
          setTimeout(() => {
            const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
              content: [{ type: 'text', text: '## 原生摘要\n保留移动端会话方案。' }], timestamp: Date.now(), stopReason: 'stop',
              usage: { input: 120, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 140,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end();
          }, 300);
          return stream;
        },
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.sqlite'), allowModelNetwork: false, refreshOnCreate: false });
  ({ session } = await createAgentSession({ cwd: root, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: true }));
  await session.bindExtensions({ mode: 'rpc', uiContext: { notify() {} } });
  await session.setModel(session.modelRuntime.getModel('native-tools-test', 'probe'));
  server = await startServer({ agentDir: root, nativeWorkers: true });
  const id = basename(manager.getSessionFile());
  const endpoint = (path) => server.baseURL + path + '?id=' + encodeURIComponent(id);
  const get = async (path) => {
    const response = await fetch(endpoint(path));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const post = (path, body) => fetch(endpoint(path), { method: 'POST', headers: { origin: server.baseURL, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const catalog = await get('/api/commands');
  for (const [name, source] of [['probe-review', 'prompt'], ['project-review', 'prompt'], ['probe-command', 'extension']]) {
    assert.ok(catalog.commands.some((command) => command.name === name && command.source === source), name);
  }
  const details = await get('/api/session/details');
  assert.equal(details.sessionId, manager.getSessionId());
  assert.equal(details.sessionFile, manager.getSessionFile());
  assert.equal((await post('/api/set-thinking-level', { level: 'max' })).status, 200);
  assert.equal(session.thinkingLevel, 'max');
  const form = new FormData();
  form.set('message', '/probe-review "API compatibility"');
  const sent = await fetch(endpoint('/api/chat'), { method: 'POST', headers: { origin: server.baseURL }, body: form });
  assert.equal(sent.status, 202, await sent.text());
  await expect.poll(() => session.isIdle).toBe(true);
  assert.ok(inputs[0].includes('原生模板：关注 API compatibility，补充 API compatibility'));
  const before = readFileSync(manager.getSessionFile(), 'utf8');
  await expect.poll(async () => (await get('/api/status')).canCompact).toBe(true);
  assert.equal((await post('/api/session/compact', { customInstructions: '保留方案' })).status, 200);
  const duplicate = await post('/api/session/compact', { customInstructions: '重复请求' });
  assert.equal(duplicate.status, 409);
  await expect.poll(() => manager.getBranch().filter((entry) => entry.type === 'compaction').length).toBe(1);
  const nativeSummary = manager.getBranch().find((entry) => entry.type === 'compaction');
  assert.ok(nativeSummary.summary.includes('保留移动端会话方案。'));
  assert.equal((await get('/api/session/details')).compaction.summary, nativeSummary.summary);
  await expect.poll(async () => (await get('/api/status')).canCompact).toBe(true);
  assert.ok(readFileSync(manager.getSessionFile(), 'utf8').startsWith(before), 'compaction only appends; original history remains');
  assert.equal(session.sessionManager.getSessionId(), details.sessionId);
});
