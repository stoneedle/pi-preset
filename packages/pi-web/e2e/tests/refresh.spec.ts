import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { appendEntry, assistantTextEntry, buildSession, writeSession, uniqueSessionName } from '../lib/sessions';

test('first PWA installation does not strand live streams or refresh the document', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'first-worker'), buildSession({ cwd: workingDir }).entries);
  let state = 'idle';
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id), getState: () => ({ state }) });
  let documents = 0;
  page.on('request', request => { if (request.isNavigationRequest()) documents++; });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'idle');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    state = 'running'; owner.publish();
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'running');
    await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
    expect(documents).toBe(1);
  } finally { await owner.close(); }
});

test('manual refresh is reachable from home and conversation and only clears the draft after confirmation', async ({ page, sessionsDir, workingDir }, info) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '刷新界面', exact: true })).toBeVisible();
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'manual-refresh'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await input.fill('刷新允许丢弃的未发送草稿');
  await page.locator('summary[aria-label="更多"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await navigation;
  await expect(input).toHaveValue('');
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
});

test('canceling manual refresh preserves all input and the current document', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'refresh-cancel'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await input.fill('取消刷新后继续编辑');
  await page.evaluate(() => { (window as any).__sameDocument = true; });
  let question = '';
  page.once('dialog', async (dialog) => { question = dialog.message(); await dialog.dismiss(); });
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await expect.poll(() => question).toContain('所有会话的草稿');
  await expect(input).toHaveValue('取消刷新后继续编辑');
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
});

test('a draft typed during the refresh preflight is checked before navigation', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'refresh-edit-race'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (...args) => args[1]?.cache === 'no-store' && String(args[0]) === location.href
      ? new Promise<Response>((resolve) => { (window as any).__releaseRefresh = () => resolve(new Response('ready')); })
      : nativeFetch(...args);
  });
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__releaseRefresh));
  const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await input.fill('检查期间新写的草稿');
  let confirmed = false;
  page.once('dialog', async (dialog) => { confirmed = true; await dialog.dismiss(); });
  await page.evaluate(() => (window as any).__releaseRefresh());
  await expect.poll(() => confirmed).toBe(true);
  await expect(input).toHaveValue('检查期间新写的草稿');
});

test('manual refresh never replaces a usable page with a temporary proxy 502', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'refresh-502'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__keptPage = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (...args) => args[1]?.cache === 'no-store' && String(args[0]) === location.href
      ? Promise.resolve(new Response('Bad Gateway', { status: 502 }))
      : nativeFetch(...args);
  });
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法刷新：HTTP 502');
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__keptPage)).toBe(true);
});

test('manual preflight is single-flight and a control started during it prevents navigation', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'refresh-control-race'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__sameDocument = true;
    (window as any).__preflights = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      if (args[1]?.cache === 'no-store' && String(args[0]) === location.href) {
        (window as any).__preflights++;
        return new Promise<Response>(resolve => { (window as any).__releasePreflight = () => resolve(new Response('ready')); });
      }
      if (new URL(String(args[0]), location.href).pathname === '/api/chat')
        return new Promise<Response>(resolve => { (window as any).__releaseControl = () => resolve(new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } })); });
      return nativeFetch(...args);
    };
  });
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__releasePreflight));
  await page.locator('summary[aria-label="更多"]').click();
  const refresh = page.getByRole('button', { name: '刷新界面', exact: true });
  await expect(refresh).toBeDisabled();
  await refresh.evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).__preflights)).toBe(1);
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('检查期间开始发送');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__releaseControl));
  await page.evaluate(() => (window as any).__releasePreflight());
  await page.locator('summary[aria-label="更多"]').click();
  await expect(refresh).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
  await page.evaluate(() => (window as any).__releaseControl());
  await expect(refresh).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
});

test.describe('resource recovery without a working precache', () => {
  test.use({ serviceWorkers: 'block' });
  test('a real lazy module failure does not replace the document or close the new-task editor', async ({ page, sessionsDir, workingDir }, info) => {
    const { entries, lastId } = buildSession({ cwd: workingDir });
    const id = writeSession(sessionsDir, uniqueSessionName(info, 'lazy-error-draft'), entries);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
    await page.evaluate(() => { (window as any).__sameDocument = true; });
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新对话', exact: true });
    const input = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await input.fill('资源失败时仍在新增会话中输入');
    let failed = 0;
    await page.route('**/static/assets/mermaid.core-*.js', async (route) => { failed++; await route.abort('connectionreset'); });
    appendEntry(sessionsDir, id, assistantTextEntry(lastId, '```mermaid\ngraph LR\nA-->B\n```').entry);
    await expect(editor.getByRole('alert')).toContainText('界面资源加载失败');
    expect(failed).toBeGreaterThan(0);
    await expect(editor).toBeVisible();
    await expect(input).toHaveValue('资源失败时仍在新增会话中输入');
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
    await expect(editor.getByRole('button', { name: /刷新|重试/ })).toHaveCount(0);
  });
});
