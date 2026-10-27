import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuration, synchronize } from './sync.mjs';

function run(command, args) {
  const result = process.platform === 'win32'
    ? spawnSync([command, ...args].map(arg => `"${arg.replaceAll('"', '""')}"`).join(' '), { shell: true, stdio: 'inherit' })
    : spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`);
}

try {
  if (process.argv.length > 2) throw new Error('setup 不接受覆盖选项；先用 status / apply 解决差异。');
  const { packages, agentDir } = configuration();
  for (const definition of packages) {
    if (definition.resolved === definition.source || definition.directory) continue;
    if (!existsSync(join(definition.resolved, 'package.json'))) throw new Error(`本机包路径不存在：${definition.resolved}`);
  }
  const { report } = synchronize({ mode: 'apply' });
  console.log(report.join('\n') || '文件已同步。');
  for (const definition of packages) {
    const source = definition.resolved;
    // Existing development checkouts are not reinstalled or built by this preset.
    if (!source.startsWith('npm:') && !source.startsWith('git:')) continue;
    if (source.startsWith('npm:')) {
      const [, name, version] = source.match(/^npm:(.+)@([^@]+)$/) ?? [];
      const installed = name && join(agentDir, 'npm', 'node_modules', name, 'package.json');
      if (installed && existsSync(installed) && JSON.parse(readFileSync(installed, 'utf8')).version === version) {
        console.log(`保留已安装包 ${source}`);
        continue;
      }
    }
    run('pi', ['install', source]);
  }
  const extension = join(agentDir, 'extensions', 'agy-gemini');
  const expected = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8')).dependencies;
  const ready = Object.entries(expected).every(([name, version]) => {
    const file = join(extension, 'node_modules', name, 'package.json');
    return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).version === version;
  });
  if (!ready) {
    if (!process.env.npm_execpath) throw new Error('请通过 npm run setup 执行，以定位 npm。');
    run(process.execPath, [process.env.npm_execpath, '--prefix', extension, 'ci', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps']);
  }
  console.log('完成。请重新启动 Pi；agy CLI 及其登录需在每台 PC 上单独配置。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
