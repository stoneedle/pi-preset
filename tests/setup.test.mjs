import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repository } from '../scripts/sync.mjs';

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o755 });
};

test('setup 真实启动隔离的包管理进程，支持空格路径；已安装同版本包不会重装', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'pi preset setup '));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repo');
  const home = join(temporary, 'home');
  const agent = join(home, '.pi', 'agent');
  const log = join(temporary, 'calls.jsonl');
  const bin = join(temporary, 'bin');
  const provider = join(temporary, 'fake manager.mjs');
  cpSync(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
  write(join(root, 'config', 'resources.json'), [
    { source: 'extensions', target: 'agent:extensions', directory: true },
  ]);
  write(join(root, 'config', 'settings.json'), { defaultModel: 'fixture' });
  write(join(root, 'config', 'packages.json'), [{ id: 'demo', source: 'npm:demo@1.0.0' }]);
  write(join(root, 'extensions', 'agy-gemini', 'package.json'), { dependencies: { ajv: '8.17.1', 'pi-subagents': '0.78.0' } });
  write(join(root, 'extensions', 'agy-gemini', 'package-lock.json'), {});
  write(join(agent, 'auth.json'), 'private');
  write(provider, `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'install') {
  const folder = join(process.env.PI_CODING_AGENT_DIR, 'npm', 'node_modules', 'demo');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ version: '1.0.0' }));
} else {
  const folder = args[args.indexOf('--prefix') + 1];
  for (const [name, version] of Object.entries({ ajv: '8.17.1', 'pi-subagents': '0.78.0' })) {
    const module = join(folder, 'node_modules', name);
    mkdirSync(module, { recursive: true });
    writeFileSync(join(module, 'package.json'), JSON.stringify({ version }));
  }
}
`);
  if (process.platform === 'win32') write(join(bin, 'pi.cmd'), `@"${process.execPath}" "${provider}" %*\r\n`);
  else write(join(bin, 'pi'), `#!/bin/sh\nexec "${process.execPath}" "${provider}" "$@"\n`);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
    npm_execpath: provider, TEST_LOG: log,
    PATH: bin + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
  };
  // Windows environment keys are case-insensitive; keep a single PATH spelling.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete env[key];
  const execute = () => execFileSync(process.execPath, [join(root, 'scripts', 'setup.mjs')], { env, encoding: 'utf8' });
  assert.match(execute(), /完成/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['install', 'npm:demo@1.0.0']);
  assert.ok(calls[1].includes('--ignore-scripts'));
  assert.ok(existsSync(join(agent, 'extensions', 'agy-gemini', 'node_modules', 'ajv', 'package.json')));
  assert.equal(readFileSync(join(agent, 'auth.json'), 'utf8'), 'private');
  assert.match(execute(), /保留已安装包/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
});
