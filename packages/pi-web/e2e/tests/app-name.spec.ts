import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '../lib/test';
import { startServer, stopServer } from '../lib/server';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/app-name', { data: { name: '' } })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  expect((await request.post('/api/app-name', { data: { name: '' } })).ok()).toBe(true);
});

async function openName(page: Page) {
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('button', { name: '应用名称', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '应用名称', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  return dialog;
}

const currentName = (page: Page) => page.locator('meta[name="application-name"]');

test('PWA 默认只使用主机名，改名保持安装身份并覆盖登录页元数据', async ({ request, baseURL }) => {
  const original = await (await request.get('/manifest.webmanifest')).json();
  expect(original.name).toBe(hostname());
  expect(original.short_name).toBe(hostname());
  expect(original.id).toBe('/');
  expect(original.start_url).toBe('/');
  expect(original.scope).toBe('/');
  const secured = await startServer({ token: 'isolated-name-token' });
  const headers = { Authorization: 'Bearer isolated-name-token' };
  try {
    expect((await request.post(secured.baseURL + '/api/app-name', { data: { name: 'untrusted' } })).status()).toBe(401);
    expect((await request.post(secured.baseURL + '/api/app-name', { headers: { ...headers, Origin: 'https://example.invalid' }, data: { name: 'untrusted' } })).status()).toBe(403);
    const name = '<img src=x onerror=alert(1)> 家里';
    const saved = await request.post(secured.baseURL + '/api/app-name', { headers, data: { name } });
    expect(saved.ok()).toBe(true);
    for (const data of [{}, { name: null }, { name: 17 }, { name: 'x'.repeat(81) }, { name: 'broken\nname' }]) {
      expect((await request.post(secured.baseURL + '/api/app-name', { headers, data })).status()).toBe(400);
    }
    const manifest = await (await request.get(secured.baseURL + '/manifest.webmanifest')).json();
    expect(manifest).toEqual({ ...original, name, short_name: name });
    const head = await request.head(secured.baseURL + '/manifest.webmanifest');
    expect(head.ok()).toBe(true);
    expect(await head.body()).toHaveLength(0);
    expect((await request.post(secured.baseURL + '/manifest.webmanifest')).status()).toBe(405);
    const login = await request.get(secured.baseURL + '/', { headers: { Accept: 'text/html' } });
    expect(login.status()).toBe(401);
    const html = await login.text();
    expect(html).toContain('name="apple-mobile-web-app-title" content="&lt;img');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('isolated-name-token');
    expect((await (await request.get('/manifest.webmanifest')).json()).name).toBe(hostname());
    expect(new URL(manifest.id, secured.baseURL).href).not.toBe(new URL(original.id, baseURL).href);
  } finally {
    await stopServer(secured.child);
    await rm(secured.agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});

test('手机更多与 PC 共用名称，实时生效且不刷新、不丢草稿或改会话名', async ({ page, browser, sessionsDir, workingDir, baseURL }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'name-draft'), buildSession({ cwd: workingDir }).entries);
  const sessionPath = join(sessionsDir, '--home-user-demo-project--', id);
  const original = readFileSync(sessionPath, 'utf8');
  const pcContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  const pc = await pcContext.newPage();
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
    const sessionTitle = await page.title();
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await draft.fill('名称热更新期间必须保留的图文草稿');
    await pc.goto(baseURL!);
    let navigations = 0;
    for (const view of [page, pc]) {
      await view.evaluate(() => { (window as any).__nameDocument = true; });
      view.on('request', request => { if (request.isNavigationRequest()) navigations++; });
    }
    const dialog = await openName(page);
    await dialog.getByRole('textbox', { name: '自定义名称', exact: true }).fill('家里的电脑');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(currentName(page)).toHaveAttribute('content', '家里的电脑');
    await expect(currentName(pc)).toHaveAttribute('content', '家里的电脑');
    await expect(pc).toHaveTitle('家里的电脑');
    await expect(page).toHaveTitle(sessionTitle);
    await expect(draft).toHaveValue('名称热更新期间必须保留的图文草稿');
    const pcDialog = await openName(pc);
    await expect(pcDialog.getByRole('textbox', { name: '自定义名称', exact: true })).toHaveValue('家里的电脑');
    await pcDialog.getByRole('textbox', { name: '自定义名称', exact: true }).fill('');
    await pcDialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(currentName(page)).toHaveAttribute('content', hostname());
    await expect(currentName(pc)).toHaveAttribute('content', hostname());
    await expect(draft).toHaveValue('名称热更新期间必须保留的图文草稿');
    for (const view of [page, pc]) expect(await view.evaluate(() => (window as any).__nameDocument)).toBe(true);
    expect(navigations).toBe(0);
    expect(readFileSync(sessionPath, 'utf8')).toBe(original);
    await draft.fill('');
  } finally { await pcContext.close(); }
});

test('名称持久化跨服务重启恢复，另一主机的配置保持独立', async ({ request }) => {
  let isolated = await startServer();
  const { agentDir, baseURL } = isolated;
  try {
    const saved = await (await request.post(baseURL + '/api/app-name', { data: { name: '办公室' } })).json();
    await stopServer(isolated.child);
    isolated = await startServer({ agentDir, port: Number(new URL(baseURL).port) });
    const restored = await (await request.get(baseURL + '/api/app-name')).json();
    expect(restored).toEqual(saved);
    expect((await (await request.get(baseURL + '/manifest.webmanifest')).json()).name).toBe('办公室');
    expect((await (await request.get('/api/app-name')).json()).name).toBe(hostname());
  } finally {
    await stopServer(isolated.child);
    await rm(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});

test('320px 键盘高度内能编辑长名称，取消和失败均保留原设置且不自动重试', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.goto('/');
  let dialog = await openName(page);
  const input = dialog.getByRole('textbox', { name: '自定义名称', exact: true });
  await input.fill('取消这次改名');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await (await request.get('/api/app-name')).json()).name).toBe(hostname());
  let posts = 0;
  await page.route('**/api/app-name', route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    return route.abort('failed');
  });
  dialog = await openName(page);
  const name = '很长的主机名称'.repeat(10);
  await input.fill(name);
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await save.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue(name);
  await page.waitForTimeout(800);
  expect(posts).toBe(1);
  expect((await (await request.get('/api/app-name')).json()).name).toBe(hostname());
  await page.unroute('**/api/app-name');
  await save.click();
  await expect(dialog).not.toBeVisible();
  await expect(currentName(page)).toHaveAttribute('content', name);
  expect((await (await request.get('/manifest.webmanifest')).json()).short_name).toBe(name);
});

test('迟到的保存响应不会覆盖另一页面已经更新的名称', async ({ page, request }) => {
  await page.goto('/');
  let release: () => void = () => {};
  let accepted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/app-name', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    accepted = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    const dialog = await openName(page);
    await dialog.getByRole('textbox', { name: '自定义名称', exact: true }).fill('较早的保存');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => accepted).toBe(true);
    await request.post('/api/app-name', { data: { name: 'PC 上更新的名称' } });
    await expect(currentName(page)).toHaveAttribute('content', 'PC 上更新的名称');
    release();
    await expect(dialog).not.toBeVisible();
    await expect(currentName(page)).toHaveAttribute('content', 'PC 上更新的名称');
    await expect(page).toHaveTitle('PC 上更新的名称');
    expect((await (await request.get('/manifest.webmanifest')).json()).name).toBe('PC 上更新的名称');
  } finally { release(); }
});

test('真实存储失败不会提前更新安装名称或丢弃编辑内容', async ({ page, request, agentDir }) => {
  await request.post('/api/app-name', { data: { name: '原名称' } });
  const db = new DatabaseSync(join(agentDir, 'pi-web.sqlite'));
  db.exec("CREATE TRIGGER reject_app_name BEFORE INSERT ON settings WHEN NEW.key='pi-web:app-name' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  try {
    await page.goto('/');
    const dialog = await openName(page);
    const input = dialog.getByRole('textbox', { name: '自定义名称', exact: true });
    await input.fill('尚未保存的名称');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('无法保存');
    await expect(input).toHaveValue('尚未保存的名称');
    await expect(currentName(page)).toHaveAttribute('content', '原名称');
    expect((await (await request.get('/manifest.webmanifest')).json()).name).toBe('原名称');
  } finally { db.exec('DROP TRIGGER reject_app_name'); db.close(); }
});
