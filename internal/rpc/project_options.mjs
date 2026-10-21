import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [binary, base, cwd, agentDir] = process.argv.slice(2);
let packageFile;
for (const directory of [base, dirname(realpathSync(binary)), dirname(binary)]) {
  try { packageFile = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(join(directory, 'pi-web-resolver.mjs'))); } catch { continue; }
  if (packageFile) break;
}
if (!packageFile) throw new Error('Pi SDK 不可用');
const entry = join(dirname(packageFile), 'dist', 'index.js');
const { ModelRuntime } = await import(new URL('./core/model-runtime.js', pathToFileURL(entry)));
const { SettingsManager } = await import(new URL('./core/settings-manager.js', pathToFileURL(entry)));
const { findInitialModel } = await import(new URL('./core/model-resolver.js', pathToFileURL(entry)));
const { getSupportedThinkingLevels, clampThinkingLevel } = await import(
  pathToFileURL(join(dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(entry))), 'dist', 'compat.js')).href
);
// This reads Pi's catalog/settings without constructing an AgentSession or loading extensions.
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(agentDir, 'models.sqlite'), allowModelNetwork: false,
});
const settings = SettingsManager.create(cwd, agentDir);
const selected = await findInitialModel({
  scopedModels: [], isContinuing: false, modelRuntime: runtime,
  defaultProvider: settings.getDefaultProvider(), defaultModelId: settings.getDefaultModel(),
  defaultThinkingLevel: settings.getDefaultThinkingLevel(),
  modelThinkingLevels: settings.getAllModelThinkingLevels(),
});
const models = runtime.getAvailableSnapshot().map((model) => ({
  id: model.id, name: model.name, provider: model.provider,
  thinkingLevels: getSupportedThinkingLevels(model),
  thinking: clampThinkingLevel(model, settings.getModelThinkingLevel(model.provider, model.id)
    ?? settings.getDefaultThinkingLevel() ?? selected.thinkingLevel),
}));
// An extension can register the configured default only after Pi loads project resources.
// Do not silently replace that default with a built-in fallback in a draft.
const deferred = settings.getDefaultModel() && !models.some((model) =>
  model.id === settings.getDefaultModel() && model.provider === settings.getDefaultProvider());
process.stdout.write(JSON.stringify({
  models, provider: deferred ? undefined : selected.model?.provider,
  model: deferred ? undefined : selected.model?.id,
  thinking: deferred ? undefined : selected.model ? clampThinkingLevel(selected.model, selected.thinkingLevel) : 'off',
}));
