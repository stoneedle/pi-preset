import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

test('reloading the real extension picks up updated terminal icons without restarting Pi', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-title-reload-'));
  const variables = ['PI_CODING_AGENT_DIR', 'PI_TITLE_GLYPHS_CWD', 'PI_TITLE_GLYPHS_STATUS_FILE'];
  const previous = variables.map((key) => [key, process.env[key]] as const);
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_TITLE_GLYPHS_CWD;
  delete process.env.PI_TITLE_GLYPHS_STATUS_FILE;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  t.after(async () => {
    if (session) {
      await session.extensionRunner!.emit({ type: 'session_shutdown' });
      session.dispose();
    }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  cpSync(new URL('../../.pi/extensions', import.meta.url), join(root, '.pi/extensions'), { recursive: true });
  cpSync(new URL('../../shared', import.meta.url), join(root, 'shared'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const sources = ['.pi/extensions/lib/title/format.ts', 'shared/session-presentation.js'].map((relative) => {
    const file = join(root, relative);
    return { file, current: readFileSync(file, 'utf8') };
  });
  for (const { file, current } of sources) writeFileSync(file, current.replaceAll('⚪', '○'));

  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    eventBus: createEventBus(), additionalExtensionPaths: [join(root, '.pi/extensions/index.ts')],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models.sqlite'), allowModelNetwork: false, refreshOnCreate: false });
  ({ session } = await createAgentSession({ cwd: root, modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager: SessionManager.create(root, join(root, 'sessions')) }));
  const titles: string[] = [];
  const errors: string[] = [];
  await session.bindExtensions({ mode: 'tui', uiContext: {
    setTitle: (value: string) => titles.push(value),
    notify: (message: string) => errors.push(message),
  } as any, onError: (error: any) => errors.push(String(error.error)) });
  assert.equal(titles.at(-1), '○');

  for (const { file, current } of sources) writeFileSync(file, current);
  await session.reload();
  assert.deepEqual(errors, []);
  assert.equal(titles.at(-1), '⚪', 'reload must replace the icon already loaded by this Pi process');
});
