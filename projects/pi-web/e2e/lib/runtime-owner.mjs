import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Protocol fixture, not runtime evidence: real native loading has its own integration gate.
export async function openFixtureOwner({ agentDir, sessionPath, getState = () => ({ state: 'idle' }), control = () => ({ status: 'accepted' }) }) {
  const native = () => readFileSync(sessionPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const sessionId = native()[0].id;
  const id = basename(sessionPath);
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  let revision = 1;
  const listeners = new Set();
  let closed = false;
  const db = new DatabaseSync(join(agentDir, 'pi-web.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS session_results (
    session_id TEXT NOT NULL,result_id TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,result_id))`);
  const snapshot = () => {
    const entries = native();
    const state = getState();
    let leafId = Object.hasOwn(state, 'leafId') ? state.leafId : entries.filter((entry) => entry.type !== 'session').at(-1)?.id;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    let replyId = '', cacheHit = null, outcome = null;
    for (let leaf = leafId, count = 0; leaf && count++ < entries.length;) {
      const entry = byId.get(leaf);
      if (!entry) break;
      if (entry.message?.role === 'assistant' && ['stop', 'length', 'aborted', 'error'].includes(entry.message.stopReason)) {
        replyId = entry.id; outcome = entry.message.stopReason;
        const usage = entry.message.usage;
        if (usage) cacheHit = 100 * usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite);
        break;
      }
      leaf = entry.parentId;
    }
    const read = db.prepare('SELECT acknowledged FROM session_results WHERE session_id=? AND result_id=?').get(sessionId, replyId);
    return { id, sessionId, instanceId, revision, state: state.state, mainRunning: state.state === 'running',
      children: state.state === 'background' ? 1 : 0, availability: 'connected', canControl: true, canQueue: true,
      chatAvailable: true, cwd: entries[0].cwd,
      replyId, leafId, unread: Boolean(replyId && !read?.acknowledged),
      completed: state.state === 'idle' && ['stop', 'length'].includes(outcome), outcome,
      name: entries.findLast((entry) => entry.type === 'session_info')?.name,
      model: 'test-model', provider: 'test', thinking: 'medium', context: null, fast: null, cacheHit, ...state };
  };
  const publish = () => {
    const current = snapshot();
    if (current.completed && current.replyId) db.prepare(`INSERT INTO session_results(session_id,result_id,completed) VALUES(?,?,1)
      ON CONFLICT(session_id,result_id) DO UPDATE SET completed=1`).run(sessionId,current.replyId);
    revision++; for (const listener of listeners) listener();
  };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) { response.writeHead(401).end(); return; }
    if (request.method === 'GET' && request.url === `/snapshot?sessionId=${encodeURIComponent(sessionId)}`) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = () => { response.write(`data: ${JSON.stringify(snapshot())}\n\n`); };
      listeners.add(send); send();
      const timer = setInterval(() => response.write(':keepalive\n\n'), 15000);
      response.on('close', () => { listeners.delete(send); clearInterval(timer); });
      return;
    }
    let input;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.sessionId !== sessionId) throw new Error('session mismatch');
      let result;
      if (input.action === 'state') result = snapshot();
      else if (input.action === 'acknowledge') {
        db.prepare(`INSERT INTO session_results(session_id,result_id,acknowledged) VALUES(?,?,1)
          ON CONFLICT(session_id,result_id) DO UPDATE SET acknowledged=1`).run(sessionId, input.replyId);
        publish(); result = snapshot();
      } else if (input.action === 'rename-title') {
        if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('empty name');
        const entry = {type:'session_info',id:randomUUID(),parentId:native().filter((entry) => entry.type !== 'session').at(-1)?.id || null,timestamp:new Date().toISOString(),name:input.name.trim()};
        appendFileSync(sessionPath,JSON.stringify(entry)+'\n');
        publish(); result = {name:entry.name};
      } else { result = await control(input); publish(); }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const directory = join(agentDir, 'pi-web', 'owners');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, id + '.json');
  writeFileSync(file, JSON.stringify({ pid: process.pid, port: server.address().port, token, sessionId, hostId: process.env.PI_WEB_WORKER_HOST_ID }));
  return { publish, snapshot, async close() {
    if (closed) return;
    closed = true;
    try { unlinkSync(file); } catch {}
    const closing = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closing;
    db.close();
  } };
}
