import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession, assistantTextEntry } from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block' });

const sessionPath = (directory: string, id: string) => join(directory, '--home-user-demo-project--', id);
const entries = (directory: string, id: string) => readFileSync(sessionPath(directory, id), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const ownerPath = (directory: string, id: string) => join(directory, 'pi-web', 'owners', id + '.json');

async function chooseFork(page: any, label: string) {
  const response = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/session/fork');
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(201);
  const { id } = await result.json();
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(id));
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('');
  return id;
}

async function longPress(page: any, row: any, label = '会话操作') {
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (page.context().browser()?.browserType().name() === 'chromium' && await page.evaluate(() => navigator.maxTouchPoints > 0)) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 30, y: box.y + box.height / 2 }] });
      await expect(page.getByRole('menu', { name: label, exact: true })).toBeVisible();
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await client.detach(); }
  } else {
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.getByRole('menu', { name: label, exact: true })).toBeVisible();
    await page.mouse.up();
  }
}

test('用户长按复制与模型直达图标离线可用，复制完整Markdown且失败可重试', async ({ page, context, sessionsDir, workingDir }, info) => {
  const native = buildSession({ cwd: workingDir });
  const userText = '**原始提问**\n\n保留完整 Markdown。';
  const replyText = '## 原始回复\n\n包含 **格式**。';
  (native.entries[1].message as any).content = [{ type: 'text', text: userText }];
  (native.entries[2].message as any).content = [
    { type: 'thinking', thinking: '不应复制的思考' },
    { type: 'text', text: replyText },
    { type: 'text', text: '回复末尾。' },
  ];
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'message-actions'), native.entries);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if ((window as any).denyCopy) throw new Error('denied');
        (window as any).copiedText = text;
      },
    } });
  });
  await page.setViewportSize({ width: 320, height: 430 });
  await page.goto('/session?id=' + encodeURIComponent(id));
  const user = page.locator('.remote-user');
  const assistant = page.locator('article[aria-label="Pi"]').last();
  await expect(assistant.locator('.remote-message-actions button')).toHaveCount(2);
  await expect(user.getByRole('button')).toHaveCount(0);
  await expect(assistant.getByRole('button', { name: '从这里分叉', exact: true })).toBeVisible();
  await context.setOffline(true);
  await longPress(page, user, '消息操作');
  const menu = page.getByRole('menu', { name: '消息操作', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
  await expect(menu).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).copiedText)).toBe(userText);
  await page.evaluate(() => (window as any).denyCopy = true);
  await assistant.getByRole('button', { name: '复制', exact: true }).click();
  await expect(assistant.getByRole('alert')).toContainText('复制失败');
  await page.evaluate(() => (window as any).denyCopy = false);
  await assistant.getByRole('button', { name: '复制', exact: true }).locator('svg').click();
  await expect(assistant.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await expect(assistant.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).copiedText)).toBe(replyText + '\n\n回复末尾。');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('message-actions-copy-320.png'), animations: 'disabled' });
});

test('工具穿插说明的复制尾随正文，320px自然换行且每段离线独立复制', async ({ page, context, sessionsDir, workingDir }, info) => {
  const native = buildSession({ cwd: workingDir });
  const texts = [
    '**先检查**。\n\n再验证。',
    '这段较长说明保持完整阅读，不会给右侧图标预留整列空白。\n\n这段文字填满一行后复制图标换行',
    '- 列表一\n- 列表二',
    '```text\n' + 'long-code-'.repeat(40) + '\n```',
  ];
  native.entries.push({ type: 'message', id: 'inline-copy', parentId: native.lastId, message: {
    role: 'assistant', stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: '不应复制的思考' },
      { type: 'text', text: '**先检查**。' },
      { type: 'text', text: '再验证。' },
      { type: 'toolCall', id: 'inline-tool-0', name: 'bash', arguments: { command: 'echo first' } },
      ...texts.slice(1).flatMap((text, index) => [
        { type: 'text', text },
        { type: 'toolCall', id: `inline-tool-${index + 1}`, name: 'bash', arguments: { command: 'echo next' } },
      ]),
    ],
  } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'inline-copy'), native.entries);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if ((window as any).denyCopy) throw new Error('denied');
        (window as any).copiedText = text;
      },
    } });
  });
  await page.setViewportSize({ width: 320, height: 430 });
  await page.goto('/session?id=' + encodeURIComponent(id));
  const article = page.locator('[data-message-id="inline-copy"]');
  const bodies = article.locator(':scope > .remote-markdown');
  await expect(bodies).toHaveCount(4);
  await expect(article.locator('.remote-message-actions')).toHaveCount(0);
  await expect(article.getByRole('button', { name: '从这里分叉', exact: true })).toHaveCount(0);
  for (let index = 0; index < texts.length; index++) {
    const body = bodies.nth(index);
    await expect(body.getByRole('button', { name: '复制', exact: true })).toHaveCount(1);
    const layout = await body.evaluate((node) => {
      const button = node.querySelector('button')!.getBoundingClientRect();
      const tool = node.nextElementSibling!.getBoundingClientRect();
      return { width: button.width, height: button.height, beforeTool: button.bottom <= tool.top };
    });
    expect(layout).toEqual({ width: 44, height: 44, beforeTool: true });
  }
  for (const { width, index } of [393, 320].flatMap((width) => [0, 1].map((index) => ({ width, index })))) {
    await page.setViewportSize({ width, height: 430 });
    const body = bodies.nth(index);
    await body.getByRole('button', { name: '复制', exact: true }).scrollIntoViewIfNeeded();
    const layout = await body.evaluate((node) => {
      const paragraph = [...node.querySelectorAll('p')].at(-1)!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const line = [...range.getClientRects()].at(-1)!;
      const button = node.querySelector('button')!.getBoundingClientRect();
      const icon = node.querySelector('button svg')!.getBoundingClientRect();
      return {
        sameLine: icon.top + icon.height / 2 >= line.top && icon.top + icon.height / 2 <= line.bottom,
        wraps: button.top >= line.bottom,
        withinBody: button.right <= node.getBoundingClientRect().right,
        iconGap: icon.left - line.right,
        wrappedInset: icon.left - node.getBoundingClientRect().left,
      };
    });
    const wraps = width === 320 && index === 1;
    expect(layout.sameLine).toBe(!wraps);
    expect(layout.wraps).toBe(wraps);
    expect(layout.withinBody).toBe(true);
    if (!wraps) {
      expect(layout.iconGap).toBeGreaterThanOrEqual(0);
      expect(layout.iconGap).toBeLessThanOrEqual(8);
    } else {
      expect(layout.wrappedInset).toBeGreaterThanOrEqual(0);
      expect(layout.wrappedInset).toBeLessThanOrEqual(2);
    }
    await page.screenshot({ path: info.outputPath(`inline-copy-${index === 0 ? 'short' : 'long'}-${width}.png`), animations: 'disabled' });
  }
  await expect(bodies.nth(2).locator('li')).toHaveCount(2);
  expect(await bodies.nth(3).locator('pre').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await context.setOffline(true);
  await page.evaluate(() => (window as any).denyCopy = true);
  await bodies.first().getByRole('button', { name: '复制', exact: true }).click();
  await expect(bodies.first().getByRole('alert')).toContainText('复制失败');
  await page.evaluate(() => (window as any).denyCopy = false);
  for (let index = 0; index < texts.length; index++) {
    await bodies.nth(index).getByRole('button', { name: '复制', exact: true }).click();
    expect(await page.evaluate(() => (window as any).copiedText)).toBe(texts[index]);
    await expect(bodies.nth(index).getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    await expect(bodies.nth(index).getByRole('alert')).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('列表长按分叉完整活动分支，独立JSONL与原草稿附件保留，发送才启动', async ({ page, sessionsDir, workingDir, agentDir }, info) => {
  const id = uniqueSessionName(info, 'fork-list');
  const native = buildSession({ cwd: workingDir });
  let parent = native.lastId;
  for (let i = 0; i < 42; i++) {
    const next = assistantTextEntry(parent, `历史回复 ${i}`);
    native.entries.push(next.entry); parent = next.id;
  }
  native.entries.push({ type: 'session_info', id: 'name', parentId: parent, timestamp: new Date().toISOString(), name: '分叉源会话' });
  writeSession(sessionsDir, id, native.entries);
  const original = readFileSync(sessionPath(sessionsDir, id), 'utf8');
  await page.goto('/session?id=' + encodeURIComponent(id));
  await expect(page.getByText('历史回复 41', { exact: true })).toBeVisible();
  await expect(page.getByText('Initial prompt.', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('留在原会话的草稿');
  await page.locator('input[type=file]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDYsAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const row = page.locator(`.remote-session-row[data-session-id="${id}"] a`);
  await longPress(page, row);
  const forkID = await chooseFork(page, '分叉为新会话');
  const copied = entries(sessionsDir, forkID);
  expect(copied[0].id).not.toBe(native.entries[0].id);
  expect(copied[0].parentSession).toBe(sessionPath(sessionsDir, id));
  expect(copied[0].cwd).toBe(workingDir);
  expect(copied.slice(1, -1)).toEqual(native.entries.slice(1));
  expect(copied.at(-1).name).toBe('分叉源会话 · 分支');
  expect(existsSync(ownerPath(agentDir, id))).toBe(false);
  expect(existsSync(ownerPath(agentDir, forkID))).toBe(false);
  await page.goBack();
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('留在原会话的草稿');
  await expect(page.getByRole('button', { name: '查看图片：draft.png', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('button', { name: '查看图片：draft.png', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('只在新分支继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Stub reply: 只在新分支继续', { exact: true })).toBeVisible();
  expect(existsSync(ownerPath(agentDir, forkID))).toBe(true);
  expect(existsSync(ownerPath(agentDir, id))).toBe(false);
  expect(readFileSync(sessionPath(sessionsDir, id), 'utf8')).toBe(original);
});

test('消息菜单按原生节点包含式分叉，工具中途无入口，320px键盘缩小仍可用', async ({ page, request, sessionsDir, workingDir, agentDir }, info) => {
  const id = uniqueSessionName(info, 'fork-node');
  const native = buildSession({ cwd: workingDir });
  const userID = String(native.entries[1].id);
  const call = { type: 'message', id: 'call', parentId: native.lastId, timestamp: new Date().toISOString(), message: {
    role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: '执行工具前的说明' }, { type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'echo fork' } }],
  } };
  const result = { type: 'message', id: 'result', parentId: 'call', timestamp: new Date().toISOString(), message: { role: 'toolResult', toolCallId: 'tool', toolName: 'bash', content: [{ type: 'text', text: 'fork output' }] } };
  const final = assistantTextEntry('result', '完整工具后的回复');
  const later = assistantTextEntry(final.id, '这条不应复制到旧节点分支');
  native.entries.push(call, result, final.entry, later.entry);
  writeSession(sessionsDir, id, native.entries);
  const original = readFileSync(sessionPath(sessionsDir, id), 'utf8');
  await page.setViewportSize({ width: 320, height: 430 });
  await page.goto('/session?id=' + encodeURIComponent(id));
  await expect(page.locator('[data-message-id="call"]')).toContainText('执行工具前的说明');
  await expect(page.locator('[data-message-id="call"]').getByRole('button', { name: '从这里分叉', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-message-id="call"]').getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).copiedText = text; },
    } });
  });
  await page.locator('[data-message-id="call"]').getByRole('button', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedText)).toBe('执行工具前的说明');
  await expect(page.locator(`[data-message-id="${userID}"] .remote-message-actions`)).toHaveCount(0);
  for (const { width, entryId } of [393, 320].flatMap((width) => [final.id, later.id].map((entryId) => ({ width, entryId })))) {
    await page.setViewportSize({ width, height: 430 });
    const layout = await page.locator(`[data-message-id="${entryId}"]`).evaluate((article) => {
      const content = article.querySelector('.remote-markdown')!.getBoundingClientRect();
      const buttons = [...article.querySelectorAll('.remote-message-actions button')];
      const [copy, fork] = buttons.map((button) => button.getBoundingClientRect());
      const [copyIcon, forkIcon] = buttons.map((button) => button.querySelector('svg')!.getBoundingClientRect());
      return {
        belowContent: copy.top >= content.bottom,
        contentRight: content.right,
        availableRight: article.getBoundingClientRect().right,
        buttonSizes: buttons.map((button) => {
          const { width, height } = button.getBoundingClientRect();
          return { width, height };
        }),
        targetsSeparate: copy.right <= fork.left,
        iconDistance: forkIcon.x + forkIcon.width / 2 - copyIcon.x - copyIcon.width / 2,
        iconInset: copyIcon.left - article.getBoundingClientRect().left,
        targetsOnScreen: copy.left >= 0 && fork.right <= innerWidth,
      };
    });
    expect(layout.belowContent).toBe(true);
    expect(layout.contentRight).toBeCloseTo(layout.availableRight, 1);
    expect(layout.buttonSizes).toEqual([{ width: 44, height: 44 }, { width: 44, height: 44 }]);
    expect(layout.targetsSeparate).toBe(true);
    expect(layout.iconDistance).toBe(32);
    expect(layout.iconInset).toBeCloseTo(0, 1);
    expect(layout.targetsOnScreen).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const message = page.locator(`[data-message-id="${final.id}"]`);
  await message.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('fork-message-320.png'), animations: 'disabled' });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/fork');
  await message.getByRole('button', { name: '从这里分叉', exact: true }).locator('svg').click();
  const forked = await response;
  expect(forked.status(), await forked.text()).toBe(201);
  const forkID = (await forked.json()).id;
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(forkID));
  const copied = entries(sessionsDir, forkID);
  expect(copied.slice(1, -1)).toEqual(native.entries.slice(1, -1));
  await expect(page.getByText('完整工具后的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('这条不应复制到旧节点分支', { exact: true })).toHaveCount(0);
  expect(existsSync(ownerPath(agentDir, forkID))).toBe(false);
  await page.goBack();
  const user = page.locator(`[data-message-id="${userID}"]`);
  await longPress(page, user, '消息操作');
  const menu = page.getByRole('menu', { name: '消息操作', exact: true });
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(430);
  await page.screenshot({ path: info.outputPath('fork-user-menu-320.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await user.focus();
  await page.keyboard.press('Shift+F10');
  const userFork = await chooseFork(page, '从这里分叉');
  expect(entries(sessionsDir, userFork).slice(1, -1)).toEqual([native.entries[1]]);
  await expect(page.getByText('Initial prompt.', { exact: true })).toBeVisible();
  await expect(page.getByText('Initial reply.', { exact: true })).toHaveCount(0);
  for (const entryId of ['call', 'result', 'missing']) {
    expect((await request.post('/api/session/fork?id=' + encodeURIComponent(id), { data: { entryId } })).status()).toBe(409);
  }
  expect(readFileSync(sessionPath(sessionsDir, id), 'utf8')).toBe(original);
});

test('在线分叉取真实叶节点且不发送控制，空根和未完成工具明确拒绝', async ({ request, sessionsDir, workingDir, agentDir }, info) => {
  const id = uniqueSessionName(info, 'fork-live');
  const native = buildSession({ cwd: workingDir });
  const later = assistantTextEntry(native.lastId, '磁盘尾部不是当前分支');
  const call = { type: 'message', id: 'pending-call', parentId: later.id, timestamp: new Date().toISOString(), message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'pending', name: 'bash', arguments: { command: 'waiting' } }] } };
  native.entries.push(later.entry, call);
  writeSession(sessionsDir, id, native.entries);
  let leafId: string | null = native.lastId;
  const controls: any[] = [];
  const owner = await openFixtureOwner({ agentDir, sessionPath: sessionPath(sessionsDir, id), getState: () => ({ state: 'running', leafId }), control: (input: any) => { controls.push(input); return {}; } });
  const original = readFileSync(sessionPath(sessionsDir, id), 'utf8');
  try {
    const response = await request.post('/api/session/fork?id=' + encodeURIComponent(id), { data: {} });
    expect(response.status(), await response.text()).toBe(201);
    const forkID = (await response.json()).id;
    expect(entries(sessionsDir, forkID).slice(1, -1)).toEqual(native.entries.slice(1, 3));
    for (const nextLeaf of [null, 'pending-call']) {
      leafId = nextLeaf;
      expect((await request.post('/api/session/fork?id=' + encodeURIComponent(id), { data: {} })).status()).toBe(409);
    }
    leafId = native.lastId;
    expect((await request.post('/api/session/fork?id=' + encodeURIComponent(id), { data: { entryId: later.id } })).status()).toBe(409);
    expect(readFileSync(sessionPath(sessionsDir, id), 'utf8')).toBe(original);
    expect(controls).toEqual([]);
    expect(existsSync(ownerPath(agentDir, forkID))).toBe(false);
  } finally { await owner.close(); }
});

test('分叉失败不重放，重复点击单飞，离开后迟到成功不抢回会话', async ({ page, sessionsDir, workingDir }, info) => {
  const id = uniqueSessionName(info, 'fork-network');
  const native = buildSession({ cwd: workingDir });
  writeSession(sessionsDir, id, native.entries);
  const countFiles = () => readdirSync(join(sessionsDir, '--home-user-demo-project--')).length;
  const initialCount = countFiles();
  await page.goto('/');
  await page.locator(`.remote-session-row[data-session-id="${id}"] a`).click();
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('网络故障不能丢失的草稿');
  let posts = 0;
  await page.route('**/api/session/fork?*', async (route) => {
    posts++;
    await route.fulfill({ status: 503, json: { error: '测试分叉失败' } });
  });
  await page.locator('article').last().getByRole('button', { name: '从这里分叉', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '测试分叉失败' })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(posts).toBe(1);
  expect(countFiles()).toBe(initialCount);
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('网络故障不能丢失的草稿');
  await page.unroute('**/api/session/fork?*');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/session/fork?*', async (route) => {
    posts++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.locator('article').last().getByRole('button', { name: '从这里分叉', exact: true }).click();
  await expect(page.locator('article').last().getByRole('button', { name: '正在分叉…', exact: true })).toBeDisabled();
  await expect.poll(countFiles).toBe(initialCount + 1);
  await page.goBack();
  await expect(page).toHaveURL('/');
  release();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL('/');
  expect(posts).toBe(2);
  expect(countFiles()).toBe(initialCount + 1);
  await page.goForward();
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('网络故障不能丢失的草稿');
});
