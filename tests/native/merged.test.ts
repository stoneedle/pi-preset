import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { DatabaseSync } from 'node:sqlite';

test('one real merged extension owns native controls, snapshots, branch results and durable confirmations without Go', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-native-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: '修复字幕导入', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Historical result' }], api: 'test', model: 'test', provider: 'test', stopReason: 'stop', timestamp: Date.now() } as any);
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const eventBus = createEventBus();
  let children = 0;
  let failQuery = false;
  let omitChild = false;
  eventBus.on('subagents:rpc:v1:request', (request: any) => {
    eventBus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      success: !failQuery, data: { fleet: { totalActive: children }, asyncSnapshot: { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: omitChild ? [] : [{ id: 'controlled-child', state: children ? 'running' : 'complete' }] } },
    });
  });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, eventBus,
    additionalExtensionPaths: [fileURLToPath(new URL('../../.pi/extensions/index.ts', import.meta.url))],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models.sqlite'), allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: root, modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager: manager });
  const errors: string[] = [];
  const titles: string[] = [];
  t.after(async () => {
    await session.extensionRunner!.emit({ type: 'session_shutdown' });
    session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: 'rpc', uiContext: { notify: (message: string) => errors.push(message) } as any,
    onError: (error: any) => errors.push(String(error.error)) });
  assert.equal(manager.getSessionName(), '修复字幕导入');
  const ownerFile = join(root, 'pi-web', 'owners', basename(manager.getSessionFile()!) + '.json');
  let owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  const call = async (action: string, input = {}, registration = owner) => {
    const response = await fetch(`http://127.0.0.1:${registration.port}/remote`, { method: 'POST',
      headers: { authorization: `Bearer ${registration.token}` },
      body: JSON.stringify({ sessionId: manager.getSessionId(), action, ...input }) });
    return { status: response.status, data: await response.json() as any };
  };
  const snapshot = async () => (await call('state')).data;
  assert.equal((await snapshot()).state, 'idle');
  assert.equal((await snapshot()).completed, false, 'restoring history is not a completion transition');
  const restoredDB = new DatabaseSync(join(root, 'pi-web.sqlite'));
  assert.equal(restoredDB.prepare('SELECT COUNT(*) AS n FROM session_results WHERE completed=1').get()!.n, 0);
  restoredDB.close();
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${owner.port}/snapshot?sessionId=${encodeURIComponent(owner.sessionId)}`, {
    headers: { authorization: `Bearer ${owner.token}` }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"state":"idle"/);
  abort.abort();
  await session.extensionRunner!.emit({ type: 'agent_start' });
  await session.extensionRunner!.emit({ type: 'agent_end', messages: [] } as any);
  assert.equal((await snapshot()).state, 'running', 'low-level end is not final');
  await session.extensionRunner!.emit({ type: 'ui_prompt_start', kind: 'confirm', title: 'Confirm' } as any);
  const attention = await snapshot();
  assert.equal(attention.state, 'needs-you');
  assert.equal(attention.mainRunning, true);
  assert.equal((await snapshot()).attentionId, attention.attentionId);
  await session.extensionRunner!.emit({ type: 'ui_prompt_end', kind: 'confirm' } as any);
  const firstReply = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'First result' }],
    api: 'test', model: 'test', provider: 'test', stopReason: 'stop', timestamp: Date.now() } as any);
  children = 1;
  await session.extensionRunner!.emit({ type: 'agent_settled', aborted: false });
  assert.equal((await snapshot()).state, 'background');
  assert.equal((await snapshot()).completed, false);
  await session.bindExtensions({ mode: 'rpc', uiContext: { notify: (message: string) => errors.push(message) } as any });
  owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  assert.equal((await snapshot()).state, 'background');
  assert.equal((await snapshot()).completed, false);
  failQuery = true;
  eventBus.emit('subagent:async-complete', {});
  await new Promise(setImmediate);
  assert.equal((await snapshot()).state, 'unknown');
  assert.equal((await snapshot()).completed, false);
  failQuery = false;
  children = 0;
  omitChild = true;
  eventBus.emit('subagent:async-complete', {});
  await new Promise(setImmediate);
  assert.equal((await snapshot()).state, 'unknown', 'missing related terminal proof is not a successful zero');
  assert.equal((await snapshot()).completed, false);
  omitChild = false;
  eventBus.emit('subagent:async-complete', {});
  await new Promise(setImmediate);
  assert.equal((await snapshot()).state, 'idle');
  assert.equal((await snapshot()).replyId, firstReply);
  assert.equal((await snapshot()).completed, true);
  assert.equal((await snapshot()).unread, true);
  assert.equal((await call('acknowledge', { replyId: firstReply })).status, 200);
  assert.equal((await snapshot()).unread, false);
  assert.equal((await snapshot()).completed, true, 'acknowledgement preserves completion');
  for (const outcome of ['error', 'aborted']) {
    await session.extensionRunner!.emit({ type: 'agent_start' });
    manager.appendMessage({ role: 'assistant', content: [], api: 'test', model: 'test', provider: 'test', stopReason: outcome, timestamp: Date.now() } as any);
    await session.extensionRunner!.emit({ type: 'agent_settled', aborted: outcome === 'aborted' });
    assert.equal((await snapshot()).replyId, '', `${outcome} without content is not a readable result`);
    assert.equal((await snapshot()).unread, false);
    assert.equal((await snapshot()).completed, false);
  }
  manager.branch(firstReply);
  await session.extensionRunner!.emit({ type: 'session_tree', newLeafId: firstReply } as any);
  assert.equal((await snapshot()).outcome, 'stop', 'a later abort must not overwrite an earlier branch result outcome');
  assert.equal((await snapshot()).completed, true, 'branch navigation preserves the original completion receipt');
  manager.appendMessage({ role: 'user', content: 'Next', timestamp: Date.now() });
  await session.extensionRunner!.emit({ type: 'agent_start' });
  const secondReply = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Second result' }],
    api: 'test', model: 'test', provider: 'test', stopReason: 'stop', timestamp: Date.now() } as any);
  await session.extensionRunner!.emit({ type: 'agent_settled', aborted: false });
  assert.equal((await call('acknowledge', { replyId: firstReply })).status, 400);
  assert.equal((await snapshot()).unread, true, 'old acknowledgement cannot clear new result');
  manager.branch(firstReply);
  await session.extensionRunner!.emit({ type: 'session_tree', newLeafId: firstReply } as any);
  assert.equal((await snapshot()).replyId, firstReply);
  assert.equal((await snapshot()).unread, false);
  manager.branch(secondReply);
  await session.extensionRunner!.emit({ type: 'session_tree', newLeafId: secondReply } as any);
  assert.equal((await snapshot()).replyId, secondReply);
  assert.equal((await snapshot()).unread, true);
  await session.extensionRunner!.emitInput('continue', undefined, 'interactive');
  assert.equal((await snapshot()).unread, false);
  const db = new DatabaseSync(join(root, 'pi-web.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_results WHERE acknowledged=1').get()!.n, 2);
  db.close();
  await session.bindExtensions({ mode: 'tui', uiContext: { setTitle: (value: string) => titles.push(value),
    notify: (value: string) => errors.push(value) } as any,
    onError: (error: any) => errors.push(String(error.error)) });
  owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  assert.equal((await snapshot()).unread, false);
  assert.match(titles.at(-1)!, /✓ · 修复字幕导入/);
  session.setSessionName('人工名称');
  await session.extensionRunner!.emitInput('不同任务', undefined, 'interactive');
  assert.match(titles.at(-1)!, /人工名称/);
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), '人工名称');
  assert.equal(readdirSync(join(root, 'pi-web', 'owners')).length, 1);
  assert.equal(existsSync(join(root, 'session-status')), false);
  assert.deepEqual(errors, []);

  const configDir = join(root, 'extension-data', 'pi-title-glyphs');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), '{invalid json');
  await session.reload();
  owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  assert.equal((await snapshot()).state, 'idle', 'optional naming config cannot disable runtime state');
  await session.extensionRunner!.emit({ type: 'agent_start' });
  assert.equal((await snapshot()).state, 'running');
  await session.extensionRunner!.emit({ type: 'agent_settled', aborted: true });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /自动命名配置不可用/);
  errors.length = 0;
  unlinkSync(join(configDir, 'config.json'));

  const peerLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    eventBus: createEventBus(), additionalExtensionPaths: [fileURLToPath(new URL('../../.pi/extensions/index.ts', import.meta.url))],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await peerLoader.reload();
  const { session: peerSession } = await createAgentSession({ cwd: root, modelRuntime, resourceLoader: peerLoader,
    settingsManager, sessionManager: SessionManager.open(manager.getSessionFile()!) });
  try {
    await peerSession.bindExtensions({ mode: 'rpc', uiContext: { notify: (message: string) => errors.push(message) } as any,
      onError: (error: any) => errors.push(String(error.error)) });
    const originalToken = owner.token;
    assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).token, originalToken, 'a peer cannot replace a live owner');
    await peerSession.extensionRunner!.emit({ type: 'agent_start' });
    await session.extensionRunner!.emit({ type: 'session_shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(existsSync(ownerFile), false, 'an old peer must not promote its stale execution context');
    assert.deepEqual(errors, []);
  } finally {
    await peerSession.extensionRunner!.emit({ type: 'session_shutdown' });
    peerSession.dispose();
  }
  assert.equal(existsSync(ownerFile), false, 'peer shutdown does not claim a missing owner');
});
