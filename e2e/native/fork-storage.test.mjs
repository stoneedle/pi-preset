import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { startServer, stopServer } from '../lib/server.ts';

test('fork preserves native images, tools, compaction, labels and branch settings without an executor', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-fork-storage-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  let server;
  t.after(async () => {
    if (server) await stopServer(server.child);
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const directory = join(root, 'sessions', '--fork--');
  const source = SessionManager.create(cwd, directory);
  source.appendModelChange('lifecycle-test', 'selected');
  source.appendThinkingLevelChange('high');
  source.appendCustomEntry('test-speed', { mode: 'fast' });
  const user = source.appendMessage({ role: 'user', content: [
    { type: 'text', text: '原始图文提问' }, { type: 'image', mimeType: 'image/png', data: 'native-image-bytes' },
  ], timestamp: Date.now() });
  const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', api: 'test', provider: 'lifecycle-test', model: 'selected', stopReason, content, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  source.appendMessage(assistant([{ type: 'thinking', thinking: '保留原生思考' }, { type: 'toolCall', id: 'read-file', name: 'read', arguments: { path: 'a.txt' } }], 'toolUse'));
  source.appendMessage({ role: 'toolResult', toolCallId: 'read-file', toolName: 'read', content: [{ type: 'text', text: '完整工具结果' }], isError: false, timestamp: Date.now() });
  const result = source.appendMessage(assistant([{ type: 'text', text: '工具后的完整回复' }]));
  source.appendLabelChange(result, '保留书签');
  const compaction = source.appendCompaction('原生压缩摘要', user, 1000);
  source.appendCustomEntry('test-speed', { mode: 'standard' });
  const final = source.appendMessage(assistant([{ type: 'text', text: '压缩后继续' }]));
  source.appendSessionInfo('原始会话');
  const active = source.getLeafId();
  source.branch(result);
  const abandoned = source.appendMessage(assistant([{ type: 'text', text: '不应继承的其他支线' }]));
  source.branch(active);
  // Persist a descendant so the dormant file and manager agree on the active branch.
  source.appendSessionInfo('原始会话');
  const id = basename(source.getSessionFile());
  const original = readFileSync(source.getSessionFile(), 'utf8');
  server = await startServer({ agentDir: root });
  const fork = async (entryId = '') => {
    const response = await fetch(server.baseURL + '/api/session/fork?id=' + encodeURIComponent(id), {
      method: 'POST', headers: { origin: server.baseURL, 'content-type': 'application/json' }, body: JSON.stringify({ entryId }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(existsSync(join(root, 'pi-web', 'owners', body.id + '.json')), false);
    return SessionManager.open(join(directory, body.id));
  };
  const cloned = await fork();
  assert.equal(cloned.getHeader().parentSession, source.getSessionFile());
  assert.equal(cloned.getEntry(abandoned), undefined);
  assert.deepEqual(cloned.getEntry(user), source.getEntry(user));
  assert.deepEqual(cloned.getEntry(final), source.getEntry(final));
  assert.deepEqual(cloned.getEntry(compaction).summary, source.getEntry(compaction).summary);
  assert.equal(cloned.getLabel(result), '保留书签');
  assert.deepEqual(cloned.buildSessionContext(), source.buildSessionContext());
  const beforeCompaction = await fork(result);
  source.branch(result);
  assert.deepEqual(beforeCompaction.buildSessionContext(), source.buildSessionContext());
  assert.equal(beforeCompaction.getEntry(compaction), undefined);
  assert.equal(beforeCompaction.getEntry(final), undefined);
  assert.equal(beforeCompaction.getEntry(abandoned), undefined);
  assert.equal(readFileSync(source.getSessionFile(), 'utf8'), original);
  assert.equal(readdirSync(directory).some((name) => name.startsWith('.pi-web-fork-')), false);
});
