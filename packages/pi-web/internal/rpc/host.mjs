// This process owns native RPC pipes. Web clients may disconnect without closing Pi.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(process.argv[1]);
const token = randomBytes(32).toString('hex');
const hostId = randomUUID();
const clients = new Set();
const pending = new Map();
const ownerPath = join(config.agentDir, 'pi-web', 'owners', basename(config.sessionPath) + '.json');
let child, nativeOwner, idleTimer, heartbeat, killTimer, startupTimer;
let observer, stopping = false, registered = false, mutations = 0, stderr = '';
let latest = null;

function invalidateIdle() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
}
function observe(snapshot) {
  latest = snapshot;
  if (snapshot.state !== 'idle' || snapshot.mainRunning !== false || snapshot.children !== 0 || mutations) {
    invalidateIdle();
  } else if (!idleTimer && !stopping) {
    idleTimer = setTimeout(retire, config.idleTTL);
  }
}
async function retire() {
  idleTimer = undefined;
  if (stopping || mutations || !nativeOwner) return;
  try {
    // The native owner atomically rejects retirement if new work has arrived.
    const response = await fetch(`http://127.0.0.1:${nativeOwner.port}/remote`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${nativeOwner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retire', sessionId: config.sessionId }),
    });
    if (response.ok && (await response.json()).status === 'retiring') { stop(); return; }
  } catch {}
  if (latest) observe(latest);
}
function stop() {
  if (stopping) return;
  stopping = true;
  invalidateIdle();
  observer?.abort();
  child?.stdin.end();
  if (child && child.exitCode === null) killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  else finish();
}
function finish() {
  stopping = true;
  invalidateIdle();
  clearTimeout(heartbeat); clearTimeout(killTimer); clearTimeout(startupTimer);
  observer?.abort();
  for (const client of clients) client.destroy();
  server.close(() => process.exit(0));
  if (registered) {
    try { if (JSON.parse(readFileSync(config.registry, 'utf8')).token === token) unlinkSync(config.registry); } catch {}
  }
}

const server = createServer((socket) => {
  let authenticated = false, buffer = '';
  const authDeadline = setTimeout(() => socket.destroy(), 5000);
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(authDeadline);
    clients.delete(socket);
    for (const [id, request] of pending) {
      if (request.socket !== socket) continue;
      // Keep tracking accepted mutations until their response, but never replay them.
      request.socket = null;
      if (!request.mutation) pending.delete(id);
    }
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 34 * 1024 * 1024) { socket.destroy(); return; }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let input;
      try { input = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!authenticated) {
        const supplied = Buffer.from(String(input.token || ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || stopping) {
          socket.destroy(); return;
        }
        authenticated = true; clearTimeout(authDeadline);
        socket.write('{"ready":true}\n'); clients.add(socket);
        continue;
      }
      if (stopping || !child || typeof input.id !== 'string' || typeof input.type !== 'string') {
        socket.destroy(); return;
      }
      const mutation = !['get_state', 'get_commands', 'get_available_models', 'get_messages', 'get_session_stats'].includes(input.type);
      if (mutation) { mutations++; invalidateIdle(); }
      const id = randomUUID();
      pending.set(id, { socket, id: input.id, mutation });
      if (!child.stdin.write(JSON.stringify({ ...input, id }) + '\n')) socket.pause();
    }
  });
});
server.on('error', (error) => { console.error(error.message); stop(); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const temporary = config.registry + '.' + randomUUID() + '.tmp';
try {
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, port: server.address().port, token, hostId, sessionId: config.sessionId }), { mode: 0o600 });
  try { linkSync(temporary, config.registry); registered = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
} finally { try { unlinkSync(temporary); } catch {} }
if (!registered) { server.close(); }
else {
  child = spawn(config.command, config.args, {
    cwd: config.cwd, env: { ...process.env, PI_WEB_MANAGED_WORKER: '1', PI_WEB_WORKER_HOST_ID: hostId },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdin.on('error', () => stop());
  child.stdin.on('drain', () => { for (const client of clients) client.resume(); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  child.on('error', (error) => { console.error(error.message); finish(); });
  child.on('exit', (code) => { if (code && stderr) console.error(stderr); finish(); });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.length > 12 * 1024 * 1024) { stop(); return; }
    for (let end; (end = output.indexOf('\n')) >= 0;) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'response') {
        const request = pending.get(event.id);
        if (!request) continue;
        clearTimeout(startupTimer);
        pending.delete(event.id);
        if (request.mutation) { mutations--; if (latest) observe(latest); }
        if (request.socket && !request.socket.destroyed) {
          request.socket.write(JSON.stringify({ ...event, id: request.id }) + '\n');
        }
      } else {
        if (event.type === 'agent_start') { latest = null; invalidateIdle(); }
        for (const client of clients) {
          if (client.writableLength > 1024 * 1024) client.destroy();
          else client.write(line + '\n');
        }
      }
    }
  });
  startupTimer = setTimeout(() => { console.error('Native Pi startup timed out'); stop(); }, 35000);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  void (async () => {
    while (!stopping) {
      observer = new AbortController();
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
        if (owner.sessionId !== config.sessionId || !Number.isInteger(owner.port) || !owner.token) throw new Error('owner unavailable');
        if (owner.hostId !== hostId) { stop(); break; }
        nativeOwner = owner;
        heartbeat = setTimeout(() => observer.abort(), 45000);
        const response = await fetch(`http://127.0.0.1:${owner.port}/snapshot?sessionId=${encodeURIComponent(config.sessionId)}`, {
          headers: { authorization: `Bearer ${owner.token}` }, redirect: 'error', signal: observer.signal,
        });
        if (!response.ok) throw new Error('native subscription unavailable');
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          clearTimeout(heartbeat);
          heartbeat = setTimeout(() => observer.abort(), 45000);
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 128 * 1024) throw new Error('native snapshot too large');
          for (let end; (end = buffer.indexOf('\n')) >= 0;) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.startsWith('data: ')) continue;
            const snapshot = JSON.parse(line.slice(6));
            if (snapshot.sessionId !== config.sessionId || !snapshot.instanceId) throw new Error('native identity changed');
            observe(snapshot);
          }
        }
      } catch {} finally {
        observer.abort(); clearTimeout(heartbeat); invalidateIdle(); latest = null; nativeOwner = null;
      }
      if (!stopping) await delay(500);
    }
  })();
}
