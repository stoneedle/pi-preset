import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { chromium, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { launchTestBrowser } from '../lib/browser.mjs';
import { REPO_ROOT } from '../lib/paths.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-scoped-models-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  mkdirSync(join(root, 'sessions'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    defaultProvider: 'scope-test', defaultModel: 'retired', defaultThinkingLevel: 'medium',
    enabledModels: ['scope-test/second:high', 'scope-test/curr*'],
  }));
  writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { 'scope-test': {
    baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: 'offline-test-key',
    models: ['current', 'second', 'retired'].map((id) => ({
      id, name: id, reasoning: true, input: ['text'], contextWindow: 64000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  } } }));
  return { root, cwd };
}

const ids = (models) => models.map((model) => model.provider + '/' + model.id);
const { FileModelsStore } = await import(new URL('./core/models-store.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

test('new tasks and dormant sessions use Pi scoped patterns and startup thinking without starting Pi', { timeout: 30000 }, async () => {
  const { root, cwd } = fixture();
  const directory = join(root, 'sessions', 'fixture');
  mkdirSync(directory);
  const id = 'dormant.jsonl';
  const history = JSON.stringify({ type: 'session', version: 3, id: 'scope-dormant', cwd, timestamp: new Date().toISOString() }) + '\n';
  writeFileSync(join(directory, id), history);
  const savedSettings = readFileSync(join(root, 'settings.json'), 'utf8');
  const server = await startServer({ agentDir: root, nativeWorkers: true });
  let browser;
  try {
    const response = await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd));
    assert.equal(response.status, 200, await response.clone().text());
    const options = await response.json();
    assert.deepEqual(ids(options.models), ['scope-test/second', 'scope-test/current']);
    assert.equal(options.model, 'second', 'startup selection follows Pi scope, not the out-of-scope default');
    assert.equal(options.thinking, 'high');
    assert.equal(options.models[0].thinking, 'high');
    browser = await launchTestBrowser(chromium);
    const page = await browser.browser.newPage({ viewport: { width: 393, height: 851 } });
    await page.goto(server.baseURL + '/session?id=' + id);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '模型设置', exact: true });
    await expect(picker.locator('.model-option strong')).toHaveText(['second', 'current']);
    // Project settings override the global scope, using Pi's own pattern semantics.
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ enabledModels: ['scope-test/current:low'] }));
    const project = await (await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd))).json();
    assert.deepEqual(ids(project.models), ['scope-test/current']);
    assert.equal(project.model, 'current');
    assert.equal(project.thinking, 'low');
    // Empty scope retains Pi's unscoped behavior rather than producing an unusable picker.
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ enabledModels: [] }));
    const unscoped = await (await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd))).json();
    assert.ok(unscoped.models.some((model) => model.provider === 'scope-test' && model.id === 'retired'));
    assert.equal(unscoped.model, 'retired');
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ enabledModels: ['scope-test/missing'] }));
    const unmatched = await (await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd))).json();
    assert.deepEqual(ids(unmatched.models), ids(unscoped.models), 'unmatched scope follows Pi unscoped semantics');
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({
      enabledModels: [], defaultProvider: 'extension-test', defaultModel: 'extension-only',
    }));
    const deferred = await (await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd))).json();
    assert.equal(deferred.model, undefined, 'a default only registered by an extension is left to Pi');
    assert.equal(deferred.provider, undefined);
    assert.equal(existsSync(join(root, 'pi-web', 'owners')), false);
    assert.equal(existsSync(join(root, 'pi-web', 'workers')), false);
    assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), savedSettings);
    assert.equal(readFileSync(join(directory, id), 'utf8'), history);
  } finally {
    await browser?.close();
    await stopServer(server.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('new conversation offers scoped models from the native Pi catalog cache before the first message', { timeout: 30000 }, async () => {
  const { root, cwd } = fixture();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let server, browser;
  try {
    writeFileSync(join(root, 'auth.json'), JSON.stringify({ 'openai-codex': {
      type: 'oauth', access: 'offline-fixture-access', refresh: 'offline-fixture-refresh',
      expires: Date.now() + 3600000, accountId: 'offline-fixture-account',
    } }));
    const options = { authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'), allowModelNetwork: false };
    const bundled = await ModelRuntime.create(options);
    const base = bundled.getModel('openai-codex', 'gpt-6-luna');
    assert.ok(base);
    const cached = { ...base, id: 'catalog-only-scope-fixture', name: 'Cached-only scoped model' };
    assert.equal(bundled.getModel(cached.provider, cached.id), undefined, 'the model is not bundled or defined in models.json');
    const store = new FileModelsStore();
    // A newer persisted catalog overlay, using Pi's own storage contract and default location.
    await store.write(cached.provider, { models: [cached], lastModified: Date.UTC(2100, 0, 1), checkedAt: Date.now() });
    const native = await ModelRuntime.create(options);
    assert.ok(native.getAvailableSnapshot().some((model) => model.id === cached.id), 'native Pi restores the cached model offline');
    const expected = [base, cached].map((model) => model.provider + '/' + model.id);
    const settings = JSON.stringify({ defaultProvider: base.provider, defaultModel: base.id, enabledModels: expected });
    writeFileSync(join(root, 'settings.json'), settings);
    const savedCatalog = await store.read(cached.provider);
    server = await startServer({ agentDir: root, nativeWorkers: true });
    const response = await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(ids((await response.json()).models), expected, 'preview and native Pi must read the same cached catalog');
    browser = await launchTestBrowser(chromium);
    const page = await browser.browser.newPage({ viewport: { width: 393, height: 851 } });
    await page.goto(server.baseURL + '/');
    await page.getByRole('button', { name: '开始新任务', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新对话', exact: true });
    await editor.getByRole('button', { name: '选择项目', exact: true }).click();
    const projects = page.getByRole('dialog', { name: '选择项目', exact: true });
    await projects.locator('summary').filter({ hasText: '系统路径' }).click();
    await projects.getByRole('textbox', { name: '文件夹路径', exact: true }).fill(cwd);
    await projects.getByRole('button', { name: '前往', exact: true }).click();
    await projects.getByRole('button', { name: '使用此文件夹', exact: true }).click();
    await editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Unsent catalog fixture');
    await editor.getByRole('button', { name: '模型设置', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '模型设置', exact: true });
    await expect(picker.locator('.model-option strong')).toHaveText([base.name, cached.name]);
    await picker.getByRole('searchbox', { name: '搜索模型' }).fill('Cached-only');
    await picker.getByRole('button', { name: cached.name + ' ' + cached.provider, exact: true }).click();
    await picker.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    await expect(editor.locator('.model-trigger')).toContainText(cached.name);
    await expect(editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('Unsent catalog fixture');
    assert.equal((await (await fetch(server.baseURL + '/api/sessions')).json()).total, 0);
    assert.equal(existsSync(join(root, 'pi-web', 'owners')), false);
    assert.equal(existsSync(join(root, 'pi-web', 'workers')), false);
    assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), settings);
    assert.deepEqual(await store.read(cached.provider), savedCatalog);
  } finally {
    await browser?.close();
    if (server) await stopServer(server.child);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('connected phone picker follows the live Pi scope, including changes and unscoped sessions', { timeout: 45000 }, async () => {
  const { root, cwd } = fixture();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session, server, browser;
  try {
    const settings = SettingsManager.create(cwd, root);
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'),
      allowModelNetwork: false });
    const current = runtime.getModel('scope-test', 'current');
    const second = runtime.getModel('scope-test', 'second');
    const loader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager: settings,
      additionalExtensionPaths: [join(REPO_ROOT, '.pi', 'extensions', 'index.ts')],
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(cwd, join(root, 'sessions', 'fixture'));
    manager.appendMessage({ role: 'user', content: 'Scoped picker fixture', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Offline fixture' }],
      api: current.api, provider: current.provider, model: current.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    ({ session } = await createAgentSession({ cwd, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
      sessionManager: manager, model: current, scopedModels: [{ model: second }, { model: current }], noTools: true }));
    await session.bindExtensions({ mode: 'rpc' });
    server = await startServer({ agentDir: root, nativeWorkers: true });
    const id = basename(manager.getSessionFile());
    const models = async () => {
      const response = await fetch(server.baseURL + '/api/models?id=' + encodeURIComponent(id));
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).models;
    };
    assert.deepEqual(ids(await models()), ['scope-test/second', 'scope-test/current']);
    browser = await launchTestBrowser(chromium);
    const page = await browser.browser.newPage({ viewport: { width: 393, height: 851 } });
    await page.goto(server.baseURL + '/session?id=' + encodeURIComponent(id));
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '模型设置', exact: true });
    await expect(picker.locator('.model-option strong')).toHaveText(['second', 'current']);
    await picker.getByRole('searchbox', { name: '搜索模型' }).fill('retired');
    await expect(picker.locator('.model-option')).toHaveCount(0);
    await picker.getByRole('searchbox', { name: '搜索模型' }).fill('');
    await picker.getByRole('button', { name: 'second scope-test' }).click();
    await expect.poll(() => session.model.id).toBe('second');
    await picker.getByRole('button', { name: '关闭模型设置' }).click();
    session.setScopedModels([{ model: current }]);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(picker.locator('.model-option strong')).toHaveText(['current']);
    assert.deepEqual(ids(await models()), ['scope-test/current']);
    session.setScopedModels([]);
    assert.ok((await models()).some((model) => model.provider === 'scope-test' && model.id === 'retired'));
  } finally {
    await browser?.close();
    if (server) await stopServer(server.child);
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
