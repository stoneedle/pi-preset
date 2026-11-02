import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../lib/paths.ts';

test('quota auth uses the actual Pi SDK without sessions, extensions or another credential store', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-web-quota-auth-'));
  const sdk = readFileSync(join(REPO_ROOT, 'internal/rpc/sdk.mjs'), 'utf8');
  const helper = readFileSync(join(REPO_ROOT, 'internal/rpc/codex_usage_auth.mjs'), 'utf8');
  const binary = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const read = () => {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-', binary, REPO_ROOT, agentDir], {
      input: sdk + '\n' + helper,
      cwd: REPO_ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    return JSON.parse(stdout);
  };
  try {
    const marker = join(agentDir, 'extension-loaded');
    mkdirSync(join(agentDir, 'extensions'));
    writeFileSync(join(agentDir, 'extensions', 'fail.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); throw new Error('Must not load');`);
    assert.deepEqual(read(), { status: 'signed-out' });
    const authFile = join(agentDir, 'auth.json');
    writeFileSync(authFile, JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'not-a-subscription' } }));
    assert.deepEqual(read(), { status: 'signed-out' });
    const payload = {
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
      'https://api.openai.com/profile': { email: 'fixture@example.test' },
    };
    const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture';
    const saved = JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'never-refresh-this-fixture', expires: Date.now() + 3600000 } });
    writeFileSync(authFile, saved);
    assert.deepEqual(read(), { status: 'ok', accessToken: token, accountId: 'fixture-account' });
    assert.equal(readFileSync(authFile, 'utf8'), saved, 'valid login must not be copied or rewritten');
    writeFileSync(authFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'invalid-secret', refresh: 'invalid-refresh', expires: Date.now() + 3600000 } }));
    assert.deepEqual(read(), { status: 'auth-error' });
    for (const path of ['sessions', 'models.sqlite', 'pi-web/workers', 'pi-web/owners', 'extension-loaded']) {
      assert.equal(existsSync(join(agentDir, path)), false, path);
    }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});
