import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Patch and exercise the actual development host, never the user's installation.
test('native host preserves an extension title until UI reset', async (t) => {
  const sdk = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
  const patch = fileURLToPath(new URL('../scripts/patch-pi-title.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [patch, sdk], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { InteractiveMode } = await import(pathToFileURL(path.join(sdk, 'dist/modes/interactive/interactive-mode.js')).href);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptg-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, path.join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Fix subtitles', timestamp: Date.now() });
  manager.appendSessionInfo('Fix subtitles');
  const titles = [];
  const host = Object.create(InteractiveMode.prototype);
  Object.defineProperty(host, 'sessionManager', { value: manager });
  Object.assign(host, {
    ui: { terminal: { setTitle: (title) => titles.push(title) }, hideOverlay() {}, requestRender() {} },
    footerDataProvider: { clearExtensionStatuses() {} }, footer: { invalidate() {} },
    defaultEditor: {}, isInitialized: true,
  });
  host.updateTerminalTitle();
  const defaultTitle = titles.at(-1);
  assert.ok(defaultTitle.includes('Fix subtitles'));
  const ui = host.createExtensionUIContext();
  ui.setTitle('✓ · Fix subtitles');
  host.updateTerminalTitle();
  await host.handleEvent({ type: 'session_info_changed', name: 'Fix subtitles' });
  assert.equal(titles.at(-1), '✓ · Fix subtitles');
  ui.setTitle('🔵 · Fix subtitles');
  host.updateTerminalTitle();
  assert.equal(titles.at(-1), '🔵 · Fix subtitles');
  // Incidental visual-resource cleanup remains outside the title contract.
  for (const method of ['clearExtensionTerminalInputListeners', 'setExtensionFooter', 'setExtensionHeader',
    'clearExtensionWidgets', 'setCustomEditorComponent', 'setupAutocompleteProvider', 'setWorkingIndicator', 'setHiddenThinkingLabel']) {
    host[method] = () => {};
  }
  host.resetExtensionUI();
  assert.equal(titles.at(-1), defaultTitle);
});
