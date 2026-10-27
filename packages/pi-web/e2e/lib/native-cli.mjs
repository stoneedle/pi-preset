import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { REPO_ROOT } from './paths.ts';

export async function startNativePi({ agentDir, cwd, sessionPath, gate, extensions = [] }) {
  const cli = join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-mcp', '--no-extensions',
    '--no-builtin-tools', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--provider', 'lifecycle-test', '--model', 'local', '--session', sessionPath,
    '-e', join(REPO_ROOT, 'e2e', 'lib', 'native-provider.mjs'),
    '-e', join(REPO_ROOT, '.pi', 'extensions', 'index.ts'), ...extensions.flatMap((path) => ['-e', path])], {
    cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_WEB_NATIVE_GATE: gate || '', PI_SUBAGENTS_TEMP_ROOT: join(agentDir, 'subagent-temp') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const events = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let event; try { event = JSON.parse(line); } catch { return; }
    events.push(event); if (events.length > 200) events.shift();
    const request = pending.get(event.id);
    if (event.type === 'response' && request) {
      pending.delete(event.id); clearTimeout(request.timer);
      if (event.success) request.resolve(event.data);
      else request.reject(new Error(event.error));
    }
  });
  const failed = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on('error', failed);
  child.on('exit', (code, signal) => failed(new Error(`Owned native Pi exited (${code ?? signal}): ${stderr}`)));
  const command = (type, fields = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error('Owned native Pi has exited')); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native RPC ${type} timed out: ${stderr}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
  });
  const close = async ({ crash = false } = {}) => {
    if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
    if (crash) child.kill('SIGKILL'); else child.stdin.end();
    await Promise.race([closed, delay(10000, undefined, { ref: false }).then(() => { throw new Error('Owned native Pi did not exit'); })]);
  };
  try { await command('get_state', {}, 30000); }
  catch (error) { await close({ crash: true }); throw error; }
  return { pid: child.pid, child, command, events, close };
}
