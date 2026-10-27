import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect } from '@playwright/test';
import { startNativePi } from '../lib/native-cli.mjs';
import { startServer, stopServer } from '../lib/server.ts';

test('real OS Pi processes recover and concurrently persist exact receipts through authenticated Go', { timeout: 120000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-native-processes-'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [], extensions: [], defaultProvider: 'lifecycle-test', defaultModel: 'local' }));
  const token = randomBytes(24).toString('hex');
  const nodes = [];
  let server;
  t.after(async () => {
    if (server) await stopServer(server.child);
    await Promise.all(nodes.map((node) => node.runtime?.close()));
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  for (let index = 0; index < 3; index++) {
    const cwd = join(root, `cwd-${index}`); mkdirSync(cwd);
    const manager = SessionManager.create(cwd, join(root, 'sessions', `--process-${index}--`));
    manager.appendMessage({ role: 'user', content: `Isolated native process ${index}`, timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', api: 'lifecycle-test', provider: 'lifecycle-test', model: 'local',
      content: [{ type: 'text', text: 'Existing historical result' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const node = { cwd, path: manager.getSessionFile(), sessionId: manager.getSessionId(), id: basename(manager.getSessionFile()), gate: join(root, `gate-${index}`) };
    nodes.push(node);
    node.runtime = await startNativePi({ agentDir: root, cwd, sessionPath: node.path, gate: node.gate });
  }
  assert.equal(new Set(nodes.map((node) => node.runtime.pid)).size, 3);
  assert.ok(nodes.every((node) => node.runtime.pid !== process.pid));
  const ownerFile = (node) => join(root, 'pi-web', 'owners', node.id + '.json');
  const owner = (node) => JSON.parse(readFileSync(ownerFile(node), 'utf8'));
  const nativeCall = async (node, action, fields = {}) => {
    const registration = owner(node);
    assert.equal(registration.pid, node.runtime.pid);
    const response = await fetch(`http://127.0.0.1:${registration.port}/remote`, { method: 'POST',
      headers: { authorization: `Bearer ${registration.token}` }, body: JSON.stringify({ sessionId: node.sessionId, action, ...fields }) });
    assert.equal(response.status, 200); return response.json();
  };
  const api = async (path, options = {}, expectedStatus = 200) => {
    const response = await fetch(server.baseURL + path, { ...options,
      headers: { authorization: `Bearer ${token}`, origin: server.baseURL, ...options.headers } });
    assert.equal(response.status, expectedStatus); return response.json();
  };
  const status = (node) => api('/api/status?id=' + encodeURIComponent(node.id));
  const ack = (node, replyId) => api('/api/session/acknowledge?id=' + encodeURIComponent(node.id), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replyId }) });
  const completedEvents = () => {
    const db = new DatabaseSync(join(root, 'pi-web.sqlite'), { readOnly: true });
    try { return db.prepare("SELECT COUNT(*) AS n FROM push_events WHERE json_extract(value,'$.kind')='completed'").get().n; }
    finally { db.close(); }
  };
  const waitConnected = async (node) => {
    await expect.poll(async () => (await status(node)).availability).toBe('connected');
    assert.equal(owner(node).pid, node.runtime.pid);
  };
  server = await startServer({ agentDir: root, token });
  await Promise.all(nodes.map(waitConnected));
  assert.equal(completedEvents(), 0, 'restoring three histories must not manufacture completion events');
  assert.ok((await Promise.all(nodes.map(status))).every((snapshot) => !snapshot.completed));

  const produce = async (node, label, viaPhone = false) => {
    const previous = (await nativeCall(node, 'state')).replyId;
    if (viaPhone) {
      const form = new FormData(); form.set('message', label);
      await api('/api/chat?id=' + encodeURIComponent(node.id), { method: 'POST', body: form }, 202);
    } else await node.runtime.command('prompt', { message: label });
    await expect.poll(async () => {
      const snapshot = await nativeCall(node, 'state');
      return snapshot.state === 'idle' && snapshot.completed && snapshot.replyId !== previous ? snapshot.replyId : '';
    }).not.toBe('');
    const snapshot = await nativeCall(node, 'state');
    const restored = SessionManager.open(node.path);
    assert.ok(restored.getBranch().some((entry) => entry.type === 'message' && entry.id === snapshot.replyId && JSON.stringify(entry.message.content).includes(label)));
    assert.equal(snapshot.unread, true);
    return snapshot.replyId;
  };
  const first = await Promise.all(nodes.map((node, index) => produce(node, `phone process ${index}`, true)));
  await Promise.all([nativeCall(nodes[0], 'acknowledge', { replyId: first[0] }), ack(nodes[1], first[1]), ack(nodes[2], first[2])]);
  await expect.poll(async () => (await Promise.all(nodes.map(status))).every((snapshot) => snapshot.unread === false)).toBe(true);

  const blocked = nodes[2];
  const confirmation = blocked.runtime.command('prompt', { message: '/lifecycle-confirm' });
  await expect.poll(() => blocked.runtime.events.some((event) => event.type === 'extension_ui_request' && event.method === 'confirm')).toBe(true);
  const dialog = blocked.runtime.events.find((event) => event.type === 'extension_ui_request' && event.method === 'confirm');
  await expect.poll(async () => (await status(blocked)).state).toBe('needs-you');
  const attention = await status(blocked);
  assert.equal(attention.attentionKind, 'confirm'); assert.ok(attention.attentionId);
  assert.equal((await status(blocked)).attentionId, attention.attentionId);
  const dialogInstance = attention.instanceId;
  await blocked.runtime.command('prompt', { message: '/lifecycle-reload' });
  await expect.poll(async () => (await nativeCall(blocked, 'state')).instanceId).not.toBe(dialogInstance);
  await expect.poll(async () => (await status(blocked)).state).toBe('needs-you');
  assert.equal((await status(blocked)).attentionId, attention.attentionId, 'reload preserves the same outstanding native UI identity');
  blocked.runtime.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: dialog.id, confirmed: true }) + '\n');
  await confirmation;
  await expect.poll(async () => (await status(blocked)).state).toBe('idle');

  await stopServer(server.child);
  const offline = await Promise.all(nodes.map((node, index) => produce(node, `Go offline native result ${index}`)));
  await Promise.all(nodes.map((node, index) => nativeCall(node, 'acknowledge', { replyId: offline[index] })));
  const db = new DatabaseSync(join(root, 'pi-web.sqlite'), { readOnly: true });
  for (let index = 0; index < nodes.length; index++) {
    assert.equal(db.prepare('SELECT acknowledged,completed FROM session_results WHERE session_id=? AND result_id=?').get(nodes[index].sessionId, offline[index]).acknowledged, 1);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_results WHERE acknowledged=1').get().n, 6);
  db.close();
  server = await startServer({ agentDir: root, token });
  await Promise.all(nodes.map(waitConnected));
  assert.ok((await Promise.all(nodes.map(status))).every((snapshot) => snapshot.unread === false));

  const crashed = nodes[0];
  const beforeCrashEvents = completedEvents();
  await crashed.runtime.command('prompt', { message: 'hold-until-release actual OS crash' });
  await expect.poll(async () => (await status(crashed)).state).toBe('running');
  const oldPid = crashed.runtime.pid;
  await crashed.runtime.close({ crash: true });
  assert.throws(() => process.kill(oldPid, 0));
  await expect.poll(async () => (await status(crashed)).availability).toBe('disconnected');
  assert.equal((await status(crashed)).state, 'unknown');
  assert.equal(completedEvents(), beforeCrashEvents, 'process death is not successful completion');
  crashed.runtime = await startNativePi({ agentDir: root, cwd: crashed.cwd, sessionPath: crashed.path, gate: crashed.gate });
  assert.notEqual(crashed.runtime.pid, oldPid);
  await waitConnected(crashed);
  assert.equal((await status(crashed)).unread, false);
  assert.equal(completedEvents(), beforeCrashEvents, 'process restoration is not a new completion transition');
  const recovered = await produce(crashed, 'real process recovery', true);
  await ack(crashed, recovered);

  const stopped = nodes[1];
  const passiveResult = await produce(stopped, 'confirm after native exit');
  await stopped.runtime.close();
  assert.equal(existsSync(ownerFile(stopped)), false, 'graceful native exit releases owner registration');
  await expect.poll(async () => (await status(stopped)).availability).toBe('disconnected');
  assert.equal((await status(stopped)).state, 'unknown');
  await ack(stopped, passiveResult);
  assert.equal(existsSync(ownerFile(stopped)), false, 'passive historical confirmation must not start an executor');
  stopped.runtime = await startNativePi({ agentDir: root, cwd: stopped.cwd, sessionPath: stopped.path, gate: stopped.gate });
  await waitConnected(stopped);
  assert.equal((await status(stopped)).unread, false, 'Go-only receipt survives actual native process restart');

  const reloaded = nodes[2];
  const oldInstance = (await nativeCall(reloaded, 'state')).instanceId;
  const beforeReloadEvents = completedEvents();
  await reloaded.runtime.command('prompt', { message: '/lifecycle-reload' });
  await expect.poll(async () => (await nativeCall(reloaded, 'state')).instanceId).not.toBe(oldInstance);
  await waitConnected(reloaded);
  assert.equal((await status(reloaded)).unread, false);
  assert.equal(completedEvents(), beforeReloadEvents);
  assert.equal(readdirSync(join(root, 'pi-web', 'owners')).length, 3);
  assert.equal(existsSync(join(root, 'session-status')), false);
  console.log(JSON.stringify({ native: 'actual Pi CLI in three distinct OS processes', authenticatedGo: true,
    simultaneousNativeAndGoReceipts: true, simultaneousNativeWritersWithGoOffline: true,
    nativeProcessCrashUnknown: true, nativeProcessRestart: true, passiveReceiptWithoutExecutor: true,
    actualExtensionReload: true, genuineNativeRPCUIDialog: true, pendingDialogReloadIdentity: true, stableCompletionIdentities: true, provider: 'deterministic offline adapter; no commercial request' }));
});
