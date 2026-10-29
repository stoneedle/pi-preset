import { test, expect } from '../lib/test';
import { appendEntry, assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import type { Page, TestInfo } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block' });

test('历史刷新先于上滑事件提交，停在窗口顶端仍继续加载历史', async ({ page, sessionsDir, workingDir }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }));
  const { entries, lastId } = buildSession({ cwd: workingDir });
  let parent = lastId;
  for (let index = 0; index < 85; index++) {
    const next = assistantTextEntry(parent, `更早的历史 ${index}`);
    entries.push(next.entry);
    parent = next.id;
  }
  const latest = assistantTextEntry(parent, '完整长回复不能截断。'.repeat(12000));
  entries.push(latest.entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'coalesced-history'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const main = page.locator('.remote-main');
  await expect(page.locator('article')).toHaveCount(1);
  await expect.poll(() => main.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3);
  await page.evaluate(() => {
    const hold = (event: Event) => {
      if ((event.target as Element).matches?.('.remote-main')) event.stopImmediatePropagation();
    };
    (window as any).__releaseHistoryScroll = () => window.removeEventListener('scroll', hold, true);
    window.addEventListener('scroll', hold, true);
    document.querySelector('.remote-main')!.scrollTop = 0;
  });
  appendEntry(sessionsDir, id, { type: 'session_info', id: 'history-metadata', parentId: latest.id,
    timestamp: new Date().toISOString(), name: '历史刷新已提交' });
  await expect(page.getByRole('heading', { name: '历史刷新已提交', exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('article')).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).__releaseHistoryScroll();
    document.querySelector('.remote-main')!.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.locator('article').count()).toBeGreaterThan(1);
  await expect(page.locator(`[data-message-id="${latest.id}"]`)).toContainText('完整长回复不能截断。');
});

function readingSession(sessionsDir: string, cwd: string, info: TestInfo) {
  const { entries, lastId } = buildSession({ cwd });
  let parent = lastId;
  const ids: string[] = [];
  for (let i = 0; i < 90; i++) {
    const next = assistantTextEntry(parent, Array.from({ length: 8 }, (_, p) => `阅读段落 ${i}-${p}：这是一段需要保留阅读现场的长回复，不能因为后台更新就跳过。`).join('\n\n'));
    ids.push(next.id);
    entries.push(next.entry);
    parent = next.id;
  }
  return { id: writeSession(sessionsDir, uniqueSessionName(info, 'reading'), entries), parent, ids };
}

async function position(page: Page) {
  return page.locator('.remote-main').evaluate((main) => {
    const top = main.getBoundingClientRect().top;
    const paragraph = [...main.querySelectorAll('[data-message-id] p')].find(node => node.getBoundingClientRect().bottom > top + 12)!;
    return { id: paragraph.closest<HTMLElement>('[data-message-id]')!.dataset.messageId!, text: paragraph.textContent!, y: paragraph.getBoundingClientRect().top - top };
  });
}

async function expectPosition(page: Page, saved: Awaited<ReturnType<typeof position>>) {
  const paragraph = page.locator(`[data-message-id="${saved.id}"] p`).filter({ hasText: saved.text });
  await expect(paragraph).toHaveCount(1);
  await expect.poll(async () => Math.abs(await paragraph.evaluate(node => node.getBoundingClientRect().top - node.closest('.remote-main')!.getBoundingClientRect().top) - saved.y)).toBeLessThan(4);
}

async function hidden(page: Page, value: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

test('离开后停旧末尾，点向下或主动滚到底部才恢复跟随', async ({ page, sessionsDir, workingDir, browserName, isMobile }, info) => {
  const session = readingSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
  const saved = await position(page);
  await hidden(page, true);
  const next = assistantTextEntry(session.parent, '后台新增不能替我翻页。\n\n'.repeat(30));
  appendEntry(sessionsDir, session.id, next.entry);
  await page.waitForTimeout(800);
  await hidden(page, false);
  await expect(page.locator(`[data-message-id="${next.id}"]`)).toHaveCount(1);
  await expectPosition(page, saved);
  await page.getByRole('button', { name: '最新消息', exact: true }).click();
  await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
  await page.locator('.remote-main').evaluate(node => { node.scrollTop -= 500; });
  await expect(page.getByRole('button', { name: '最新消息', exact: true })).toBeVisible();
  if (browserName === 'webkit' && isMobile) {
    // Mobile WebKit's automation has no wheel or swipe; exercise touch intent and the real scroll container through DOM.
    await page.locator('.remote-main').evaluate(node => {
      node.dispatchEvent(new Event('touchmove', { bubbles: true }));
      node.scrollTop = node.scrollHeight;
    });
  } else {
    const bounds = await page.locator('.remote-main').boundingBox();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    // Firefox limits each wheel to about a viewport; keep scrolling until the user actually reaches the end.
    await expect.poll(async () => {
      await page.mouse.wheel(0, 1200);
      return page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
    }).toBeLessThan(5);
  }
  await expect(page.getByRole('button', { name: '最新消息', exact: true })).toHaveCount(0);
  const continued = assistantTextEntry(next.id, '主动滚到底部后继续跟随。\n\n'.repeat(20));
  appendEntry(sessionsDir, session.id, continued.entry);
  await expect(page.locator(`[data-message-id="${continued.id}"]`)).toBeVisible();
  await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
});

test('刷新按持久书签直接读取旧位置，不逐页扫历史、不保存正文或草稿', async ({ page, sessionsDir, workingDir }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }));
  const session = readingSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await page.locator(`[data-message-id="${session.ids[72]}"] p`).nth(3).scrollIntoViewIfNeeded();
  const saved = await position(page);
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('只在内存的草稿不可写入阅读书签');
  await expectPosition(page, saved);
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('pi-web:reading') || '{}')[id]?.id, session.id)).toBe(saved.id);
  let parent = session.parent;
  for (let i = 0; i < 60; i++) {
    const next = assistantTextEntry(parent, `刷新前新增 ${i}，不应遮掉旧书签。`);
    appendEntry(sessionsDir, session.id, next.entry);
    parent = next.id;
  }
  const reads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session') reads.push(request.url()); });
  await expectPosition(page, saved);
  await page.reload();
  await expectPosition(page, saved);
  expect(reads.some(url => new URL(url).searchParams.has('around'))).toBe(true);
  expect(reads.filter(url => new URL(url).searchParams.has('before'))).toHaveLength(0);
  expect(await page.locator('[data-message-id]').count()).toBeLessThanOrEqual(32);
  const stored = await page.evaluate(() => localStorage.getItem('pi-web:reading') || '');
  expect(stored).toContain(saved.id);
  expect(stored).not.toContain('阅读段落');
  expect(stored).not.toContain('只在内存的草稿');
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('');
});

test('阅读长回复、输入时顶栏显隐、键盘缩小及选字后仍守住原文字，不因布局变化恢复跟随', async ({ page, sessionsDir, workingDir }, info) => {
  const session = readingSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await page.locator(`[data-message-id="${session.ids[82]}"] p`).nth(3).scrollIntoViewIfNeeded();
  const saved = await position(page);
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await draft.fill('长草稿\n'.repeat(12));
  await expect(page.locator('.remote-header')).toBeHidden();
  await expect(page.getByRole('group', { name: '会话信息', exact: true })).toBeHidden();
  await expectPosition(page, saved);
  await draft.blur();
  await expect(page.locator('.remote-header')).toBeVisible();
  await expectPosition(page, saved);
  await draft.focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 380 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expectPosition(page, saved);
  await page.evaluate(() => {
    delete (window.visualViewport as any).height;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.remote-header')).toBeVisible();
  await expect(draft).toBeFocused();
  await expectPosition(page, saved);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 380 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.remote-header')).toBeHidden();
  await expectPosition(page, saved);
  await page.locator(`[data-message-id="${saved.id}"] p`).first().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.getByRole('group', { name: '选区操作' })).toHaveCount(0);
  const next = assistantTextEntry(session.parent, '选字时不要追到底部。');
  appendEntry(sessionsDir, session.id, next.entry);
  await expect(page.locator(`[data-message-id="${next.id}"]`)).toHaveCount(1);
  await expectPosition(page, saved);
});

test('旧书签的后续按页补取，点最新直接到尾部；不渲染中间全部历史', async ({ page, sessionsDir, workingDir }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }));
  const session = readingSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).evaluate(node => node.click());
    await expect(page.locator('[data-message-id]')).toHaveCount(60 + i * 30);
  }
  await page.locator(`[data-message-id="${session.ids[12]}"] p`).nth(3).scrollIntoViewIfNeeded();
  const saved = await position(page);
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('pi-web:reading') || '{}')[id]?.id, session.id)).toBe(saved.id);
  await page.reload();
  await expectPosition(page, saved);
  expect(await page.locator('[data-message-id]').count()).toBeLessThanOrEqual(30);
  const later = page.getByRole('button', { name: '加载后续消息', exact: true });
  await later.evaluate(node => node.click());
  await expect(page.locator('[data-message-id]')).toHaveCount(60);
  await expectPosition(page, saved);
  await page.getByRole('button', { name: '最新消息', exact: true }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(30);
  await expect(later).toHaveCount(0);
  await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
});

test('书签所在分支消失时回退到最近共同前文，而非新分支末尾', async ({ page, sessionsDir, workingDir }, info) => {
  const session = readingSession(sessionsDir, workingDir, info);
  await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
  await page.locator(`[data-message-id="${session.ids[82]}"] p`).nth(3).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '最新消息', exact: true })).toBeVisible();
  let parent = session.ids[60];
  for (let i = 0; i < 45; i++) {
    const next = assistantTextEntry(parent, '新分支消息 ' + i);
    appendEntry(sessionsDir, session.id, next.entry);
    parent = next.id;
  }
  await page.reload();
  await expect(page.locator(`[data-message-id="${session.ids[60]}"]`)).toBeVisible();
  await expect(page.locator(`[data-message-id="${session.ids[82]}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '加载后续消息', exact: true })).toBeAttached();
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('pi-web:reading') || '{}')[id]?.id, session.id)).toBe(session.ids[60]);
});

for (const kind of ['tool', 'thinking']) {
  test(`阅读折叠${kind === 'tool' ? '工具' : '思考'}摘要时，后台更新和刷新不自动展开或读取正文`, async ({ page, sessionsDir, workingDir }, info) => {
    const { entries, lastId } = buildSession({ cwd: workingDir });
    entries.push({ type: 'message', id: 'folded-reading', parentId: lastId, message: { role: 'assistant', content: kind === 'tool'
      ? [{ type: 'toolCall', id: 'folded-call', name: 'bash', arguments: { command: 'keep-folded' } }]
      : [{ type: 'thinking', thinking: '折叠的思考摘要。\n\n不应自动读取的完整思考。'.repeat(20) }] } });
    if (kind === 'tool') entries.push({ type: 'message', id: 'folded-result', parentId: 'folded-reading', message: { role: 'toolResult', toolCallId: 'folded-call', content: [{ type: 'text', text: '不应自动读取的工具正文。' }] } });
    const tail = assistantTextEntry(kind === 'tool' ? 'folded-result' : 'folded-reading', '摘要之后的长回复。\n\n'.repeat(80));
    entries.push(tail.entry);
    const id = writeSession(sessionsDir, uniqueSessionName(info, 'folded-reading'), entries);
    const reads: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/session/block') reads.push(request.url()); });
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const toggle = page.locator('[data-message-id="folded-reading"] .remote-block-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
    await toggle.evaluate(node => {
      const main = node.closest('.remote-main')!;
      main.scrollTop += node.getBoundingClientRect().top - main.getBoundingClientRect().top;
    });
    await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('pi-web:reading') || '{}')[id]?.id, id)).toBe('folded-reading');
    appendEntry(sessionsDir, id, assistantTextEntry(tail.id, '后台更新，不应展开摘要。').entry);
    await expect(page.getByText('后台更新，不应展开摘要。', { exact: true })).toBeAttached();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(reads).toHaveLength(0);
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: '最新消息', exact: true })).toBeVisible();
    expect(reads).toHaveLength(0);
  });
}

test('工具正文的段落坐标跨后台更新和刷新恢复，只展开并补取正在阅读的块', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'reading-tool', parentId: lastId, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'reading-call', name: 'bash', arguments: { command: 'reading-body' } }] } });
  entries.push({ type: 'message', id: 'reading-result', parentId: 'reading-tool', message: { role: 'toolResult', toolCallId: 'reading-call', content: [{ type: 'text', text: Array.from({ length: 250 }, (_, i) => `工具阅读行 ${i}：需要保留正文中的当前位置。`).join('\n') }] } });
  const tail = assistantTextEntry('reading-result', '工具后的普通回复。');
  entries.push(tail.entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'tool-reading'), entries);
  const reads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session/block') reads.push(request.url()); });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const toggle = page.getByRole('button', { name: /bash reading-body/ });
  await toggle.click();
  const body = page.locator('.remote-block-body > pre').filter({ hasText: '工具阅读行 120' });
  await expect(body).toBeAttached();
  await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await body.evaluate(node => {
    const main = node.closest('.remote-main')!;
    main.scrollTop += node.getBoundingClientRect().top - main.getBoundingClientRect().top + 1100;
  });
  await expect(page.getByRole('button', { name: '最新消息', exact: true })).toBeVisible();
  const offset = () => body.evaluate(node => node.getBoundingClientRect().top - node.closest('.remote-main')!.getBoundingClientRect().top);
  const saved = await offset();
  await hidden(page, true);
  appendEntry(sessionsDir, id, assistantTextEntry(tail.id, '工具之外的后台新增。\n\n'.repeat(40)).entry);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toBeAttached();
  await expect.poll(async () => Math.abs(await offset() - saved)).toBeLessThan(4);
  expect(reads).toHaveLength(2);
});

for (const removed of [true, false]) {
  test(`书签消息${removed ? '删除' : '变空'}后恢复最近仍在的前文，不跳到末尾`, async ({ page, sessionsDir, workingDir }, info) => {
    const session = readingSession(sessionsDir, workingDir, info);
    await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
    await page.locator(`[data-message-id="${session.ids[82]}"] p`).nth(3).scrollIntoViewIfNeeded();
    const saved = await position(page);
    const previous = session.ids[session.ids.indexOf(saved.id) - 1];
    await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('pi-web:reading') || '{}')[id]?.previous?.[0], session.id)).toBe(previous);
    await hidden(page, true);
    const path = join(sessionsDir, '--home-user-demo-project--', session.id);
    const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const updated = entries.filter(entry => !removed || entry.id !== saved.id).map(entry => {
      if (entry.parentId === saved.id && removed) entry.parentId = previous;
      if (entry.id === saved.id) entry.message.content = [];
      return entry;
    });
    writeFileSync(path, updated.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await page.reload();
    await expect(page.locator(`[data-message-id="${previous}"]`)).toBeVisible();
    await expect(page.locator(`[data-message-id="${saved.id}"]`)).toHaveCount(0);
    await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(1000);
    await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('pi-web:reading') || '{}')[id]?.id, session.id)).toBe(previous);
  });
}

test('失败与排队守住阅读现场，只有普通发送确认成功才恢复跟随', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const session = readingSession(sessionsDir, workingDir, info);
  let parent = session.parent;
  const submitted: string[] = [];
  const owner = await openFixtureOwner({
    agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', session.id),
    getState: () => ({ state: 'running', mainRunning: true, canQueue: true }),
    control: async (input: any) => {
      if (input.action === 'send') {
        submitted.push(input.chat.delivery);
        const next = assistantTextEntry(parent, input.chat.message);
        appendEntry(sessionsDir, session.id, next.entry);
        parent = next.id;
        owner.publish();
      }
      return { status: 'accepted' };
    },
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(session.id)}`);
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    await page.locator(`[data-message-id="${session.ids[82]}"] p`).nth(3).scrollIntoViewIfNeeded();
    const saved = await position(page);
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
    const send = page.getByRole('button', { name: '发送', exact: true });
    await page.route('**/api/chat?*', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '测试发送失败' }) }));
    await draft.fill('失败不该跳转');
    await send.click();
    await expect(page.locator('[data-recovery-message]')).toHaveCount(1);
    await expectPosition(page, saved);
    await page.unroute('**/api/chat?*');
    await draft.fill('排队不该跳转');
    await send.press('Shift+F10');
    await page.getByRole('menuitem', { name: '排队', exact: true }).click();
    await expect(draft).toHaveValue('');
    await expectPosition(page, saved);
    expect(submitted).toEqual(['followUp']);
    await draft.fill('主动发送成功才追到最新');
    await send.click();
    await expect(draft).toHaveValue('');
    await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
    const next = assistantTextEntry(parent, '发送成功后继续跟随生成。\n\n'.repeat(20));
    appendEntry(sessionsDir, session.id, next.entry);
    owner.publish();
    await expect(page.locator(`[data-message-id="${next.id}"]`)).toBeVisible();
    await expect.poll(() => page.locator('.remote-main').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(5);
  } finally { await owner.close(); }
});
