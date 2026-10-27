import { test, expect } from '../lib/test';
import { assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

function historySession(sessionsDir: string, cwd: string, info: Parameters<typeof uniqueSessionName>[0], count = 95) {
  const { entries, lastId } = buildSession({ cwd });
  let parent = lastId;
  for (let index = 0; index < count; index++) {
    const next = assistantTextEntry(parent, `预取历史 ${index}。这里保留足够的正文用于在真实窄屏中阅读和定位。`);
    entries.push(next.entry);
    parent = next.id;
  }
  return writeSession(sessionsDir, uniqueSessionName(info, 'history-prefetch'), entries);
}

async function navigate(page: Page, id: string) {
  await page.evaluate((id) => {
    history.pushState(null, '', '/session?id=' + encodeURIComponent(id));
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, id);
}

async function anchor(page: Page) {
  return page.locator('.remote-main').evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const node = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((node) => node.getBoundingClientRect().bottom > top)!;
    return { id: node.dataset.messageId!, y: node.getBoundingClientRect().top };
  });
}

async function saveData(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: Object.assign(new EventTarget(), { saveData: true }) });
  });
}

test('空闲逐页预取完整近期历史，保持底部且断网分享包含补取的上下文', async ({ page, context, sessionsDir, workingDir }, info) => {
  const id = historySession(sessionsDir, workingDir, info);
  let historicalResponses = 0;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/session' && url.searchParams.has('before')) historicalResponses++;
  });
  const extra: string[] = [];
  page.on('request', (request) => { if (/\/api\/session\/(block|image|context)/.test(request.url())) extra.push(request.url()); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => { (window as any).__shared = data.files![0]; } });
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await expect.poll(() => historicalResponses, { timeout: 20000 }).toBe(3);
  await page.waitForTimeout(200);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toBeAttached();
  await expect.poll(() => page.locator('.remote-main').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
  await context.setOffline(true);
  try {
    await page.locator('[data-message-id]').last().locator('.remote-markdown').evaluate((node) => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.getByRole('button', { name: '分享已加载上下文', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__shared))).toBe(true);
    expect(extra).toEqual([]);
  } finally { await context.setOffline(false); }
  const body = await page.evaluate(() => (window as any).__shared.text());
  for (const text of ['Initial prompt.', '预取历史 0', '预取历史 94']) expect(body).toContain(text);
});

test('大历史超过旧预算仍能预取分享，不提前渲染也不截断正文', async ({ page, context, sessionsDir, workingDir }, info) => {
  test.setTimeout(45000);
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const text = '历史大正文保持原样。'.repeat(100000) + 'END-OF-PREFETCHED-LARGE-BODY';
  const large = assistantTextEntry(lastId, text);
  entries.push(large.entry);
  let parent = large.id;
  for (let index = 0; index < 40; index++) {
    const next = assistantTextEntry(parent, `后续普通消息 ${index}`);
    entries.push(next.entry); parent = next.id;
  }
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'large-prefetch'), entries);
  let historicalResponses = 0;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/session' && url.searchParams.has('before')) historicalResponses++;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => { (window as any).__shared = data.files![0]; } });
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await expect.poll(() => historicalResponses, { timeout: 20000 }).toBe(2);
  await page.waitForTimeout(200);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await expect(page.locator(`[data-message-id="${large.id}"]`)).toHaveCount(0);
  await context.setOffline(true);
  try {
    await page.locator('[data-message-id]').last().locator('.remote-markdown').evaluate((node) => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.getByRole('button', { name: '分享已加载上下文', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__shared))).toBe(true);
  } finally { await context.setOffline(false); }
  const body = await page.evaluate(() => (window as any).__shared.text());
  expect(body).toContain(text);
});

test('离开后继续预取近期会话，离线返回保留草稿及消息锚点而非旧像素位置', async ({ page, context, sessionsDir, workingDir }, info) => {
  const first = historySession(sessionsDir, workingDir, info);
  const other = historySession(sessionsDir, workingDir, info, 1);
  let historicalResponses = 0;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/session' && url.searchParams.get('id') === first && url.searchParams.has('before')) historicalResponses++;
  });
  await page.goto(`/session?id=${encodeURIComponent(first)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('离线返回仍保留的草稿');
  await page.locator('.remote-main').evaluate((node) => { node.scrollTop -= 240; });
  const reading = await anchor(page);
  await navigate(page, other);
  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  await expect.poll(() => historicalResponses, { timeout: 20000 }).toBe(3);
  // Let the final response commit before disabling transport.
  await page.waitForTimeout(200);
  await context.setOffline(true);
  try {
    await navigate(page, first);
    await expect(page.locator('[data-message-id]')).toHaveCount(30);
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('离线返回仍保留的草稿');
    await expect.poll(async () => Math.abs((await page.locator(`[data-message-id="${reading.id}"]`).boundingBox())!.y - reading.y)).toBeLessThan(3);
    await page.locator('.remote-main').evaluate((node) => { node.scrollTop = 400; });
    await expect(page.locator('[data-message-id]')).toHaveCount(60);
    expect(historicalResponses).toBe(3);
  } finally { await context.setOffline(false); }
});

test('向上滚动提前单飞加载，慢响应以提交时的阅读位置为锚点', async ({ page, sessionsDir, workingDir }, info) => {
  await saveData(page); // Suppress speculation, not explicit reading.
  const id = historySession(sessionsDir, workingDir, info, 140);
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/session?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('before')) { reads++; await gate; }
    await route.continue();
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  const main = page.locator('.remote-main');
  await main.evaluate((node) => { node.scrollTop = Math.min(500, node.clientHeight); });
  await expect.poll(() => reads).toBe(1);
  await main.evaluate((node) => { node.scrollTop -= 120; });
  await page.waitForTimeout(100);
  const reading = await anchor(page);
  expect(reads).toBe(1);
  release();
  await expect(page.locator('[data-message-id]')).toHaveCount(60);
  await expect.poll(async () => Math.abs((await page.locator(`[data-message-id="${reading.id}"]`).boundingBox())!.y - reading.y)).toBeLessThan(3);
  expect(reads).toBe(1);
  await main.evaluate((node) => { node.scrollTop = Math.min(500, node.clientHeight); });
  await expect(page.locator('[data-message-id]')).toHaveCount(90);
  expect(reads).toBe(2);
});

test('前台发送中止后台预取，不显示取消错误也不重复投递', async ({ page, sessionsDir, workingDir }, info) => {
  const id = historySession(sessionsDir, workingDir, info);
  await page.addInitScript(() => {
    const native = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/session' && url.searchParams.has('before')) {
        (window as any).__historyStarted = true;
        return new Promise((_resolve, reject) => {
          args[1]!.signal!.addEventListener('abort', () => {
            (window as any).__historyAborted = true;
            reject(args[1]!.signal!.reason);
          });
        });
      }
      return native(...args);
    };
  });
  const sends: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/chat') sends.push(request.url()); });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.waitForFunction(() => (window as any).__historyStarted);
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('foreground-wins-over-prefetch');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => (window as any).__historyAborted);
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('');
  await expect(page.locator('.remote-main [role=alert]')).toHaveCount(0);
  expect(sends).toHaveLength(1);
});

test('预取失败静默退避，主动滚动失败可重试且保留已有内容', async ({ page, sessionsDir, workingDir }, info) => {
  const id = historySession(sessionsDir, workingDir, info);
  let fail = true;
  let reads = 0;
  await page.route('**/api/session?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('before')) {
      reads++;
      if (fail) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '历史暂不可用' }) });
    }
    return route.continue();
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect.poll(() => reads).toBe(1);
  await page.waitForTimeout(2000);
  expect(reads).toBe(1);
  await expect(page.locator('.remote-main [role=alert]')).toHaveCount(0);
  await page.locator('.remote-main').evaluate((node) => { node.scrollTop = 400; });
  await expect(page.locator('.remote-main [role=alert]')).toContainText('历史暂不可用');
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  const failedReads = reads;
  await page.waitForTimeout(500);
  expect(reads).toBe(failedReads);
  fail = false;
  // DOM activation keeps the current reading anchor; the fallback remains a real button.
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).evaluate((node: HTMLButtonElement) => node.click());
  await expect(page.locator('[data-message-id]')).toHaveCount(60);
  await expect(page.locator('.remote-main [role=alert]')).toHaveCount(0);
});
