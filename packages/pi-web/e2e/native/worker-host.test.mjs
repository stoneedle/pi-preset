import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSession, writeSession } from '../lib/sessions.ts';
import { REPO_ROOT } from '../lib/paths.ts';

const hostSource = readFileSync(join(REPO_ROOT, 'internal/rpc/host.mjs'), 'utf8');
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-host-test-'));
  const sessionsDir = join(root, 'sessions'); mkdirSync(sessionsDir);
  const { entries } = buildSession({ cwd: root });
  const id = writeSession(sessionsDir, 'host.jsonl', entries);
  const sessionPath = join(sessionsDir, '--home-user-demo-project--', id);
  const registry = join(root, 'host.json');
  const source = `
    import { openFixtureOwner } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'e2e/lib/runtime-owner.mjs')).href)};
    import { createInterface } from 'node:readline';
    let value = { state: 'running' }, owner;
    const open = async () => owner = await openFixtureOwner({ agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionPath: ${JSON.stringify(sessionPath)}, getState: () => value,
      control: (input) => {
        const snapshot = owner.snapshot();
        if (input.action !== 'retire' || snapshot.state !== 'idle' || snapshot.mainRunning || snapshot.children !== 0) throw Error('not idle');
        return { status: 'retiring' };
      }
    });
    await open();
    const input = createInterface({ input: process.stdin });
    input.on('line', async line => {
      const command = JSON.parse(line);
      const reply = () => process.stdout.write(JSON.stringify({ id: command.id, type: 'response', success: true, data: {} }) + '\\n');
      if (command.type === 'fixture_state') { value = command.value; owner?.publish(); }
      else if (command.type === 'fixture_disconnect') { await owner.close(); owner = null; }
      else if (command.type === 'fixture_reconnect') await open();
      else if (command.type === 'fixture_defer') { owner.publish(); setTimeout(reply, 1600); return; }
      else if (command.type === 'get_commands') owner?.publish();
      reply();
    });
    input.on('close', async () => { await owner?.close(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', hostSource, JSON.stringify({
    command: process.execPath, args: ['--input-type=module', '-e', source], cwd: root,
    registry, sessionPath, sessionId: entries[0].id, agentDir: root, idleTTL: 1000,
  })], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => diagnostic += chunk);
  const closed = new Promise(resolve => child.once('close', resolve));
  let socket;
  t.after(async () => {
    socket?.destroy();
    if (child.exitCode === null) child.kill();
    await Promise.race([closed, delay(8000).then(() => { throw Error('host cleanup timed out: ' + diagnostic); })]);
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });
  for (let i = 0; !existsSync(registry) && i < 100; i++) await delay(50);
  assert.ok(existsSync(registry), diagnostic);
  const registration = JSON.parse(readFileSync(registry, 'utf8'));
  socket = createConnection({ host: '127.0.0.1', port: registration.port });
  socket.on('error', () => {});
  const pending = new Map();
  let seq = 0;
  const lines = createInterface({ input: socket });
  const ready = new Promise(resolve => lines.once('line', resolve));
  lines.on('line', line => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  socket.write(JSON.stringify({ token: registration.token }) + '\n');
  await ready;
  const command = (type, fields = {}) => new Promise((resolve, reject) => {
    const id = String(++seq);
    const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timed out: ' + type)); }, 3000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    socket.write(JSON.stringify({ id, type, ...fields }) + '\n');
  });
  await command('get_state');
  await delay(700); // The real native subscription is connected before idle-clock assertions.
  return { command, child, closed, registry, diagnostic: () => diagnostic };
}

test('independent host counts continuous native idle, not repeated passive reads', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.child.exitCode, null, 'long running work is not idle');
  await f.command('fixture_state', { value: { state: 'idle' } });
  const start = Date.now();
  while (f.child.exitCode === null && Date.now() - start < 2300) {
    await f.command('get_commands').catch(() => {});
    await delay(80);
  }
  assert.notEqual(f.child.exitCode, null, 'passive reads must not keep extending the idle interval');
  assert.equal(existsSync(f.registry), false, 'retired host removes only its own registration');
});

test('unknown children, running work and disconnected native transport invalidate idle eligibility', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const value of [{ state: 'unknown' }, { state: 'background', children: 1 }, { state: 'idle', children: null }, { state: 'idle', mainRunning: true }]) {
    await f.command('fixture_state', { value });
    await delay(1100);
    assert.equal(f.child.exitCode, null, JSON.stringify(value));
  }
  await f.command('fixture_state', { value: { state: 'idle' } });
  await delay(700);
  await f.command('fixture_disconnect');
  await delay(1100);
  assert.equal(f.child.exitCode, null, 'disconnection must cancel the old idle deadline');
  await f.command('fixture_reconnect');
  await delay(500);
  assert.equal(f.child.exitCode, null, 'reconnection starts a fresh idle interval');
  await Promise.race([f.closed, delay(2500).then(() => { throw Error('eligible host was not collected: ' + f.diagnostic()); })]);
});

test('a pending mutating RPC protects the native worker until delivery completes', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.command('fixture_state', { value: { state: 'idle' } });
  const pending = f.command('fixture_defer');
  await delay(1200);
  assert.equal(f.child.exitCode, null, 'pending delivery is not continuous idle');
  await pending;
  await delay(500);
  assert.equal(f.child.exitCode, null, 'idle clock starts after delivery, not before it');
  await Promise.race([f.closed, delay(1800).then(() => { throw Error('host did not retire after delivery'); })]);
});
