import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repository, synchronize } from '../scripts/sync.mjs';

const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'pi-preset-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repo');
  const home = join(temporary, 'home');
  const agentDir = join(home, '.pi', 'agent');
  write(join(root, 'APPEND_SYSTEM.md'), '共享提示词\n');
  write(join(root, 'agents', 'helper.md'), 'extension: {{agentDir}}/npm/plugin.js\n');
  write(join(root, 'config', 'resources.json'), [
    { source: 'APPEND_SYSTEM.md', target: 'agent:APPEND_SYSTEM.md' },
    { source: 'agents', target: 'agent:agents', directory: true },
  ]);
  write(join(root, 'config', 'settings.json'), { defaultModel: 'shared', subagents: { disableBuiltins: true } });
  write(join(root, 'config', 'packages.json'), [{ id: 'demo', source: 'npm:demo@1.0.0' }]);
  return { root, home, agentDir };
}

test('真实仓库 CLI 可安装到两台隔离 PC，重复应用无差异，不读取个人凭据', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'pi-preset-pcs-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  for (const pc of ['PC A', 'PC B']) {
    const home = join(temporary, pc);
    const agent = join(home, '.pi', 'agent');
    write(join(agent, 'auth.json'), 'personal-token');
    write(join(agent, 'sessions', 'session.jsonl'), 'private-session');
    write(join(agent, 'settings.json'), { httpProxy: 'http://private-proxy', packages: ['npm:unrelated'] });
    const args = [join(repository, 'scripts', 'sync.mjs'), 'apply', '--home', home];
    execFileSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(readFileSync(join(agent, 'APPEND_SYSTEM.md'), 'utf8'), readFileSync(join(repository, 'APPEND_SYSTEM.md'), 'utf8'));
    assert.ok(existsSync(join(agent, 'extensions', 'agy-gemini', 'adapter.mjs')));
    assert.ok(existsSync(join(home, '.agents', 'skills', 'tdd', 'SKILL.md')));
    assert.ok(!existsSync(join(home, '.agents', 'skills', 'agy')));
    assert.ok(!existsSync(join(home, '.agents', 'skills', 'whiteboard')));
    assert.ok(!existsSync(join(agent, 'skills', 'hussar-auto-resource')));
    assert.ok(!existsSync(join(agent, 'skills', 'memory')));
    assert.equal(readFileSync(join(agent, 'auth.json'), 'utf8'), 'personal-token');
    assert.equal(readFileSync(join(agent, 'sessions', 'session.jsonl'), 'utf8'), 'private-session');
    assert.equal(json(join(agent, 'settings.json')).httpProxy, 'http://private-proxy');
    assert.ok(json(join(agent, 'settings.json')).packages.includes('npm:unrelated'));
    const role = readFileSync(join(agent, 'agents', 'luna.md'), 'utf8');
    assert.ok(role.includes(agent.replaceAll('\\', '/')));
    assert.ok(!role.includes('{{agentDir}}'));
    assert.match(execFileSync(process.execPath, args, { encoding: 'utf8' }), /无差异/);
  }
});

test('status 只预览；apply 合并设置和包筛选，不覆盖其他本机内容', t => {
  const options = fixture(t);
  const settings = join(options.agentDir, 'settings.json');
  write(settings, { httpProxy: 'private', subagents: { defaultExtensions: ['local'] }, packages: [
    { source: 'npm:demo@0.1.0', extensions: [] }, 'npm:other@2.0.0',
  ] });
  assert.ok(synchronize({ ...options, mode: 'status' }).report.length);
  assert.ok(!existsSync(join(options.agentDir, 'APPEND_SYSTEM.md')));
  synchronize({ ...options, mode: 'apply' });
  const applied = json(settings);
  assert.equal(applied.httpProxy, 'private');
  assert.deepEqual(applied.subagents, { defaultExtensions: ['local'], disableBuiltins: true });
  assert.deepEqual(applied.packages, [{ source: 'npm:demo@1.0.0', extensions: [] }, 'npm:other@2.0.0']);
});

test('安装前及安装后本机修改均阻止整次写入；显式覆盖后正常同步', t => {
  const options = fixture(t);
  const target = join(options.agentDir, 'APPEND_SYSTEM.md');
  write(target, '本机独有的提示词');
  assert.throws(() => synchronize({ ...options, mode: 'apply' }), /未写入任何配置/);
  assert.ok(!existsSync(join(options.agentDir, 'settings.json')));
  synchronize({ ...options, mode: 'apply', overwrite: true });
  write(target, '新的本机修改');
  write(join(options.root, 'agents', 'another.md'), '新角色');
  assert.throws(() => synchronize({ ...options, mode: 'apply' }), /冲突/);
  assert.ok(!existsSync(join(options.agentDir, 'agents', 'another.md')));
});

test('capture 只采集已声明文件与设置，路径还原为模板，私密设置不会进入仓库', t => {
  const options = fixture(t);
  synchronize({ ...options, mode: 'apply' });
  write(join(options.agentDir, 'APPEND_SYSTEM.md'), '已在本机完善的提示词');
  write(join(options.agentDir, 'auth.json'), 'secret');
  write(join(options.agentDir, 'extensions', 'private.ts'), 'secret-code');
  write(join(options.agentDir, 'settings.json'), { defaultModel: 'changed', subagents: { disableBuiltins: false, privateSetting: 'secret' }, apiKey: 'secret' });
  synchronize({ ...options, mode: 'capture' });
  assert.equal(readFileSync(join(options.root, 'APPEND_SYSTEM.md'), 'utf8'), '已在本机完善的提示词');
  assert.match(readFileSync(join(options.root, 'agents', 'helper.md'), 'utf8'), /\{\{agentDir\}\}/);
  assert.deepEqual(json(join(options.root, 'config', 'settings.json')), { defaultModel: 'changed', subagents: { disableBuiltins: false } });
  assert.ok(!existsSync(join(options.root, 'auth.json')));
  assert.ok(!existsSync(join(options.root, 'extensions', 'private.ts')));
  synchronize({ ...options, mode: 'apply' });
  assert.deepEqual(synchronize({ ...options, mode: 'status' }).report, []);
});

test('仓库删除的受管文件会移除；无关文件保留，修改过的待删文件产生冲突', t => {
  const options = fixture(t);
  synchronize({ ...options, mode: 'apply' });
  const managed = join(options.agentDir, 'agents', 'helper.md');
  write(join(options.agentDir, 'agents', 'personal.md'), 'personal');
  rmSync(join(options.root, 'agents', 'helper.md'));
  synchronize({ ...options, mode: 'apply' });
  assert.ok(!existsSync(managed));
  assert.equal(readFileSync(join(options.agentDir, 'agents', 'personal.md'), 'utf8'), 'personal');
  write(join(options.root, 'agents', 'helper.md'), '再次加入');
  synchronize({ ...options, mode: 'apply' });
  write(managed, '本机修改');
  rmSync(join(options.root, 'agents', 'helper.md'));
  assert.throws(() => synchronize({ ...options, mode: 'apply' }), /冲突/);
  assert.equal(readFileSync(managed, 'utf8'), '本机修改');
});

test('本机包目录覆盖共享来源，按包名替换现有开发路径而不产生双重加载', t => {
  const options = fixture(t);
  const development = join(options.home, 'development');
  write(join(development, 'package.json'), { name: '@example/demo' });
  write(join(options.root, 'config', 'machine.local.json'), { packages: { demo: development } });
  write(join(options.root, 'config', 'packages.json'), [{ id: 'demo', source: 'git:github.com/example/demo@abc', packageName: '@example/demo' }]);
  write(join(options.agentDir, 'settings.json'), { packages: [development] });
  synchronize({ ...options, mode: 'apply' });
  assert.deepEqual(json(join(options.agentDir, 'settings.json')).packages, [development]);
});
