import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect } from '@playwright/test';
import { startControlledChat } from '../lib/controlled-chat.mjs';
import { startNativePi } from '../lib/native-cli.mjs';
import { startServer, stopServer } from '../lib/server.ts';

const providerDir = resolve(process.argv[2] || '');
if (!existsSync(join(providerDir, 'index.js'))) throw new Error('Pass an installed pi-subagents package directory');

test('actual child-provider restore, terminal failure and completion do not rely on counted hints', { timeout: 180000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-child-provider-'));
  const cwd = join(root, 'cwd'); mkdirSync(cwd); mkdirSync(join(root, 'agents')); mkdirSync(join(root, 'extensions', 'subagent'), { recursive: true });
  const chat = await startControlledChat();
  writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { 'child-http': { baseUrl: chat.baseURL,
    api: 'openai-completions', apiKey: 'isolated-child-key', models: [{ id: 'local', reasoning: false,
      input: ['text'], contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [], extensions: [], defaultProvider: 'lifecycle-test', defaultModel: 'local',
    subagents: { defaultModel: 'child-http/local', defaultProvider: 'child-http', defaultThinking: 'off', disableBuiltins: true } }));
  writeFileSync(join(root, 'extensions', 'subagent', 'config.json'), JSON.stringify({ toolActivation: 'eager', intercomBridge: { mode: 'off' } }));
  writeFileSync(join(root, 'agents', 'lifecycle-child.md'), '---\nname: lifecycle-child\ndescription: Isolated native lifecycle child\nmodel: child-http/local\ntools:\nextensions:\n---\nExecute only the controlled lifecycle fixture.\n');
  const manager = SessionManager.create(cwd, join(root, 'sessions', '--child-owner--'));
  manager.appendMessage({ role: 'user', content: 'Child lifecycle acceptance', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', api: 'lifecycle-test', provider: 'lifecycle-test', model: 'local', stopReason: 'stop',
    content: [{ type: 'text', text: 'Historical result' }], timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const id = basename(manager.getSessionFile());
  const ownerFile = join(root, 'pi-web', 'owners', id + '.json');
  const token = randomBytes(24).toString('hex');
  const runs = [];
  let native, server;
  const snapshots = [];
  const abort = new AbortController();
  let reading;
  const launch = () => startNativePi({ agentDir: root, cwd, sessionPath: manager.getSessionFile(),
    extensions: [join(providerDir, 'index.js'), resolve('e2e/lib/subagent-probe.mjs')] });
  const call = async (method, params) => {
    const requestId = randomUUID();
    await native.command('prompt', { message: '/lifecycle-child ' + JSON.stringify({ requestId, method, params }) });
    const file = join(root, 'subagent-probe', requestId + '.json');
    await expect.poll(() => existsSync(file), { timeout: 25000 }).toBe(true);
    const reply = JSON.parse(readFileSync(file, 'utf8')); assert.equal(reply.success, true, JSON.stringify(reply.error)); return reply.data;
  };
  const api = async (path) => {
    const response = await fetch(server.baseURL + path, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return response.json();
  };
  const status = () => api('/api/status?id=' + encodeURIComponent(id));
  const currentNative = async () => {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${owner.port}/remote`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ sessionId: manager.getSessionId(), action: 'state' }) });
    assert.equal(response.status, 200); return response.json();
  };
  const row = (replyId) => {
    const db = new DatabaseSync(join(root, 'pi-web.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT completed,completion_pending FROM session_results WHERE session_id=? AND result_id=?').get(manager.getSessionId(), replyId); }
    finally { db.close(); }
  };
  const events = () => {
    const db = new DatabaseSync(join(root, 'pi-web.sqlite'), { readOnly: true });
    try { return db.prepare("SELECT value FROM push_events WHERE json_extract(value,'$.kind')='completed'").all().map((row) => JSON.parse(row.value)); }
    finally { db.close(); }
  };
  const spawn = async (task) => {
    const data = await call('spawn', { agent: 'lifecycle-child', task, async: true, context: 'fresh', intercomBridge: { mode: 'off' } });
    assert.ok(data.details.runId); assert.ok(data.details.asyncDir.startsWith(root));
    runs.push({ id: data.details.runId, dir: data.details.asyncDir }); return runs.at(-1);
  };
  const parentResult = async (message) => {
    const before = (await currentNative()).replyId;
    await native.command('prompt', { message });
    await expect.poll(async () => { const snapshot = await currentNative(); return snapshot.state === 'background' && snapshot.replyId !== before ? snapshot.replyId : ''; }).not.toBe('');
    const state = await currentNative(); assert.equal(state.completed, false); assert.equal(row(state.replyId).completion_pending, 1); return state.replyId;
  };
  t.after(async () => {
    abort.abort(); await reading?.catch(() => {});
    chat.release();
    if (native?.child.exitCode === null && native?.child.signalCode === null) {
      for (const run of runs) {
        try { const detail = await call('status', { id: run.id }); if (detail.asyncSnapshot?.runs.some((item) => item.id === run.id && ['running', 'queued'].includes(item.state))) await call('stop', { id: run.id }); } catch {}
      }
    }
    if (server) await stopServer(server.child);
    await native?.close(); await chat.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  native = await launch();
  const capabilities = await call('ping'); assert.equal(capabilities.capabilities.fleetStatus.version, 1);
  server = await startServer({ agentDir: root, token });
  await expect.poll(async () => (await status()).availability).toBe('connected');
  const response = await fetch(server.baseURL + '/events?id=' + encodeURIComponent(id), { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
  reading = (async () => {
    let pending = '';
    for await (const bytes of response.body) {
      pending += Buffer.from(bytes).toString('utf8');
      for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
        if (!data || data === 'reload' || data === 'new-session') continue;
        const value = JSON.parse(data); const snapshot = value.id ? value : value[id];
        if (snapshot) snapshots.push({ instanceId: snapshot.instanceId, state: snapshot.state, availability: snapshot.availability,
          replyId: snapshot.replyId, completed: snapshot.completed, children: snapshot.children });
      }
    }
  })();
  reading.catch(() => {});

  const first = await spawn('hold-until-release successful detached child');
  await expect.poll(() => chat.requests.filter((request) => request.hold).length, { timeout: 20000 }).toBe(1);
  const proof = JSON.parse(readFileSync(join(first.dir, 'status.json'), 'utf8'));
  assert.notEqual(proof.pid, native.pid); process.kill(proof.pid, 0);
  await expect.poll(async () => (await status()).state).toBe('background');
  const pendingResult = await parentResult('Parent finished; detached child remains active');
  const beforeReload = (await currentNative()).instanceId;
  await native.command('prompt', { message: '/lifecycle-reload' });
  await expect.poll(async () => (await currentNative()).instanceId).not.toBe(beforeReload);
  await expect.poll(async () => (await status()).state).toBe('background');
  assert.equal((await currentNative()).completed, false);
  assert.equal(row(pendingResult).completed, 0);
  assert.equal((await call('status')).asyncSnapshot.runs.find((run) => run.id === first.id).state, 'running');
  const restoredProof = JSON.parse(readFileSync(join(first.dir, 'status.json'), 'utf8'));
  process.kill(restoredProof.pid, 0);
  assert.ok(!snapshots.some((snapshot) => snapshot.replyId === pendingResult && snapshot.completed), 'restore must not complete a still-running child round');
  assert.equal(events().length, 0);
  chat.release();
  await expect.poll(async () => (await call('status')).asyncSnapshot.runs.find((run) => run.id === first.id)?.state, { timeout: 20000 }).toBe('complete');
  await expect.poll(async () => (await status()).state).toBe('idle');
  await expect.poll(async () => (await status()).completed).toBe(true);
  const terminal = await call('status', { id: first.id });
  assert.equal(terminal.details.lifecycleStatus.processTerminal.state, 'observed');
  const persisted = SessionManager.open(manager.getSessionFile());
  assert.ok(persisted.getBranch().some((entry) => entry.type === 'custom_message' && entry.customType === 'subagent-notify'));

  chat.hold();
  const failed = await spawn('hold-until-release empty-provider-failure detached child');
  await expect.poll(() => chat.requests.filter((request) => request.hold).length, { timeout: 20000 }).toBe(2);
  const failureResult = await parentResult('Parent finished before child failure was known');
  chat.release();
  await expect.poll(async () => (await call('status')).asyncSnapshot.runs.find((run) => run.id === failed.id)?.state, { timeout: 20000 }).toBe('failed');
  const failedDetail = await call('status', { id: failed.id });
  assert.equal(failedDetail.details.lifecycleStatus.processTerminal.state, 'observed');
  assert.equal(chat.requests.filter((request) => request.fail).length, 1);
  assert.equal(row(failureResult).completed, 0, 'child failure cannot turn the earlier waiting result into successful completion');
  assert.ok(!events().some((event) => event.identity === failureResult));
  assert.equal(new Set(events().map((event) => event.identity)).size, events().length);
  const packageInfo = JSON.parse(readFileSync(join(providerDir, 'package.json'), 'utf8'));
  const report = { provider: { name: packageInfo.name, version: packageInfo.version,
    entrySHA256: createHash('sha256').update(readFileSync(join(providerDir, 'index.js'))).digest('hex') },
    nativeRuntimeReload: true, realChildProcessAliveAfterReload: true, authoritativeReloadAndResume: true,
    successfulChildTerminalProof: true, failedChildTerminalProof: true, noEarlyOrFalseCompletion: true,
    actualCompatibleHTTPRequests: chat.requests.length, snapshots: snapshots.length,
    scope: 'real installed child provider, native CLI/SDK and authenticated Go; controlled localhost model transport, no commercial request' };
  mkdirSync(resolve('.dev'), { recursive: true });
  writeFileSync(resolve('.dev/subagent-lifecycle-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
