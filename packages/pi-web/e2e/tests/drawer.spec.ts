import { test, expect } from '../lib/test';
import { assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import type { Locator } from '@playwright/test';

async function touch(target: Locator, type: string, x: number, y = 180, fingers = 1) {
  return target.evaluate((node, { type, x, y, fingers }) => {
    const point = { identifier: 1, clientX: x, clientY: y };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: /end|cancel/.test(type) ? [] : Array(fingers).fill(point) },
      changedTouches: { value: [point] },
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, x, y, fingers });
}

test('抽屉顶部单行图标，点击搜索同步展开并聚焦，窄屏键盘下不另起一行', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'drawer-toolbar'), buildSession({ cwd: workingDir }).entries);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const trigger = page.getByRole('button', { name: '会话列表', exact: true });
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  const header = drawer.locator(':scope > header');
  const searchButton = header.getByRole('button', { name: '搜索会话', exact: true });
  const search = header.getByRole('searchbox', { name: '搜索会话', exact: true });
  const composer = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await composer.fill('收起抽屉后保留会话草稿');
  await composer.blur();
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(search).toHaveCount(0);
  expect(await header.getByRole('button').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))).toEqual(['搜索会话', '只看活跃会话', '已归档', '新建会话', '关闭会话列表']);
  await expect(drawer.locator('.remote-search, .remote-drawer-new, h2')).toHaveCount(0);
  const height = (await header.boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(64);
  await page.screenshot({ path: info.outputPath('drawer-toolbar-320.png'), animations: 'disabled' });

  // Focus must occur before this trusted click finishes, not after a tick or animation.
  await page.evaluate(() => document.addEventListener('click', () => {
    const input = document.querySelector<HTMLInputElement>('#remote-drawer-search');
    (window as any).drawerSearchFocus = {
      focused: input === document.activeElement,
      caret: input?.selectionStart,
      activation: navigator.userActivation.isActive,
    };
  }, { once: true }));
  await searchButton.click();
  expect(await page.evaluate(() => (window as any).drawerSearchFocus)).toEqual({ focused: true, caret: 0, activation: true });
  await expect(search).toBeFocused();
  expect((await header.boundingBox())!.height).toBe(height);
  await search.fill(id);
  await expect(drawer.locator('.remote-session')).toHaveCount(1);
  await search.evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 0));
  await search.blur();
  await searchButton.click();
  await expect(search).toBeFocused();
  expect(await search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([id.length, id.length]);

  await header.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(composer).toHaveValue('收起抽屉后保留会话草稿');
  await trigger.click();
  await expect(search).toHaveValue(id);
  await expect(search).not.toBeFocused();
  await searchButton.click();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().height)).toBe(360);
  const bounds = await header.getByRole('button').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  }));
  expect(new Set(bounds.map((box) => box.y)).size).toBe(1);
  expect(bounds.every((box) => box.width >= 44 && box.height >= 44 && box.x >= 0 && box.right <= 320 && box.bottom <= 360)).toBe(true);
  expect(await drawer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await drawer.locator('.remote-list-main').evaluate((node) => node.clientHeight)).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('drawer-toolbar-search-320-keyboard.png'), animations: 'disabled' });
  await header.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(search).toHaveValue('');
  await search.fill('归档区的独立搜索');
  await header.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(search).toHaveValue(id);
  expect((await header.boundingBox())!.height).toBe(height);
  await expect(composer).toHaveValue('收起抽屉后保留会话草稿');

  await header.getByRole('button', { name: '新建会话', exact: true }).click();
  const newTask = page.getByRole('dialog', { name: '新对话', exact: true });
  await expect(newTask).toBeVisible();
  await expect(newTask.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toBeFocused();
  await expect(drawer).not.toBeVisible();
  await newTask.getByRole('button', { name: '关闭新对话', exact: true }).click();
  await expect(newTask).not.toBeVisible();
  await trigger.click();
  await expect(search).toHaveValue(id);
  await search.fill('');
  await header.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await trigger.click();
  await expect(search).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(composer).toHaveValue('收起抽屉后保留会话草稿');
});

test('drawer follows the finger in both directions and rolls back incomplete gestures', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'drawer-tracking'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const main = page.locator('.remote-main');
  const drawer = page.locator('.remote-drawer');
  const trigger = page.getByRole('button', { name: '会话列表', exact: true });
  await expect(main.locator('article').first()).toBeVisible();

  for (const width of [...new Set([page.viewportSize()!.width, 320])]) {
    await page.setViewportSize({ width, height: page.viewportSize()!.height });
    await touch(main, 'touchstart', 40);
    await touch(main, 'touchmove', 130);
    // Assert before touchend: an entrance animation after release is not tracking.
    const partial = await drawer.evaluate((node) => ({
      modal: node.matches(':modal'),
      right: node.getBoundingClientRect().right,
      width: node.getBoundingClientRect().width,
    }));
    expect(partial.modal).toBe(true);
    expect(partial.right).toBeCloseTo(90, 0);
    expect(partial.right).toBeLessThan(partial.width);
    await touch(main, 'touchmove', 180);
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().right)).toBeCloseTo(140, 0);
    await touch(main, 'touchend', 180);
    await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const bounds = await drawer.boundingBox();
    expect(bounds!.width).toBe(width);
    expect(bounds!.y).toBe(0);
    expect(bounds!.height).toBeCloseTo(await page.evaluate(() => window.visualViewport!.height), 0);
    if (width === 320 && info.project.name === 'Mobile Chrome') {
      await page.screenshot({ path: info.outputPath('drawer-fullscreen-320.png') });
    }

    const row = drawer.locator('a[aria-current="page"]');
    await expect(row).toBeVisible();
    await touch(row, 'touchstart', 210);
    await touch(row, 'touchmove', 120);
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().left)).toBeCloseTo(-90, 0);
    await touch(row, 'touchcancel', 120);
    await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);

    await touch(row, 'touchstart', 210);
    await touch(row, 'touchmove', 90);
    await touch(row, 'touchend', 90);
    await expect(drawer).not.toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);

    await touch(main, 'touchstart', 40);
    await touch(main, 'touchmove', 130);
    await touch(main, 'touchmove', 46);
    await touch(main, 'touchend', 46);
    await expect(drawer).not.toBeVisible();

    await touch(main, 'touchstart', 40);
    await touch(main, 'touchmove', 130);
    await touch(main, 'touchmove', 160, 180, 2);
    await touch(main, 'touchend', 160);
    await expect(drawer).not.toBeVisible();
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
});

test('drawer keeps observing hesitant starts and follows diagonals without a narrow angle lock', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'drawer-diagonal'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const main = page.locator('.remote-main');
  const drawer = page.locator('.remote-drawer');
  await expect(main.locator('article').first()).toBeVisible();
  // Do not discard the stream before the browser has claimed native scrolling.
  await touch(main, 'touchstart', 40);
  expect(await touch(main, 'touchmove', 45, 195)).toBe(false);
  expect(await touch(main, 'touchmove', 60, 240)).toBe(false);
  await touch(main, 'touchmove', 180, 245);
  expect(await drawer.evaluate((node) => node.getBoundingClientRect().right)).toBeCloseTo(140, 0);
  await touch(main, 'touchcancel', 180, 245);
  await expect(drawer).not.toBeVisible();

  await touch(main, 'touchstart', 40);
  expect(await touch(main, 'touchmove', 57, 195)).toBe(true);
  expect(await drawer.evaluate((node) => node.getBoundingClientRect().right)).toBeCloseTo(17, 0);
  await touch(main, 'touchmove', 100, 198);
  await touch(main, 'touchmove', 180, 200);
  await touch(main, 'touchend', 180, 200);
  await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
  const row = drawer.locator('a[aria-current="page"]');
  await expect(row).toBeVisible();
  await touch(row, 'touchstart', 240);
  expect(await touch(row, 'touchmove', 223, 195)).toBe(true);
  expect(await drawer.evaluate((node) => node.getBoundingClientRect().left)).toBeCloseTo(-17, 0);
  await touch(row, 'touchmove', 180, 198);
  await touch(row, 'touchmove', 90, 200);
  await touch(row, 'touchend', 90, 200);
  await expect(drawer).not.toBeVisible();
});

for (const { name, selector, opening, closing } of [
  { name: '斜滑和短滑', selector: '.remote-main', opening: [[40, 48]], closing: [[-40, 48]] },
  { name: '慢速短滑', selector: '.remote-main', opening: [[32, 0]], closing: [[-32, 0]] },
  { name: '起手反向后转回', selector: '.remote-main', opening: [[-18, 0], [90, 30]], closing: [[18, 0], [-90, 30]] },
  { name: '从按钮起手', selector: '.remote-header button[aria-label="会话列表"]', opening: [[90, 0]], closing: [[-90, 0]] },
  { name: '从短代码起手', selector: '.remote-main pre', opening: [[90, 0]], closing: [[-90, 0]] },
  { name: '从链接起手', selector: '.remote-main a', opening: [[90, 0]], closing: [[-90, 0]] },
  { name: '从表格起手', selector: '.remote-main td', opening: [[90, 0]], closing: [[-90, 0]] },
]) {
  test(`宽松抽屉手势：${name}`, async ({ page, sessionsDir, workingDir }, info) => {
    const { entries, lastId } = buildSession({ cwd: workingDir });
    entries.push(assistantTextEntry(lastId, '```text\nshort code\n```\n\n[普通链接](https://example.com/)\n\n| 列 |\n| --- |\n| 值 |').entry);
    const id = writeSession(sessionsDir, uniqueSessionName(info, 'drawer-relaxed'), entries);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const drawer = page.locator('.remote-drawer');
    const target = page.locator(selector);
    await expect(page.locator('.remote-main article')).toHaveCount(3);
    await touch(target, 'touchstart', 80);
    for (const [dx, dy] of opening) await touch(target, 'touchmove', 80 + dx, 180 + dy);
    expect(await drawer.evaluate((node) => node.matches(':modal'))).toBe(true);
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().right)).toBeCloseTo(opening.at(-1)![0], 0);
    // Short swipes also work without relying on a fast fling.
    if (name === '慢速短滑') await page.waitForTimeout(150);
    await touch(target, 'touchend', 80 + opening.at(-1)![0], 180 + opening.at(-1)![1]);
    await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
    const row = drawer.locator('a[aria-current="page"]');
    await expect(row).toBeVisible();
    await touch(row, 'touchstart', 220);
    for (const [dx, dy] of closing) await touch(row, 'touchmove', 220 + dx, 180 + dy);
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().left)).toBeCloseTo(closing.at(-1)![0], 0);
    if (name === '慢速短滑') await page.waitForTimeout(150);
    await touch(row, 'touchend', 220 + closing.at(-1)![0], 180 + closing.at(-1)![1]);
    await expect(drawer).not.toBeVisible();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);
  });
}

test('real vertical touch scrolls the conversation and fullscreen list without switching them', async ({ page, sessionsDir, workingDir, browserName }, info) => {
  test.skip(browserName !== 'chromium' || info.project.name !== 'Mobile Chrome', 'Real touch injection uses Chromium mobile CDP');
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, '纵向滚动内容。\n\n'.repeat(100)).entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'drawer-scroll-current'), entries);
  for (let index = 0; index < 24; index++) {
    writeSession(sessionsDir, uniqueSessionName(info, `drawer-scroll-${index}`), buildSession({ cwd: workingDir }).entries);
  }
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const main = page.locator('.remote-main');
  const drawer = page.locator('.remote-drawer');
  await expect(main.locator('article')).toHaveCount(3);
  const cdp = await page.context().newCDPSession(page);
  try {
    const scroll = async (target: Locator) => {
      await target.evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll'));
      });
      const box = (await target.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (const dy of [25, 60, 100, 160]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 5, y: y - dy }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => target.evaluate((node) => node.scrollTop)).toBeGreaterThan(50);
    };
    await scroll(main);
    await expect(drawer).not.toBeVisible();
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
    const project = drawer.getByRole('region', { name: workingDir, exact: true });
    await expect(project.locator('.remote-session')).toHaveCount(25);
    await scroll(drawer.locator('.remote-list-main'));
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);
  } finally {
    await cdp.detach();
  }
});

test('real touch can open and dismiss the drawer without navigating or losing the draft', async ({ page, sessionsDir, workingDir, browserName }, info) => {
  test.skip(browserName !== 'chromium' || info.project.name !== 'Mobile Chrome', 'Real touch injection uses Chromium mobile CDP');
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const reply = assistantTextEntry(lastId, '[普通链接](https://example.com/)\n\n```text\nshort code\n```');
  entries.push({ ...reply.entry, message: { ...reply.entry.message, content: [
    { type: 'thinking', thinking: '滑过思考按钮不展开内容。' }, ...reply.entry.message.content,
  ] } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'drawer-real-touch'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const main = page.locator('.remote-main');
  const drawer = page.locator('.remote-drawer');
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await expect(main.locator('article').first()).toBeVisible();
  await draft.fill('保留草稿与当前会话');
  await draft.blur();
  const cdp = await page.context().newCDPSession(page);
  try {
    const cases = [
      { name: 'straight', selector: '.remote-main', moves: [[20, 0], [50, 0], [90, 0], [140, 0]] },
      { name: 'diagonal', selector: '.remote-main', moves: [[17, 15], [60, 18], [140, 20]] },
      { name: 'steep-short', selector: '.remote-main', moves: [[14, 20], [27, 35], [40, 48]] },
      { name: 'reverse-start', selector: '.remote-main', moves: [[-18, 0], [30, 10], [90, 15]] },
      { name: 'button', selector: '.remote-block-toggle', moves: [[20, 0], [50, 15], [90, 25]] },
      { name: 'link', selector: '.remote-main a', moves: [[20, 0], [50, 15], [90, 25]] },
      { name: 'code', selector: '.remote-main pre', moves: [[20, 0], [50, 15], [90, 25]] },
    ];
    for (const { name, selector, moves } of cases) {
      await test.step(name, async () => {
        const target = page.locator(selector);
        await target.scrollIntoViewIfNeeded();
        const box = (await target.boundingBox())!;
        const x = box.x + Math.min(40, box.width / 2);
        const y = box.y + Math.min(30, box.height / 2);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (const [dx, dy] of moves) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] });
        }
        await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().right)).toBeCloseTo(moves.at(-1)![0], 0);
        if (name === 'steep-short') await page.screenshot({ path: info.outputPath('drawer-mid-drag-relaxed.png') });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
        const row = drawer.locator('a[aria-current="page"]');
        await expect(row).toBeVisible();
        await row.scrollIntoViewIfNeeded();
        const rowY = (await row.boundingBox())!.y + 20;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 240, y: rowY }] });
        for (const [dx, dy] of moves) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 240 - dx, y: rowY + dy }] });
        }
        await expect.poll(() => drawer.evaluate((node) => node.getBoundingClientRect().left)).toBeCloseTo(-moves.at(-1)![0], 0);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(drawer).not.toBeVisible();
        await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);
        await expect(draft).toHaveValue('保留草稿与当前会话');
        await expect(main.locator('.remote-block-toggle')).toHaveAttribute('aria-expanded', 'false');
      });
    }
  } finally {
    await cdp.detach();
  }
});
