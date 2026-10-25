import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './paths.ts';

// A second real release, built without editing the checkout or its installed dependencies.
export function buildUpdatedRelease() {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-release-'));
  try {
    for (const name of ['go.mod', 'go.sum', 'Makefile', 'cmd', 'internal', 'shared'])
      cpSync(join(REPO_ROOT, name), join(root, name), { recursive: true });
    mkdirSync(join(root, 'web'));
    cpSync(join(REPO_ROOT, 'web'), join(root, 'web'), {
      recursive: true,
      filter: (path) => !relative(join(REPO_ROOT, 'web'), path).split(/[\\/]/).some((part) => ['node_modules', 'dist'].includes(part)),
    });
    symlinkSync(join(REPO_ROOT, 'web', 'node_modules'), join(root, 'web', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const file = join(root, 'web', 'src', 'routes', 'RemoteApp.svelte');
    writeFileSync(file, readFileSync(file, 'utf8').replace('</style>', ':global(html) { --pi-web-release-probe: updated; }\n</style>'));
    const binary = join(root, process.platform === 'win32' ? 'pi-web.exe' : 'pi-web');
    const result = spawnSync(process.env.MAKE || 'make', ['-o', 'frontend-setup', 'build', `BINARY=${binary}`], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    if (result.error || result.status !== 0) throw new Error('Updated release build failed: ' + (result.error?.message || result.stderr + result.stdout).slice(-8000));
    return { binary, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    throw error;
  }
}
