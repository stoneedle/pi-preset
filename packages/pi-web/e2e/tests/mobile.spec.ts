import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { openFixtureOwner } from "../lib/runtime-owner.mjs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import {
  buildSession,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
  appendEntry,
} from "../lib/sessions";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";

test("projects group by the complete folder, retain folding and reveal search matches", async ({ page, sessionsDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, "project-groups").replace(/\.jsonl$/, "");
  const firstPath = join(workingDir, "client-one", "same-project-folder");
  const secondPath = join(workingDir, "client-two", "same-project-folder");
  for (const path of [firstPath, secondPath]) mkdirSync(path, { recursive: true });
  for (const [index, path] of [firstPath, firstPath, secondPath].entries()) {
    writeSession(sessionsDir, `${prefix}-${index}.jsonl`, buildSession({ cwd: path }).entries);
  }
  await page.goto("/");
  const first = page.getByRole("region", { name: firstPath, exact: true });
  const second = page.getByRole("region", { name: secondPath, exact: true });
  await expect(first.locator(".remote-session")).toHaveCount(2);
  await expect(second.locator(".remote-session")).toHaveCount(1);
  await expect(first.locator(".remote-project-label strong")).toHaveText("same-project-folder");
  await expect(second.locator(".remote-project-label strong")).toHaveText("same-project-folder");
  await expect(first.locator(".remote-project-count")).toHaveText("2");
  await first.locator(".remote-project-toggle").click();
  await expect(first.locator(".remote-project-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(first.locator(".remote-session")).toHaveCount(0);
  await expect(second.locator(".remote-session")).toHaveCount(1);
  await page.reload();
  await expect(first.locator(".remote-project-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(first.locator(".remote-session")).toHaveCount(0);
  const search = page.getByRole("searchbox", { name: "搜索会话" });
  await search.fill(prefix);
  await expect(page.locator(".remote-project")).toHaveCount(2);
  await expect(first.locator(".remote-session")).toHaveCount(2);
  await first.locator(".remote-project-toggle").click();
  await expect(first.locator(".remote-session")).toHaveCount(0);
  await search.fill("");
  await expect(first.locator(".remote-project-toggle")).toHaveAttribute("aria-expanded", "false");
  await first.locator(".remote-project-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(first.locator(".remote-session")).toHaveCount(2);
  const nativeSize = page.viewportSize()!;
  for (const width of [...new Set([nativeSize.width, 320])]) {
    await page.setViewportSize({ width, height: nativeSize.height });
    const overflow = await first.locator("button, strong, small, .remote-session, .remote-state").evaluateAll((elements) => elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1 ? [{ left: box.left, right: box.right }] : [];
    }));
    expect(overflow).toEqual([]);
  }
  await search.fill(prefix);
  await first.scrollIntoViewIfNeeded();
  if (info.project.name === "Mobile Chrome") await page.screenshot({ path: info.outputPath("project-groups-320.png") });
});

test("draft grows with newlines and wrapping, shrinks after edits and sends only guidance", async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "growing-draft"), entries);
  const sent: any[] = [];
  const owner = await openFixtureOwner({
    agentDir, sessionPath: join(sessionsDir, "--home-user-demo-project--", id),
    control: (input: any) => { if (input.action === "send") sent.push(input.chat); return { status: "accepted" }; },
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const draft = page.getByRole("textbox", { name: "给 Pi 发消息…" });
    const height = () => draft.evaluate((element) => element.getBoundingClientRect().height);
    const initialHeight = await height();
    await draft.fill("第一行\n第二行\n第三行\n第四行");
    await expect.poll(height).toBeGreaterThan(initialHeight + 20);
    await draft.fill("短消息");
    await expect.poll(height).toBe(initialHeight);
    await draft.fill("自动换行的长草稿会撑开输入框，并且不会把发送按钮推到屏幕外。".repeat(100));
    await expect.poll(height).toBeGreaterThan(initialHeight + 20);
    const shellHeight = () => page.locator('.composer-shell').evaluate((element) => element.getBoundingClientRect().height);
    await expect.poll(shellHeight).toBeGreaterThan(page.viewportSize()!.height * 0.45);
    await expect.poll(shellHeight).toBeLessThanOrEqual(page.viewportSize()!.height * 0.5 + 1);
    if (info.project.name === 'Mobile Chrome') await page.screenshot({ path: info.outputPath('growing-composer-half-screen.png') });
    await page.setViewportSize({ width: 320, height: page.viewportSize()!.height });
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect.poll(shellHeight).toBeLessThanOrEqual(181);
    await expect.poll(height).toBeGreaterThan(100);
    expect(await draft.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await page.locator(".remote-composer .remote-actions").evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(361);
    await expect(page.getByRole("combobox", { name: "消息投递" })).toHaveCount(0);
    await draft.fill("当前任务的新引导\n附加细节");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    if (info.project.name === "Mobile Chrome") await page.screenshot({ path: info.outputPath("growing-composer-320-keyboard.png") });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(draft).toHaveValue("");
    await expect.poll(height).toBe(initialHeight);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.replace(/\r\n/g, "\n")).toBe("当前任务的新引导\n附加细节");
    expect(Object.keys(sent[0]).sort()).toEqual(["images", "message"]);
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新对话', exact: true });
    await editor.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('新任务长草稿\n'.repeat(100));
    const editorHeight = () => editor.locator('.composer-shell').evaluate((element) => element.getBoundingClientRect().height);
    await expect.poll(editorHeight).toBeGreaterThan(160);
    await expect.poll(editorHeight).toBeLessThanOrEqual(181);
    await expect(editor.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  } finally { await owner.close(); }
});

test("mobile has one compact interface and no workspace entry points", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".remote-session").first()).toBeVisible();
  await expect(page.locator(".remote-header h1")).toHaveText("会话");
  await expect(page.locator(".remote-header")).not.toContainText("127.0.0.1");
  for (const path of [
    "/settings",
    "/schedules",
    "/api/annotations",
    "/api/scratchpad",
    "/api/chat/queue",
    "/api/fork-session",
    "/share",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("session drawer preserves the conversation and fits narrow keyboard viewports", async ({
  page, sessionsDir, workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, "Keep the reading position.\n\n".repeat(100)).entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, "drawer-layout"), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const trigger = page.getByRole("button", { name: "会话列表", exact: true });
  const drawer = page.getByRole("dialog", { name: "会话", exact: true });
  const conversation = page.locator(".remote-app > .remote-main");
  await expect(conversation.locator("article")).toHaveCount(3);
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("尚未发送的草稿");
  await page.locator('.remote-attach input').setInputFiles({
    name: "drawer.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64"),
  });
  await conversation.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));
    element.setAttribute("data-drawer-preserved", "true");
  });
  const scrollTop = await conversation.evaluate((element) => element.scrollTop);
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await drawer.getByRole("button", { name: "搜索会话", exact: true }).click();
  const search = drawer.getByRole("searchbox", { name: "搜索会话", exact: true });
  await search.fill(id);
  const current = drawer.locator('a[aria-current="page"]');
  await expect(drawer.locator(".remote-session")).toHaveCount(1);
  await expect(current).toBeVisible();
  await expect(current).toHaveAttribute("href", `/session?id=${encodeURIComponent(id)}`);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index < 4 ? "Tab" : "Shift+Tab");
    const focus = await drawer.evaluate((element) => ({ contained: element.contains(document.activeElement), modal: element.matches(":modal"), active: document.activeElement?.outerHTML.slice(0, 400) }));
    expect(focus.contained, JSON.stringify({ index, ...focus })).toBe(true);
  }
  await current.click();
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(conversation).toHaveAttribute("data-drawer-preserved", "true");
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await expect(page.getByRole("textbox", { name: "给 Pi 发消息…" })).toHaveValue("尚未发送的草稿");
  await expect(page.getByRole("button", { name: "移除 drawer.png", exact: true })).toBeVisible();

  const originalViewport = page.viewportSize()!;
  for (const width of [...new Set([originalViewport.width, 360, 320])]) {
    await page.setViewportSize({ width, height: originalViewport.height });
    await trigger.click();
    await search.fill(id);
    await expect(drawer.locator(".remote-session")).toHaveCount(1);
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left)).toBe(0);
    const bounds = await drawer.boundingBox();
    expect(bounds!.width).toBe(width);
    expect(bounds!.y).toBe(0);
    expect(bounds!.height).toBe(360);
    const overflow = await drawer.locator("header, header button, input, .remote-session, .remote-state, footer").evaluateAll((elements) => elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > 361
        ? [{ tag: element.tagName, left: box.left, right: box.right, top: box.top, bottom: box.bottom }] : [];
    }));
    expect(overflow).toEqual([]);
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await drawer.locator(".remote-state").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(24);
    if (width === 320 && info.project.name === "Mobile Chrome")
      await page.screenshot({ path: info.outputPath("drawer-320-keyboard.png") });
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
  await trigger.click();
  await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left)).toBe(0);
  await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);
});

test('opening the drawer reveals the current session across folding and pagination', async ({ page, sessionsDir, workingDir }, info) => {
  const projectPath = join(workingDir, 'zz-current-project');
  mkdirSync(projectPath, { recursive: true });
  const prefix = uniqueSessionName(info, 'reveal-current').replace(/\.jsonl$/, '');
  for (let index = 0; index < 65; index++) {
    writeSession(sessionsDir, `${prefix}-${index}.jsonl`, buildSession({ cwd: projectPath }).entries);
  }
  const { entries } = buildSession({ cwd: projectPath });
  entries[0].timestamp = '2000-01-01T00:00:00.000Z';
  const id = writeSession(sessionsDir, `${prefix}-current.jsonl`, entries);
  await page.addInitScript((path) => localStorage.setItem('pi-web:collapsed-projects', JSON.stringify([path])), projectPath);
  let releaseSearch!: () => void;
  const searchGate = new Promise<void>((resolve) => (releaseSearch = resolve));
  await page.route('**/api/sessions?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') === prefix && !url.searchParams.has('offset')) {
      const response = await route.fetch();
      await searchGate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: '会话列表', exact: true });
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  const current = drawer.locator('a[aria-current="page"]');
  const project = drawer.getByRole('region', { name: projectPath, exact: true });
  await trigger.click();
  await expect(current).toBeInViewport({ ratio: 1 });
  await expect(project.locator('.remote-project-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-web:collapsed-projects')!))).toContain(projectPath);

  await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
  await drawer.getByRole('searchbox').fill(prefix);
  await expect(project.locator('.remote-session')).toHaveCount(31);
  try {
    await expect(project.getByRole('button', { name: '更多会话', exact: true })).toBeDisabled();
  } finally { releaseSearch(); }
  await expect(project.getByRole('button', { name: '更多会话', exact: true })).toBeEnabled();
  await project.getByRole('button', { name: '更多会话', exact: true }).click();
  await expect(project.locator('.remote-session')).toHaveCount(61);
  await project.getByRole('button', { name: '更多会话', exact: true }).click();
  await expect(project.locator('.remote-session')).toHaveCount(66);
  expect(await project.locator('.remote-session').evaluateAll((links) => new Set(links.map((link) => link.getAttribute('href'))).size)).toBe(66);

  await project.locator('.remote-project-toggle').click();
  await expect(current).toHaveCount(0);
  await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  for (const viewport of [{ width: 320, height: 360 }, { width: 393, height: 851 }]) {
    await page.setViewportSize(viewport);
    await trigger.click();
    await expect(drawer.getByRole('searchbox')).toHaveValue(prefix);
    await expect(current).toBeInViewport({ ratio: 1 });
    await drawer.locator('.remote-list-main').evaluate((element) => { element.scrollTop = 0; });
    await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  }
});

test('right swipe opens the drawer without stealing scrolling or editing gestures', async ({ page, sessionsDir, workingDir, browserName }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, '```text\n' + 'horizontal code '.repeat(30) + '\n```').entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'swipe-drawer'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  const conversation = page.locator('.remote-app > .remote-main');
  await expect(conversation.locator('article').first()).toBeVisible();
  const swipe = async (target: string, dx: number, dy: number, cancel = false, fingers = 1) => page.locator(target).evaluate((node, { dx, dy, cancel, fingers }) => {
    const start = { clientX: 80, clientY: 150, identifier: 1 };
    const end = { ...start, clientX: start.clientX + dx, clientY: start.clientY + dy };
    for (const [type, point] of [['touchstart', start], ['touchmove', end], [cancel ? 'touchcancel' : 'touchend', end]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : Array(fingers).fill(point) },
        changedTouches: { value: [point] },
      });
      node.dispatchEvent(event);
    }
  }, { dx, dy, cancel, fingers });
  for (const [dx, dy, cancel, fingers] of [[10, 0, false, 1], [-100, 0, false, 1], [20, 100, false, 1], [100, 0, true, 1], [100, 0, false, 2]] as const) {
    await swipe('.remote-main', dx, dy, cancel, fingers);
    await expect(drawer).not.toBeVisible();
  }
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('手势不会覆盖草稿');
  await swipe('.remote-composer textarea', 100, 0);
  await expect(drawer).not.toBeVisible();
  // Only a code block that can actually consume this swipe keeps horizontal scrolling.
  await page.locator('.remote-main pre').evaluate((node) => { node.scrollLeft = 100; });
  await swipe('.remote-main pre', 100, 0);
  await expect(drawer).not.toBeVisible();
  await page.locator('.remote-main pre').evaluate((node) => { node.scrollLeft = 0; });
  await swipe('.remote-main pre', 100, 0);
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('手势不会覆盖草稿');
  if (browserName === 'chromium' && info.project.name === 'Mobile Chrome') {
    const cdp = await page.context().newCDPSession(page);
    const box = await conversation.boundingBox();
    const y = box!.y + 60;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y }] });
    for (const x of [75, 100, 140, 180]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(drawer).toBeVisible();
    await cdp.detach();
  }
});

test('共享状态区分空闲、完成、失败、停止与独立未读，断网不改变原生执行', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'visual-status'), buildSession({ cwd: workingDir }).entries);
  await page.goto('/');
  await page.getByRole('searchbox', { name: '搜索会话' }).fill(id);
  const row = page.locator(`a.remote-session[href="/session?id=${encodeURIComponent(id)}"]`);
  const indicator = row.locator('.remote-state');
  await expect(indicator).toHaveAttribute('aria-label', '未连接 Pi，未读回复');
  await expect(indicator).toHaveText('');
  await expect(indicator.locator('svg')).toHaveCount(1);
  expect(await indicator.locator('svg > *').count()).toBeGreaterThan(1);
  const disconnectedGlyph = await indicator.locator('svg').innerHTML();
  if (info.project.name === 'Mobile Chrome') await page.screenshot({ path: info.outputPath('unconnected-pi-icon.png') });
  let state = 'idle', completed = false, outcome: string | null = null, unread = false;
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id), getState: () => ({ state, completed, outcome, unread }) });
  try {
    const cases = [
      ['running', false, null, false, 'running', '运行中'],
      ['running', false, null, true, 'running', '运行中，未读回复'],
      ['background', false, null, true, 'background', '子任务运行中，未读回复'],
      ['needs-you', false, null, false, 'needs-you', '待你处理'],
      ['idle', false, 'stop', false, 'idle', '空闲'],
      ['idle', true, 'stop', false, 'completed', '已完成'],
      ['idle', true, 'stop', true, 'completed', '已完成，未读回复'],
      ['idle', false, 'error', false, 'failed', '执行失败'],
      ['idle', false, 'aborted', false, 'stopped', '已停止'],
      ['unknown', false, null, false, 'unknown', '运行状态暂不可用'],
    ] as const;
    for (const [next, done, reason, fresh, visual, label] of cases) {
      state = next; completed = done; outcome = reason; unread = fresh;
      owner.publish();
      await expect(indicator).toHaveAttribute('data-state', state);
      await expect(indicator).toHaveAttribute('data-visual', visual);
      await expect(indicator).toHaveAttribute('aria-label', label);
      await expect(indicator).toHaveText('');
      await expect(indicator.locator('svg')).toHaveCount(1);
      await expect(indicator.locator('.remote-unread')).toHaveCount(unread ? 1 : 0);
    }
    await row.click();
    const headerIndicator = page.locator('.remote-header > .remote-state');
    await expect(headerIndicator).toHaveAttribute('aria-label', '运行状态暂不可用');
    await expect(headerIndicator).toHaveText('');
    await expect(headerIndicator.locator('svg')).toHaveCount(1);
    await page.setViewportSize({ width: 320, height: page.viewportSize()!.height });
    state = 'idle'; owner.publish();
    await expect(headerIndicator).toHaveAttribute('aria-label', '空闲');
    await expect(headerIndicator.locator('svg')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (info.project.name === 'Mobile Chrome') await page.screenshot({ path: info.outputPath('idle-status-320.png') });
    await page.context().setOffline(true);
    await expect(headerIndicator).toHaveAttribute('data-visual', 'reconnecting');
    await expect(headerIndicator).toHaveAttribute('aria-label', '实时连接中断');
    await expect(headerIndicator.locator('svg')).toHaveCount(1);
    expect(await headerIndicator.locator('svg').innerHTML()).not.toBe(disconnectedGlyph);
    expect(owner.snapshot().state).toBe('idle');
    await page.context().setOffline(false);
    await expect(headerIndicator).toHaveAttribute('aria-label', '空闲');
    await expect(headerIndicator.locator('svg')).toHaveCount(1);
    state = 'running'; owner.publish();
    await expect(headerIndicator).toHaveAttribute('aria-label', '运行中');
    await expect(headerIndicator.locator('svg')).toHaveCount(1);
    await owner.close();
    await expect(headerIndicator).toHaveAttribute('data-state', 'unknown');
    await expect(headerIndicator).toHaveAttribute('aria-label', '未连接 Pi');
    await expect(headerIndicator.locator('svg')).toHaveCount(1);
    expect(await headerIndicator.locator('svg').innerHTML()).toBe(disconnectedGlyph);
  } finally { await owner.close(); }
});

test('两行标题与单行箭头信息条，环内百分比按原生阈值变色', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const native = buildSession({ cwd: workingDir });
  const name = '这是一个需要完整阅读的较长会话标题，用来验证顶部两行换行而不是继续浪费位置显示主机地址。';
  native.entries.push({ type: 'session_info', id: 'two-line-title', parentId: native.lastId, timestamp: new Date().toISOString(), name });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'session-info'), native.entries);
  let context: { tokens: number | null; contextWindow: number; percent: number | null } | null = { tokens: 0, contextWindow: 200000, percent: 0 };
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', model: 'a-long-native-model-name-with-a-meaningful-suffix', thinking: 'xhigh', context,
      usage: { input: 123456, output: 6543 }, cacheHit: 67, fast: { mode: 'fast', availableModes: ['off', 'fast'] } }),
  });
  await page.route('**/api/git/info?*', (route) => route.fulfill({ json: { branch: 'feature/compact-native-information' } }));
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const bar = page.getByRole('group', { name: '会话信息', exact: true });
    const window = bar.getByLabel('上下文窗口', { exact: true });
    const title = page.locator('.remote-heading h1');
    await expect(title).toHaveText(name);
    await expect(page.locator('.remote-heading')).not.toContainText(new URL(page.url()).host);
    await expect(page.locator('.remote-heading button, .remote-heading svg')).toHaveCount(0);
    const lines = await title.evaluate((node) => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight));
    expect(lines).toBeGreaterThan(1.5);
    expect(lines).toBeLessThanOrEqual(2.1);
    await expect(bar.locator('.session-project')).toContainText('feature/compact-native-information');
    await expect(bar.getByLabel('输入 token', { exact: true })).toHaveText('↑123.5k');
    await expect(bar.getByLabel('输出 token', { exact: true })).toHaveText('↓6.5k');
    await expect(bar.getByLabel('缓存命中率', { exact: true })).toHaveText('CH67%');
    await expect(bar).not.toContainText('窗口');
    await expect(page.locator('.remote-composer .context-usage, .remote-composer .session-context')).toHaveCount(0);
    const progress = window.locator('.context-progress');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const palette = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.position = 'absolute';
        document.body.append(probe);
        const colors: Record<string, string> = {};
        for (const [level, variable] of [['normal', 'muted'], ['warning', 'warning'], ['danger', 'danger']]) {
          probe.style.color = `var(--${variable})`;
          colors[level] = getComputedStyle(probe).color;
        }
        probe.remove();
        return colors;
      });
      expect(new Set(Object.values(palette)).size).toBe(3);
      for (const [percent, level] of [[0, 'normal'], [12.34, 'normal'], [12.6, 'normal'], [70, 'normal'], [70.1, 'warning'], [90, 'warning'], [90.1, 'danger'], [105, 'danger']] as const) {
        context = { tokens: percent * 2000, contextWindow: 200000, percent };
        owner.publish();
        await expect(window).toHaveAttribute('data-level', level);
        await expect(window).toHaveText(`${Math.round(percent)}%`);
        await expect(progress).toHaveAttribute('stroke-dasharray', `${Math.min(percent, 100)} 100`);
        await expect.poll(() => window.evaluate((node) => getComputedStyle(node).color)).toBe(palette[level]);
        await expect.poll(() => progress.evaluate((node) => getComputedStyle(node).stroke)).toBe(palette[level]);
        const label = await window.evaluate((node) => ({
          width: node.querySelector(':scope > span')!.getBoundingClientRect().width,
          innerDiameter: node.clientWidth * 26 / 32,
        }));
        expect(label.width).toBeLessThanOrEqual(label.innerDiameter);
      }
      await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('标题与信息吸附在顶部，输入和停止仍可用。'.repeat(25));
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 360 });
        visualViewport!.dispatchEvent(new Event('resize'));
      });
      const layout = await bar.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const centers = [...node.children].map((child) => {
          const rect = child.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
        return { y: box.y, height: box.height, fits: node.scrollWidth <= node.clientWidth,
          rowSpread: Math.max(...centers) - Math.min(...centers) };
      });
      expect(layout.fits).toBe(true);
      expect(layout.rowSpread).toBeLessThan(1);
      expect(layout.height).toBeLessThanOrEqual(36);
      await page.locator('.remote-main').evaluate((node) => { node.scrollTop = 0; });
      expect((await bar.boundingBox())!.y).toBe(layout.y);
      await expect(page.getByRole('button', { name: '停止主代理', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`session-info-320-${colorScheme}.png`) });
    }
    context = { tokens: null, contextWindow: 200000, percent: null };
    owner.publish();
    await expect(window).toHaveText('?');
    await expect(window).toHaveAttribute('data-level', 'normal');
    await expect(window).toHaveAttribute('title', '上下文 ? / 200k');
    await expect(progress).toHaveAttribute('stroke-dasharray', '0 100');
    await page.locator('.remote-info summary').click();
    await expect(page.locator('.remote-info dl')).toHaveCount(0);
    await expect(page.locator('.remote-info').getByRole('button', { name: '通知', exact: true })).toBeVisible();
    await page.locator('.remote-info summary').click();
    await owner.close();
    await expect(window).toHaveText('?');
    await expect(window).toHaveAttribute('title', '上下文 ? / ?');
    await expect(bar.getByLabel('输入 token', { exact: true })).toHaveText('↑?');
    await expect(bar.getByLabel('缓存命中率', { exact: true })).toHaveText('CH?');
  } finally { await owner.close(); }
});

test("drawer browsing stays passive and receives live unread state before switching sessions", async ({
  page, request, sessionsDir, agentDir, workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "drawer-live"), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, "drawer-target"), buildSession({ cwd: workingDir }).entries);
  const owner = await openFixtureOwner({
    agentDir, sessionPath: join(sessionsDir, "--home-user-demo-project--", id),
  });
  const writes: string[] = [];
  page.on("request", (input) => {
    if (input.method() === "POST" && !input.url().includes("/acknowledge") && !input.url().includes('/api/diagnostics')) writes.push(input.url());
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect.poll(() => owner.snapshot().unread).toBe(false);
    await page.getByRole("button", { name: "会话列表", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "会话", exact: true });
    await drawer.getByRole("button", { name: "搜索会话", exact: true }).click();
    const search = drawer.getByRole("searchbox");
    await search.fill(id);
    const current = drawer.locator('a[aria-current="page"]');
    await expect(drawer.locator(".remote-session")).toHaveCount(1);
    await expect(current.locator(".remote-state")).toHaveAttribute("data-state", "idle");
    const project = drawer.getByRole("region", { name: workingDir, exact: true });
    await project.locator(".remote-project-toggle").click();
    appendEntry(sessionsDir, id, assistantTextEntry(lastId, "A reply arriving while browsing the drawer.").entry);
    owner.publish();
    await expect(project.locator(".remote-project-unread")).toBeVisible();
    await project.locator(".remote-project-toggle").click();
    await expect(current.locator(".remote-unread")).toBeVisible();
    expect((await (await request.get(`/api/status?id=${encodeURIComponent(id)}`)).json()).unread).toBe(true);
    expect(writes).toEqual([]);
    await drawer.getByRole("button", { name: "关闭会话列表", exact: true }).click();
    await expect.poll(() => owner.snapshot().unread).toBe(false);
    await page.getByRole("button", { name: "会话列表", exact: true }).click();
    await search.fill(other);
    await expect(drawer.locator(".remote-session")).toHaveCount(1);
    await expect(drawer.locator(".remote-session")).toHaveAttribute("href", `/session?id=${encodeURIComponent(other)}`);
    await drawer.locator(`a[href="/session?id=${encodeURIComponent(other)}"]`).click();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(other)}`);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  } finally { await owner.close(); }
});

test('Chinese UI keeps all information and keyboard controls inside the real viewport', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'chinese-layout'), entries);
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'needs-you', attentionId: 'chinese-native-attention', attentionKind: 'confirm',
      model: 'a-long-current-native-model-with-a-meaningful-suffix', context: { tokens: 123456, contextWindow: 1048576 } }) });
  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US' });
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: '会话信息', exact: true })).toBeVisible();
    await page.locator('.remote-composer textarea').fill('中文长草稿在键盘打开时仍然完整可编辑。'.repeat(30));
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      document.querySelector('.remote-main')!.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => page.evaluate(() => document.querySelector('.remote-actions')!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(361);
    const overflow = await page.locator('.remote-header > *, .session-info, .session-info > span, .remote-composer textarea, .remote-composer .remote-actions > *').evaluateAll((elements) => elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      return box.height > 0 && (box.left < -1 || box.right > innerWidth + 1) ? [{ tag: element.tagName, left: box.left, right: box.right, width: innerWidth }] : [];
    }));
    expect(overflow).toEqual([]);
    expect(await page.locator('.remote-main').evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
  } finally { await owner.close(); }
});

test("a late HTTP list cannot overwrite newer SSE activity or confirmation", async ({ page, agentDir, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "list-state"), entries);
  let state = { state: "running", unread: true };
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, "--home-user-demo-project--", id), getState: () => state });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === "/api/sessions" && url.searchParams.get("q") === "Initial") {
        (window as any).__listHeld = true;
        await new Promise<void>((resolve) => { (window as any).__releaseList = resolve; });
      }
      return response;
    };
  });
  try {
    await page.goto("/");
    const card = page.locator(`a.remote-session[href="/session?id=${encodeURIComponent(id)}"]`);
    await expect(card.locator(".remote-state")).toHaveAttribute("data-state", "running");
    await page.locator(".remote-search input").fill("Initial");
    await page.waitForFunction(() => (window as any).__listHeld);
    state = { state: "idle", unread: false };
    owner.publish();
    await expect(card.locator(".remote-state")).toHaveAttribute("data-state", "idle");
    await expect(card.locator(".remote-unread")).toHaveCount(0);
    await page.evaluate(() => (window as any).__releaseList());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(card.locator(".remote-state")).toHaveAttribute("data-state", "idle");
    await expect(card.locator(".remote-unread")).toHaveCount(0);
  } finally { await page.evaluate(() => (window as any).__releaseList?.()).catch(() => {}); await owner.close(); }
});

test('reconnecting invalidates runtime facts beyond the refreshed first page', async ({ page, request, agentDir, sessionsDir, workingDir }, info) => {
  const group = uniqueSessionName(info, 'reconnect').replace('.jsonl', '');
  const ids: string[] = [];
  for (let index = 0; index < 31; index++) {
    const { entries, lastId } = buildSession({ cwd: workingDir });
    entries.push({ type: 'session_info', id: `name-${index}`, parentId: lastId,
      timestamp: new Date().toISOString(), name: `${group}-${index}` });
    const stamp = new Date(Date.now() - (31 - index) * 2000);
    for (const entry of entries) entry.timestamp = stamp.toISOString();
    const id = writeSession(sessionsDir, `${group}-${index}.jsonl`, entries);
    utimesSync(join(sessionsDir, '--home-user-demo-project--', id), stamp, stamp);
    ids.push(id);
  }
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', ids[0]),
    getState: () => ({ state: 'running', unread: true }) });
  let ownerClosed = false;
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as any).__runtimeStream = this;
      }
    };
  });
  try {
    await expect.poll(async () => (await (await request.get(`/api/status?id=${encodeURIComponent(ids[0])}`)).json()).state).toBe('running');
    await page.goto('/');
    const searched = page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === group);
    await page.locator('.remote-search input').fill(group);
    await (await searched).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.remote-session')).toHaveCount(30);
    await page.getByRole('button', { name: "更多会话", exact: true }).click();
    await expect(page.locator('.remote-session')).toHaveCount(31);
    const tail = page.locator(`a.remote-session[href="/session?id=${encodeURIComponent(ids[0])}"]`);
    await expect(tail.locator('.remote-state')).toHaveAttribute('data-state', 'running');
    await expect(tail.locator('.remote-unread')).toHaveCount(1);
    await page.evaluate(() => {
      const stream = (window as any).__runtimeStream;
      stream.close();
      stream.dispatchEvent(new Event('error'));
    });
    await owner.close();
    ownerClosed = true;
    const refreshed = page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === group);
    await page.evaluate(() => {
      const stream = (window as any).__runtimeStream;
      stream.dispatchEvent(new Event('open'));
      stream.dispatchEvent(new MessageEvent('status-snapshot', { data: '{}' }));
    });
    await (await refreshed).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(tail.locator('.remote-state')).toHaveAttribute('data-state', 'unknown');
    await expect(tail.locator('.remote-unread')).toHaveCount(1);
    await expect(page.locator('.remote-session')).toHaveCount(31);
  } finally { if (!ownerClosed) await owner.close(); }
});

test("a shrunken visual viewport keeps expanded information and typing controls reachable", async ({
  page, sessionsDir, agentDir, workingDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "keyboard"), entries);
  const commandNames = Array.from({ length: 6 }, (_, i) => i === 0
    ? "skill:review-project-configuration-and-runtime-state-with-detailed-diagnostics"
    : `skill-${i}`);
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, "--home-user-demo-project--", id),
    getState: () => ({ state: "running", model: "a-long-native-model-name-with-a-meaningful-suffix", cacheHit: 67,
      context: { tokens: 123456, contextWindow: 1048576 }, fast: { mode: "fast", availableModes: ["off","fast","ultrafast"], serviceTier: "priority" } }),
    control: (input: any) => input.action === "commands" ? { commands: commandNames.map((name) => ({ name, source: "skill", description: "A detailed native skill description that must not appear in the command list." })) } : { models: [] },
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.getByRole("button", { name: "停止主代理", exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: '会话信息', exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "给 Pi 发消息" }).fill("A complete draft remains editable while the keyboard is open. ".repeat(15));
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
      document.querySelector(".remote-main")!.dispatchEvent(new Event("scroll"));
    });
    const assertControls = async () => {
      const boxes = await page.locator(".remote-composer textarea, .remote-composer .remote-actions").evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height };
      }));
      expect(boxes.every((box) => box.top >= 0 && box.bottom <= 361 && box.height > 0), JSON.stringify(boxes)).toBe(true);
      expect(await page.locator(".remote-main").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const region = document.querySelector('.remote-main')!.getBoundingClientRect();
        const latest = [...document.querySelectorAll('.remote-markdown')].at(-1)!.getBoundingClientRect();
        return Math.min(region.bottom, latest.bottom) - Math.max(region.top, latest.top);
      })).toBeGreaterThanOrEqual(16);
    };
    await assertControls();
    await page.getByRole("textbox", { name: "给 Pi 发消息" }).fill("/");
    await expect(page.locator(".remote-skills button")).toHaveText(commandNames);
    await expect(page.locator(".remote-skills button").first()).toHaveAttribute("title", commandNames[0]);
    const commandHeights = await page.locator(".remote-skills button").evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().height));
    expect(new Set(commandHeights).size).toBe(1);
    await assertControls();
    await page.locator(".remote-skills button").last().scrollIntoViewIfNeeded();
    await page.locator(".remote-skills button").last().click();
    await expect(page.getByRole("textbox", { name: "给 Pi 发消息" })).toHaveValue("/skill-5 ");
    await assertControls();
    await page.locator('.remote-attach input').setInputFiles(Array.from({ length: 3 }, (_, index) => ({
      name: `现场照片-${index}-a-meaningful-long-camera-filename-that-still-identifies-the-right-image.png`,
      mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64'),
    })));
    await expect(page.locator('.remote-images .draft-image-remove')).toHaveCount(3);
    await assertControls();
    if (info.project.name === "Mobile Chrome" || info.project.name === "iPad") await page.screenshot({ path: info.outputPath("keyboard-viewport.png") });
    const lastImage = page.locator('.remote-images .draft-image-remove').last();
    await lastImage.scrollIntoViewIfNeeded();
    await expect(lastImage).toHaveAttribute('aria-label', /移除 现场照片-2/);
    await lastImage.click();
    await expect(page.locator('.remote-images .draft-image-remove')).toHaveCount(2);
    await assertControls();
    await page.evaluate(() => { delete (window.visualViewport as any).height; window.visualViewport!.dispatchEvent(new Event("resize")); });
    await expect(page.getByRole("textbox", { name: "给 Pi 发消息" })).toHaveValue("/skill-5 ");
  } finally { await owner.close(); }
});

test("folded bodies and original images stay lazy while thumbnails load", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const large = "private-folded-body-".repeat(100000);
  entries.push({
    type: "message",
    id: "tool-call",
    parentId: lastId,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Planning the project inspection. " + " ".repeat(300) + large },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "inspect project", payload: large },
        },
      ],
    },
  });
  entries.push({
    type: "message",
    id: "tool-result",
    parentId: "tool-call",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: large }],
    },
  });
  entries.push({
    type: "message",
    id: "photo",
    parentId: "tool-result",
    message: {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: pixel }],
    },
  });
  entries.push(
    assistantTextEntry(
      "photo",
      "Answer stays complete. ![deferred image](https://example.invalid/do-not-fetch.png)",
    ).entry,
  );
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "lazy"),
    entries,
  );
  const requests: string[] = [];
  const initial: Promise<string>[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (["/session", "/api/session", "/api/status"].includes(path))
      initial.push(response.text().catch(() => ""));
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator(".remote-main")).toContainText(
    "Answer stays complete.",
  );
  const bodies = await Promise.all(initial);
  expect(bodies.join("")).not.toContain("private-folded-body-");
  expect(
    requests.some(
      (url) =>
        url.includes("/api/session/block") ||
        (url.includes("/api/session/image") && new URL(url).searchParams.get("thumbnail") !== "1") ||
        url.includes("do-not-fetch.png"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: /bash inspect project/ }).click();
  await expect(page.locator(".remote-block pre").first()).toContainText(
    "private-folded-body-",
  );
  expect(
    requests.filter((url) => url.includes("/api/session/block")).length,
  ).toBe(1);
  await expect(page.locator(".remote-image-preview img")).toHaveJSProperty("naturalWidth", 1);
  await expect(page.getByRole("link", { name: "打开图片", exact: true })).not.toHaveAttribute("href", /[?&]thumbnail=/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("ordinary long replies remain whole and older history preserves its anchor", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  let parent = lastId;
  for (let i = 0; i < 85; i++) {
    const next = assistantTextEntry(parent, `History message ${i}.`);
    entries.push(next.entry);
    parent = next.id;
  }
  const text =
    "Long ordinary answer stays intact. ".repeat(4000) + "END-OF-ANSWER";
  const answer = assistantTextEntry(parent, text);
  entries.push(answer.entry);
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "history"),
    entries,
  );
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator(".remote-markdown").last()).toHaveText(text);
  const main = page.locator(".remote-main");
  await expect.poll(() => main.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3);
  const first = page.locator("article").first();
  const anchor = await first.getAttribute("data-message-id");
  const position = await main.evaluate((element) => {
    element.scrollTop = 0;
    return element.querySelector('article')!.getBoundingClientRect().top;
  });
  // Scrolling requests the next page before reaching the manual fallback.

  await expect.poll(() => page.locator("article").count()).toBeGreaterThan(1);
  const anchored = page.locator(`[data-message-id="${anchor}"]`);
  await expect
    .poll(async () => Math.abs((await anchored.boundingBox())!.y - position))
    .toBeLessThan(3);
  const historicalTop = await main.evaluate((element) => element.scrollTop);
  const originalHeight = await main.evaluate((element) => element.clientHeight);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => main.evaluate((element) => element.clientHeight)).toBeLessThan(originalHeight);
  await expect.poll(() => main.evaluate((element, top) => Math.abs(element.scrollTop - top), historicalTop)).toBeLessThan(2);
  await page.getByRole('button', { name: "最新消息", exact: true }).click();
  await expect.poll(() => main.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3);
  await page.evaluate(() => { delete (window.visualViewport as any).height; window.visualViewport!.dispatchEvent(new Event('resize')); });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("background and attention are distinct; socket closure becomes unknown", async ({
  page,
  sessionsDir,
  agentDir,
  workingDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "state"),
    entries,
  );
  let activity = "background";
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, "--home-user-demo-project--", id),
    getState: () => ({ state: activity }),
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const state = page.locator(".remote-header .remote-state");
  await expect(state).toHaveAttribute("data-state", "background");
  activity = "needs-you"; owner.publish();
  await expect(state).toHaveAttribute("data-state", "needs-you");
  await expect(page.locator(".remote-main")).toContainText(
    "请在电脑上处理原生对话框。",
  );
  await owner.close();
  await expect(state).toHaveAttribute("data-state", "unknown");
  expect(existsSync(join(agentDir, "session-status"))).toBe(false);
});

test("Fast is read-only native metadata and disconnect never leaves it looking active", async ({
  page, sessionsDir, agentDir, workingDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "fast"), entries);
  let fast: null | { mode: string; availableModes: readonly string[]; serviceTier: string | null } = null;
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, "--home-user-demo-project--", id),
    getState: () => ({ state: 'idle', fast }),
  });
  const fastRequests: string[] = [];
  page.on("request", (request) => { if (/\/api\/.*fast/i.test(new URL(request.url()).pathname)) fastRequests.push(request.url()); });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const value = page.locator('.model-fast');
    await expect(value).toHaveCount(0);
    for (const [snapshot, label] of [
      [{ mode: "off", availableModes: ["off","fast","ultrafast"], serviceTier: null }, "关闭"],
      [{ mode: "fast", availableModes: ["off","fast","ultrafast"], serviceTier: "priority" }, "快速"],
      [{ mode: "ultrafast", availableModes: ["off"], serviceTier: null }, "极速 — 对此模型不生效"],
      [{ mode: "ultrafast", availableModes: ["off","fast","ultrafast"], serviceTier: "ultrafast" }, "极速"],
    ] as const) {
      fast = snapshot; owner.publish();
      if (snapshot.mode === 'off') await expect(value).toHaveCount(0);
      else await expect(value).toHaveAttribute('title', label);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await expect(page.locator('.remote-info dl')).toHaveCount(0);
    expect(fastRequests).toEqual([]);
    if (info.project.name === "Mobile Chrome") await page.screenshot({ path: info.outputPath("fast-info.png") });
  } finally { await owner.close(); }
  await expect(page.locator('.model-fast')).toHaveCount(0);
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveText('?');
  await expect(page.locator('.remote-info select')).toHaveCount(0);
});

test("bursty live updates stay incremental and never overlap session downloads", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "burst"),
    entries,
  );
  let active = 0,
    maximum = 0;
  const paths: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/session") {
      active++;
      maximum = Math.max(maximum, active);
      paths.push(request.url());
    }
  });
  const finish = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname === "/api/session") active--;
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  await page.route("**/api/session?**", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ response });
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator("article")).toHaveCount(2);
  const loadedAt = paths.length;
  let parent = lastId;
  for (let i = 0; i < 8; i++) {
    const next = assistantTextEntry(parent, `Incremental result ${i}`);
    appendEntry(sessionsDir, id, next.entry);
    parent = next.id;
    await page.waitForTimeout(80);
  }
  await expect(page.locator("article").last()).toContainText(
    "Incremental result 7",
  );
  await page.unrouteAll({ behavior: "wait" });
  expect(maximum).toBe(1);
  expect(paths.length).toBeGreaterThan(1);
  expect(paths.length).toBeGreaterThan(loadedAt);
  expect(paths.slice(loadedAt).every((path) => path.includes("&after="))).toBe(true);
});

test('late history cannot prepend an abandoned branch after a window reset', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  let parent = lastId;
  for (let i = 0; i < 65; i++) {
    const next = assistantTextEntry(parent, `Abandoned branch history ${i}`);
    entries.push(next.entry); parent = next.id;
  }
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'late-history'), entries);
  // WebKit service-worker traffic can bypass Playwright routes. Hold the actual fetch response at its consumer instead.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/session' && url.searchParams.has('before')) {
        (window as any).__historyHeld = true;
        await new Promise<void>((resolve) => { (window as any).__releaseHistory = resolve; });
      }
      return response;
    };
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('article').last()).toContainText('Abandoned branch history 64');
    await page.getByRole('button', { name: "加载更早的消息", exact: true }).click();
    await page.waitForFunction(() => (window as any).__historyHeld);
    const next = assistantTextEntry(lastId, 'Current branch result');
    appendEntry(sessionsDir, id, next.entry);
    await expect(page.locator('article').last()).toContainText('Current branch result');
    await expect(page.locator('.remote-main')).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => (window as any).__releaseHistory());
    await expect(page.locator('.remote-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('article')).toHaveCount(3);
    await expect(page.locator('.remote-main')).not.toContainText('Abandoned branch history');
  } finally { await page.evaluate(() => (window as any).__releaseHistory?.()).catch(() => {}); }
});
