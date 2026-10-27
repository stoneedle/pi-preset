import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const read = path => existsSync(path) ? readFileSync(path) : null;
const hash = data => data === null ? null : createHash('sha256').update(data).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const portable = path => path.replaceAll('\\', '/');
const save = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
const saveJson = (path, value) => save(path, JSON.stringify(value, null, 2) + '\n');

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '__pycache__', '.git'].includes(entry.name)) return [];
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`不收录符号链接：${join(directory, entry.name)}`);
    return entry.isDirectory() ? files(join(directory, entry.name), name) : [name];
  });
}

function merge(current, shared) {
  const result = { ...current };
  for (const [key, value] of Object.entries(shared)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(current?.[key] ?? {}, value) : value;
  }
  return result;
}

function select(current, shape) {
  return Object.fromEntries(Object.entries(shape).map(([key, value]) => {
    if (!(key in current)) throw new Error(`本机设置缺少 ${key}；请在仓库中明确修改同步范围。`);
    return [key, value && typeof value === 'object' && !Array.isArray(value)
      ? select(current[key], value) : current[key]];
  }));
}

function npmIdentity(source) {
  if (!source.startsWith('npm:')) return null;
  const name = source.slice(4);
  const version = name.indexOf('@', 1);
  return version < 0 ? name : name.slice(0, version);
}

function matches(entry, definition, source) {
  const candidate = typeof entry === 'string' ? entry : entry.source;
  if (candidate === source || candidate === definition.source) return true;
  if (npmIdentity(candidate) && npmIdentity(candidate) === npmIdentity(source)) return true;
  if (definition.source?.startsWith('git:') && candidate.startsWith('git:')) {
    return candidate.split('@')[0] === definition.source.split('@')[0];
  }
  if (definition.packageName && existsSync(join(candidate, 'package.json'))) {
    return json(join(candidate, 'package.json')).name === definition.packageName;
  }
  return false;
}

export function configuration({ root = repository, home = homedir(), agentDir } = {}) {
  home = resolve(home);
  agentDir = resolve(agentDir ?? (home === resolve(homedir()) ? process.env.PI_CODING_AGENT_DIR : undefined) ?? join(home, '.pi', 'agent'));
  const roots = { agent: agentDir, shared: join(home, '.agents') };
  const localPath = join(root, 'config', 'machine.local.json');
  const local = existsSync(localPath) ? json(localPath) : {};
  const packages = json(join(root, 'config', 'packages.json')).map(definition => ({
    ...definition,
    resolved: local.packages?.[definition.id]
      ?? (definition.directory ? join(agentDir, definition.directory) : definition.source),
  }));
  const resources = json(join(root, 'config', 'resources.json')).flatMap(resource => {
    const [scope, ...parts] = resource.target.split(':');
    if (!roots[scope]) throw new Error(`未知安装位置：${resource.target}`);
    const source = join(root, resource.source);
    const target = join(roots[scope], parts.join(':'));
    return resource.directory ? files(source).map(name => ({ source: join(source, name), target: join(target, name) })) : [{ source, target }];
  });
  return { root, home, agentDir, packages, resources };
}

export function synchronize(options = {}) {
  const mode = options.mode ?? 'status';
  if (!['status', 'apply', 'capture'].includes(mode)) throw new Error('用法：npm run status|apply|capture [-- --home <目录>] [--overwrite]');
  const config = configuration(options);
  const { root, agentDir, resources, packages } = config;
  const statePath = join(agentDir, 'pi-preset-state.json');
  const state = existsSync(statePath) ? json(statePath) : { files: {} };
  if (state.repository && resolve(state.repository) !== resolve(root)) throw new Error(`此安装由 ${state.repository} 管理；请先核对仓库位置。`);
  const desired = new Map();
  for (const entry of resources) {
    let data = readFileSync(entry.source);
    if (entry.source.endsWith('.md')) data = Buffer.from(data.toString('utf8').replaceAll('{{agentDir}}', portable(agentDir)));
    desired.set(entry.target, { ...entry, data });
  }
  const changes = [];
  for (const [target, entry] of desired) {
    const current = read(target);
    if (hash(current) === hash(entry.data)) continue;
    const conflict = current !== null && hash(current) !== state.files[target];
    changes.push({ action: current === null ? '新增' : conflict ? '冲突' : '更新', target, entry });
  }
  for (const [target, previous] of Object.entries(state.files)) {
    if (desired.has(target) || !existsSync(target)) continue;
    changes.push({ action: hash(read(target)) === previous ? '删除' : '冲突', target, remove: true });
  }
  const settingsPath = join(agentDir, 'settings.json');
  const currentSettings = existsSync(settingsPath) ? json(settingsPath) : {};
  const sharedPath = join(root, 'config', 'settings.json');
  const sharedSettings = json(sharedPath);
  const settings = merge(currentSettings, sharedSettings);
  settings.packages = [...(currentSettings.packages ?? [])];
  for (const definition of packages) {
    const found = settings.packages.findIndex(entry => matches(entry, definition, definition.resolved));
    if (found < 0) settings.packages.push(definition.resolved);
    else {
      const entry = settings.packages[found];
      settings.packages[found] = typeof entry === 'string' ? definition.resolved : { ...entry, source: definition.resolved };
    }
  }
  const settingsChanged = !equal(currentSettings, settings);
  const report = changes.map(({ action, target }) => `${action} ${target}`);
  if (settingsChanged) report.push(`合并 ${settingsPath}`);

  if (mode === 'capture') {
    // Only explicitly managed files and settings can enter the public repository.
    // Missing installed files are not interpreted as a request to delete source or licenses.
    const captured = [];
    for (const [target, entry] of desired) {
      let data = read(target);
      if (data === null) continue;
      if (entry.source.endsWith('.md')) data = Buffer.from(data.toString('utf8').replaceAll(portable(agentDir), '{{agentDir}}'));
      if (hash(data) === hash(read(entry.source))) continue;
      save(entry.source, data);
      captured.push(`采集 ${entry.source}`);
    }
    const capturedSettings = select(currentSettings, sharedSettings);
    if (!equal(capturedSettings, sharedSettings)) {
      saveJson(sharedPath, capturedSettings);
      captured.push(`采集 ${sharedPath}`);
    }
    return { report: captured, config };
  }
  if (mode === 'apply') {
    if (!options.overwrite && changes.some(change => change.action === '冲突')) {
      throw new Error(`本机有尚未收录或安装后修改的文件，未写入任何配置。先 capture 并检查 git diff，或确认后使用 --overwrite：\n${report.join('\n')}`);
    }
    for (const change of changes) {
      if (change.remove) rmSync(change.target);
      else save(change.target, change.entry.data);
    }
    if (settingsChanged) saveJson(settingsPath, settings);
    saveJson(statePath, { repository: root, files: Object.fromEntries([...desired].map(([target, entry]) => [target, hash(entry.data)])) });
  }
  return { report, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = { mode: args.shift(), overwrite: false };
    while (args.length) {
      const flag = args.shift();
      if (flag === '--overwrite') options.overwrite = true;
      else if (flag === '--home' && args.length) options.home = args.shift();
      else if (flag === '--agent-dir' && args.length) options.agentDir = args.shift();
      else throw new Error(`未知或缺少参数的选项：${flag}`);
    }
    const { report } = synchronize(options);
    console.log(report.length ? report.join('\n') : '已同步，无差异。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
