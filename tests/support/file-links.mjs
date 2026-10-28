import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { piSdk } from '../../scripts/preset.mjs';

export async function verifyFileLinks(ctx) {
  const { DefaultResourceLoader, SettingsManager } = await piSdk();
  const settings = SettingsManager.create(ctx.root, ctx.agent);
  settings.setDefaultThinkingLevel('high');
  settings.setPackages(['npm:fixture-package@1.0.0']);
  await settings.flush();
  const persisted = JSON.parse(fs.readFileSync(path.join(ctx.root, 'settings.json'), 'utf8'));
  assert.equal(persisted.defaultThinkingLevel, 'high');
  assert.deepEqual(persisted.packages, ['npm:fixture-package@1.0.0']);
  fs.writeFileSync(path.join(ctx.agent, 'APPEND_SYSTEM.md'), 'Updated instruction');
  fs.writeFileSync(path.join(ctx.agent, 'keybindings.json'), '{"app.session.new":"ctrl+shift+n"}\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, 'keybindings.json'), 'utf8'))['app.session.new'], 'ctrl+shift+n');
  const loader = new DefaultResourceLoader({
    cwd: ctx.root, agentDir: ctx.agent, noExtensions: true, noContextFiles: true,
    settingsManager: SettingsManager.inMemory({ skills: ['!**/.agents/skills/**'], packages: [] }),
  });
  await loader.reload();
  assert.ok(loader.getAppendSystemPrompt().includes('Updated instruction'));
}
