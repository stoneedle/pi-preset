import { test, expect } from '../lib/test';
import { assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const quote = '这段实现为什么要分两步？';
function isFullContentRequest(url: string) {
  const { pathname, searchParams } = new URL(url);
  return /\/api\/session\/(context|block|image)$/.test(pathname) &&
    !(pathname === '/api/session/image' && searchParams.get('thumbnail') === '1');
}
async function openSharing(page: Page) {
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).blur();
  await page.locator('summary[aria-label="更多"]').click();
}
async function mockSharing(page: Page, supported = true) {
  await page.addInitScript((supported) => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files }: ShareData) => supported && files?.length === 1 && files[0].type === 'text/plain' });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      const state = window as any;
      state.__shares = [...(state.__shares || []), {
        text: data.text, name: data.files![0].name, type: data.files![0].type,
        file: data.files![0], activated: navigator.userActivation?.isActive,
      }];
      if (state.__shareError) throw new DOMException('分享测试', state.__shareError);
    } });
  }, supported);
}

async function sharedPayload(page: Page) {
  return page.evaluate(async () => {
    const { file, ...payload } = (window as any).__shares[0];
    return { ...payload, body: await file.text() };
  });
}

function contextSession(sessionsDir: string, workingDir: string, info: Parameters<typeof uniqueSessionName>[0]) {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, 'inactive-branch-must-not-be-exported').entry);
  let parent = lastId;
  for (let index = 0; index < 35; index++) {
    const next = assistantTextEntry(parent, `历史消息 ${index}`);
    entries.push(next.entry);
    parent = next.id;
  }
  entries.push({ type: 'compaction', id: 'summary', parentId: parent, summary: '必须保留的压缩摘要。' });
  entries.push({ type: 'message', id: 'tool-input', parentId: 'summary', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'private-thinking-not-exported' },
    { type: 'toolCall', id: 'context-tool', name: 'read', arguments: { path: 'example.txt', marker: 'complete-unloaded-input' } },
  ] } });
  entries.push({ type: 'message', id: 'tool-result', parentId: 'tool-input', message: { role: 'toolResult', toolCallId: 'context-tool', toolName: 'read', content: [
    { type: 'text', text: 'complete-unloaded-tool-output' },
    { type: 'image', mimeType: 'image/png', data: 'private-image-base64-not-exported' },
  ] } });
  entries.push({ type: 'message', id: 'selected-message', parentId: 'tool-result', message: { role: 'assistant', content: [{ type: 'text', text: quote }] } });
  entries.push({ type: 'session_info', id: 'name', parentId: 'selected-message', name: '中文上下文 / 分享' });
  return writeSession(sessionsDir, uniqueSessionName(info, 'context-share'), entries);
}

test('top menu shares a complete active-branch TXT only after a second user click, preserving drafts', async ({ page, sessionsDir, workingDir }, info) => {
  await mockSharing(page);
  const id = contextSession(sessionsDir, workingDir, info);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await draft.fill('unsent-draft-must-not-be-exported');
  await expect(page.locator('.remote-main')).not.toContainText('Initial prompt.');
  await expect(page.locator('.remote-main')).not.toContainText('complete-unloaded-tool-output');
  await openSharing(page);
  const trigger = page.getByRole('button', { name: '分享完整会话', exact: true });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole('button', { name: '分享已加载上下文', exact: true })).toBeVisible();
  expect(requests.filter(isFullContentRequest)).toEqual([]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/session/context?*', async (route) => { await gate; await route.continue(); });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '分享完整会话' });
  await expect(dialog.getByRole('status')).toHaveText('正在准备 TXT…');
  expect(await page.evaluate(() => (window as any).__shares)).toBeUndefined();
  release();
  const share = dialog.getByRole('button', { name: '分享 TXT', exact: true });
  await expect(share).toBeVisible();
  expect(await page.evaluate(() => (window as any).__shares)).toBeUndefined();
  await share.click();
  await expect.poll(() => page.evaluate(() => (window as any).__shares?.length)).toBe(1);
  const payload = await sharedPayload(page);
  expect(payload.type).toBe('text/plain');
  expect(payload.name).toBe('Pi-中文上下文 _ 分享-上下文.txt');
  expect(payload.body).not.toContain('# 选中片段');
  for (const text of ['Initial prompt.', '历史消息 0', '必须保留的压缩摘要。', 'complete-unloaded-input', 'complete-unloaded-tool-output', '[图片未包含]']) expect(payload.body).toContain(text);
  for (const text of ['inactive-branch-must-not-be-exported', 'private-thinking-not-exported', 'private-image-base64-not-exported', 'unsent-draft-must-not-be-exported']) expect(payload.body).not.toContain(text);
  expect(payload.text).toContain('理解上下文');
  if (payload.activated !== undefined) expect(payload.activated).toBe(true);
  expect(requests.filter((url) => isFullContentRequest(url) && new URL(url).pathname !== '/api/session/context')).toEqual([]);
  await dialog.getByRole('button', { name: '关闭分享' }).click();
  await expect(draft).toHaveValue('unsent-draft-must-not-be-exported');
});

test('unsupported file sharing downloads a real UTF-8 TXT and stays usable at 320px with a small viewport', async ({ page, sessionsDir, workingDir }, info) => {
  await mockSharing(page, false);
  const id = contextSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.setViewportSize({ width: 320, height: 380 });
  await openSharing(page);
  const trigger = page.getByRole('button', { name: '分享完整会话', exact: true });
  await expect(page.getByRole('button', { name: '分享已加载上下文', exact: true })).toBeVisible();
  const box = await page.locator('.remote-info-panel').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '分享完整会话' });
  await expect(dialog).toContainText('当前浏览器无法分享此文件');
  await expect(dialog.getByRole('button', { name: '分享 TXT', exact: true })).toHaveCount(0);
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载 TXT' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.txt$/);
  const chunks = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text).toContain(quote);
  expect(text).toContain('Initial prompt.');
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(320);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(380);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('context-share-320.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭分享' }).click();
});

test('cancel and failed native shares never trigger a download and can be retried', async ({ page, sessionsDir, workingDir }, info) => {
  await mockSharing(page);
  const id = contextSession(sessionsDir, workingDir, info);
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await openSharing(page);
  await page.getByRole('button', { name: '分享完整会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享完整会话' });
  const share = dialog.getByRole('button', { name: '分享 TXT', exact: true });
  await expect(share).toBeVisible();
  await page.evaluate(() => { (window as any).__shareError = 'AbortError'; });
  await share.click();
  await expect(share).toBeEnabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__shareError = 'NotAllowedError'; });
  await share.click();
  await expect(dialog.getByRole('alert')).toContainText('可以下载 TXT 后手动添加');
  await page.evaluate(() => { (window as any).__shareError = null; });
  await share.click();
  await expect(share).toBeEnabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(downloads).toEqual([]);
  expect(await page.evaluate(() => (window as any).__shares.length)).toBe(3);
});

test('选中文字不再弹网页菜单，正文与输入框保持原生选区；分享只从更多进入', async ({ page, sessionsDir, workingDir }, info) => {
  await mockSharing(page);
  const id = contextSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const paragraph = page.locator('[data-message-id="selected-message"] p');
  await paragraph.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('group', { name: '选区操作' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '分享完整会话', exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(quote);
  await openSharing(page);
  await page.getByRole('button', { name: '分享完整会话', exact: true }).click();
  await expect(page.locator('.remote-info')).not.toHaveAttribute('open', '');
  const dialog = page.getByRole('dialog', { name: '分享完整会话' });
  await expect(dialog.getByRole('button', { name: '分享 TXT', exact: true })).toBeVisible();
  await expect(dialog.locator('blockquote')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭分享' }).click();
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await draft.fill('保留编辑器的原生复制菜单');
  await draft.evaluate((node: HTMLTextAreaElement) => node.select());
  await expect(page.getByRole('group', { name: '选区操作' })).toHaveCount(0);
  await expect(draft).toHaveValue('保留编辑器的原生复制菜单');
});

test('loaded context shares immediately while offline without fetching full history or folded bodies', async ({ page, context, sessionsDir, workingDir }, info) => {
  await mockSharing(page);
  const id = contextSession(sessionsDir, workingDir, info);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (isFullContentRequest(request.url())) reads.push(request.url());
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('[data-message-id="selected-message"]')).toBeVisible();
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('unsent-draft-must-not-be-exported');
  await openSharing(page);
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: '分享已加载上下文', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__shares?.length)).toBe(1);
    const activated = await page.evaluate(() => (window as any).__shares[0].activated);
    if (activated !== undefined) expect(activated).toBe(true);
    expect(reads).toEqual([]);
    const dialog = page.getByRole('dialog', { name: '分享已加载上下文' });
    await expect(dialog).toContainText('无需联网');
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭分享' }).click();
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('unsent-draft-must-not-be-exported');
  } finally {
    await context.setOffline(false);
  }
  // WebKit's offline adapter also blocks Blob I/O. Read the exact captured File
  // after restoring transport; the share call and no-network assertions stay offline.
  const payload = await sharedPayload(page);
  expect(payload.name).toBe('Pi-中文上下文 _ 分享-已加载上下文.txt');
  expect(payload.body).not.toContain('# 选中片段');
  for (const text of ['当前页面已加载', '历史消息 34', '工具：read', '摘要：example.txt']) expect(payload.body).toContain(text);
  for (const text of ['Initial prompt.', '历史消息 0', '必须保留的压缩摘要。', 'complete-unloaded-input', 'complete-unloaded-tool-output', 'private-thinking-not-exported', 'private-image-base64-not-exported', 'unsent-draft-must-not-be-exported']) expect(payload.body).not.toContain(text);
});

test('loaded context retains previously fetched tool bodies after collapse without fetching them again', async ({ page, context, sessionsDir, workingDir }, info) => {
  await mockSharing(page);
  const id = contextSession(sessionsDir, workingDir, info);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/session\/(context|block)/.test(request.url())) reads.push(request.url());
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const tool = page.locator('[data-message-id="tool-input"] .remote-block-toggle').filter({ hasText: 'read' });
  await tool.click();
  await expect(page.locator('.remote-block-body')).toContainText('complete-unloaded-tool-output');
  await tool.click();
  await expect(page.locator('.remote-block-body')).toHaveCount(0);
  expect(reads).toHaveLength(1);
  await openSharing(page);
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: '分享已加载上下文', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__shares?.length)).toBe(1);
    expect(reads).toHaveLength(1);
  } finally {
    await context.setOffline(false);
  }
  const { body } = await sharedPayload(page);
  expect(body).toContain('complete-unloaded-input');
  expect(body).toContain('complete-unloaded-tool-output');
  expect(body).not.toContain('Initial prompt.');
});

test('loaded fallback downloads only local context and never reuses an earlier full-session file', async ({ page, sessionsDir, workingDir }, info) => {
  await mockSharing(page, false);
  const id = contextSession(sessionsDir, workingDir, info);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/session/context')) reads.push(request.url());
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await openSharing(page);
  await page.getByRole('button', { name: '分享完整会话', exact: true }).click();
  const full = page.getByRole('dialog', { name: '分享完整会话' });
  await expect(full.getByRole('button', { name: '下载 TXT' })).toBeVisible();
  await full.getByRole('button', { name: '关闭分享' }).click();
  expect(reads).toHaveLength(1);
  await page.setViewportSize({ width: 320, height: 380 });
  await openSharing(page);
  const menu = page.locator('.remote-info-panel');
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath('context-menu-320.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '分享已加载上下文', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享已加载上下文' });
  await expect(dialog).toContainText('当前浏览器无法分享此文件');
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载 TXT' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Pi-中文上下文 _ 分享-已加载上下文.txt');
  const chunks = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  expect(body).toContain(quote);
  expect(body).toContain('历史消息 34');
  expect(body).not.toContain('Initial prompt.');
  expect(body).not.toContain('complete-unloaded-tool-output');
  expect(reads).toHaveLength(1);
});

test('preparation failures allow retry and do not expose an empty TXT', async ({ page, sessionsDir, workingDir, request }, info) => {
  await mockSharing(page);
  const id = contextSession(sessionsDir, workingDir, info);
  const response = await request.get(`/api/session/context?id=${encodeURIComponent(id)}`);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect((await response.json()).text).toContain('Initial prompt.');
  expect((await request.post(`/api/session/context?id=${encodeURIComponent(id)}`)).status()).toBe(405);
  expect((await request.get('/api/session/context?id=missing.jsonl')).status()).toBe(404);
  await page.route('**/api/session/context?*', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '测试准备失败' }) }));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await openSharing(page);
  await page.getByRole('button', { name: '分享完整会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享完整会话' });
  await expect(dialog.getByRole('alert')).toContainText('测试准备失败');
  await expect(dialog.locator('blockquote')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '分享 TXT', exact: true })).toHaveCount(0);
  await page.unroute('**/api/session/context?*');
  await dialog.getByRole('button', { name: '重新准备' }).click();
  await expect(dialog.getByRole('button', { name: '分享 TXT', exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
