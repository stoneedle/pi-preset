import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { piSdk } from '../scripts/preset.mjs';
import { resolveHostPeerAliases } from '../packages/pi-subagents/src/runs/background/runner-aliases.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
test('configured native model profiles get working shared tools without parent extensions or database access', { timeout: 120000 }, async () => {
  const sdk = await piSdk();
  const peers = resolveHostPeerAliases(sdk.getPackageDir());
  assert.deepEqual(peers.missing, []);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-tools-e2e-'));
  try {
    const output = execFileSync(process.execPath, [
      '--import', pathToFileURL(path.join(root, 'packages/pi-subagents/runner-peer-preload.mjs')).href,
      path.join(root, 'tests/support/subagent-tools.mjs'), root, os.homedir(),
    ], {
      cwd: temporary, encoding: 'utf8', timeout: 110000,
      env: { ...process.env, PI_SDK_ROOT: sdk.getPackageDir(), PI_ASYNC_NATIVE_RUNNER: '1', JITI_ALIAS: JSON.stringify(peers.aliases),
        HOME: temporary, USERPROFILE: temporary, PI_CODING_AGENT_DIR: path.join(temporary, '.pi/agent'),
        PI_SUBAGENTS_TEMP_ROOT: path.join(temporary, 'runs') },
    });
    assert.match(output, /PASS shared tooling for configured model profiles in foreground and background sessions/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
