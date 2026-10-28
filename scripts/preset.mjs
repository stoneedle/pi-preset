import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
let sdkPromise;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const command = (executable, args, cwd) => execFileSync(executable, args, { cwd, stdio: 'inherit' });
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export function context(root = repository) {
  const home = path.resolve(root, '../..');
  if (path.basename(root) !== 'preset' || path.basename(path.dirname(root)) !== '.pi')
    throw new Error('请将仓库放在 %USERPROFILE%/.pi/preset。');
  return {
    root, home,
    agent: path.join(home, '.pi', 'agent'),
    upstreams: path.join(home, '.pi', 'upstreams'),
    manifest: json(path.join(root, 'preset.json')),
    settings: json(path.join(root, 'settings.json')),
  };
}

export async function piSdk() {
  if (!sdkPromise) {
    const globalRoot = execFileSync(process.execPath, [npmCli, 'root', '-g'], { encoding: 'utf8' }).trim();
    const root = path.join(globalRoot, '@earendil-works', 'pi-coding-agent');
    sdkPromise = import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
  }
  return sdkPromise;
}

export function prepareUpstreams(ctx) {
  const skills = [];
  fs.mkdirSync(ctx.upstreams, { recursive: true });
  for (const [name, source] of Object.entries(ctx.manifest.upstreams)) {
    const directory = path.join(ctx.upstreams, name);
    if (!fs.existsSync(path.join(directory, '.git'))) {
      command('git', ['clone', '--filter=blob:none', '--no-checkout', source.url, directory], ctx.home);
    } else if (git(directory, ['status', '--porcelain']).length) {
      throw new Error('上游目录有本地修改，请先将定制内容纳入 preset：' + directory);
    }
    if (git(directory, ['remote', 'get-url', 'origin']) !== source.url)
      throw new Error('上游来源与清单不符：' + directory);
    try { git(directory, ['cat-file', '-e', source.commit + '^{commit}']); }
    catch { command('git', ['fetch', 'origin', source.commit], directory); }
    command('git', ['sparse-checkout', 'init', '--cone'], directory);
    command('git', ['sparse-checkout', 'set', '--', ...source.skills], directory);
    command('git', ['checkout', '--detach', source.commit], directory);
    for (const resource of source.skills) {
      if (!fs.existsSync(path.join(directory, resource, 'SKILL.md')))
        throw new Error('上游技能不存在：' + name + '/' + resource);
      skills.push('./' + name + '/' + resource);
    }
  }
  for (const [name, tool] of Object.entries(ctx.manifest.externalTools ?? {})) {
    if (!tool.skill) continue;
    const directory = tool.skill.replace(/^~(?=[/\\\\])/, ctx.home);
    if (fs.existsSync(path.join(directory, 'SKILL.md'))) skills.push(directory);
    else console.log('可选工具未安装：' + name + '；安装入口：' + tool.homepage);
  }
  fs.writeFileSync(path.join(ctx.upstreams, 'package.json'), JSON.stringify({
    name: 'pi-preset-upstreams', private: true, pi: { skills },
  }, null, 2) + '\n');
}

export async function prepare(ctx) {
  prepareUpstreams(ctx);
  for (const entry of ctx.settings.packages) {
    const source = typeof entry === 'string' ? entry : entry.source;
    if (!source.startsWith('.')) continue;
    const directory = path.resolve(ctx.agent, source);
    if (fs.existsSync(path.join(directory, 'package-lock.json'))) {
      command(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev', '--omit=peer', '--install-links=false', '--no-audit', '--no-fund'], directory);
    }
  }
  const { DefaultPackageManager, SettingsManager } = await piSdk();
  const manager = new DefaultPackageManager({
    cwd: ctx.root, agentDir: ctx.agent, settingsManager: SettingsManager.inMemory(ctx.settings),
  });
  await manager.resolve();
}

function inventory(directory) {
  const result = new Map();
  const visit = (root, prefix = '') => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(root, entry.name);
      if (fs.statSync(absolute).isDirectory()) visit(absolute, relative);
      else result.set(relative, fs.readFileSync(absolute));
    }
  };
  visit(directory);
  return result;
}

function equivalent(source, destination, directory) {
  if (!directory) return fs.readFileSync(source).equals(fs.readFileSync(destination));
  const current = inventory(destination);
  if (!current.size) return true;
  const expected = inventory(source);
  return current.size === expected.size && [...current].every(([name, bytes]) => expected.get(name)?.equals(bytes));
}

const canonical = value => fs.realpathSync(value).toLowerCase();
export function linkPlan(ctx) {
  return Object.entries(ctx.manifest.links).map(([relative, target]) => {
    const source = path.join(ctx.root, target);
    const destination = path.join(ctx.agent, relative);
    const directory = fs.statSync(source).isDirectory();
    let existing;
    try { existing = fs.lstatSync(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing?.isSymbolicLink()) {
      if (canonical(source) !== canonical(destination)) throw new Error('已有链接指向其他来源：' + destination);
      return { source, destination, directory, ready: true };
    }
    if (existing && (existing.isDirectory() !== directory || !equivalent(source, destination, directory)))
      throw new Error('已有内容与仓库不同，先比较并合并后再初始化：' + destination);
    return { source, destination, directory, existing: Boolean(existing) };
  });
}

function requireFileLinks() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preset-link-'));
  try {
    const source = path.join(temporary, 'source');
    fs.writeFileSync(source, '');
    fs.symlinkSync(source, path.join(temporary, 'link'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') error.exitCode = 77;
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function linkPreset(ctx) {
  const plan = linkPlan(ctx);
  if (plan.some(entry => !entry.directory && !entry.ready)) requireFileLinks();
  for (const entry of plan) {
    if (entry.ready) continue;
    fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
    if (entry.existing) fs.rmSync(entry.destination, { recursive: entry.directory });
    fs.symlinkSync(entry.source, entry.destination, entry.directory ? 'junction' : 'file');
    console.log(entry.destination + ' -> ' + entry.source);
  }
}

export function checkLinks(ctx) {
  for (const [relative, target] of Object.entries(ctx.manifest.links)) {
    const destination = path.join(ctx.agent, relative);
    if (!fs.lstatSync(destination).isSymbolicLink() || canonical(destination) !== canonical(path.join(ctx.root, target)))
      throw new Error('未连接到仓库本体：' + destination);
  }
}

export async function finish(ctx) {
  command(process.execPath, [path.join(ctx.root, 'packages/pi-web/scripts/enable-fast-state.mjs'), '--apply'], ctx.root);
  command(process.execPath, [path.join(ctx.root, 'packages/pi-web/scripts/run-lifecycle.mjs'), 'install'], ctx.root);
  await check(ctx);
}

export async function check(ctx) {
  checkLinks(ctx);
  const { DefaultResourceLoader, SettingsManager } = await piSdk();
  const loader = new DefaultResourceLoader({
    cwd: ctx.root, agentDir: ctx.agent,
    settingsManager: SettingsManager.create(ctx.root, ctx.agent),
    noContextFiles: true,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  const diagnostics = loader.getSkills().diagnostics;
  if (errors.length || diagnostics.length) throw new Error(JSON.stringify({ errors, diagnostics }, null, 2));
  const loaded = new Set(loader.getSkills().skills.map(skill => canonical(skill.filePath)));
  const expected = [];
  for (const [name, source] of Object.entries(ctx.manifest.upstreams))
    for (const resource of source.skills) expected.push(path.join(ctx.upstreams, name, resource, 'SKILL.md'));
  for (const relative of inventory(path.join(ctx.root, 'skills')).keys())
    if (path.basename(relative) === 'SKILL.md') expected.push(path.join(ctx.root, 'skills', relative));
  for (const tool of Object.values(ctx.manifest.externalTools ?? {})) {
    if (!tool.skill) continue;
    const file = path.join(tool.skill.replace(/^~(?=[/\\\\])/, ctx.home), 'SKILL.md');
    if (fs.existsSync(file)) expected.push(file);
  }
  for (const file of expected) if (!loaded.has(canonical(file))) throw new Error('声明的技能未加载：' + file);
  console.log('链接与 Pi 资源加载正常；技能数量：' + loader.getSkills().skills.length);
}
