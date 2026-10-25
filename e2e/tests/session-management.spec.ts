import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession, assistantTextEntry, appendEntry } from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block' });

function namedSession(sessionsDir: string, cwd: string, id: string, name: string, created = new Date().toISOString()) {
  const native = buildSession({ cwd });
  native.entries[0].timestamp = created;
  native.entries.push({ type: 'session_info', id: 'title-' + native.entries[0].id, parentId: native.lastId, timestamp: created, name });
  writeSession(sessionsDir, id, native.entries);
  return native;
}

async function searchSessions(page: any, query: string, scope = page) {
  const loaded = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/sessions' && url.searchParams.get('q') === query && !url.searchParams.has('archived');
  });
  const search = scope.getByRole('searchbox', { name: '搜索会话', exact: true });
  if (!await search.isVisible()) await scope.getByRole('button', { name: '搜索会话', exact: true }).click();
  await search.fill(query);
  await (await loaded).finished();
}

async function longPress(page: any, row: any, menuName = '会话操作') {
  await row.scrollIntoViewIfNeeded();
  await row.click({ trial: true });
  const box = await row.boundingBox();
  if (page.context().browser()?.browserType().name() === 'chromium' && await page.evaluate(() => navigator.maxTouchPoints > 0)) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 30, y: box.y + box.height / 2 }] });
      await expect(page.getByRole('menu', { name: menuName, exact: true })).toBeVisible();
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await client.detach(); }
  } else {
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.getByRole('menu', { name: menuName, exact: true })).toBeVisible();
    await page.mouse.up();
  }
}

test('项目行新建、长按原生改名、统一归档区搜索恢复，320px不溢出', async ({ page, request, sessionsDir, workingDir, agentDir }, info) => {
  const cwd = join(workingDir, 'a-very-long-project-name-for-mobile');
  mkdirSync(cwd);
  const id = uniqueSessionName(info, 'manage');
  namedSession(sessionsDir, cwd, id, '待整理的会话');
  const nativePath = join(sessionsDir, '--home-user-demo-project--', id);
  const original = readFileSync(nativePath, 'utf8');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  const project = page.getByRole('region', { name: cwd, exact: true });
  await expect(project.locator('.remote-project-chevron')).toHaveCount(0);
  expect(await project.locator('.remote-project-action').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('title')))).toEqual(['新建会话']);
  await project.getByRole('button', { name: '在 a-very-long-project-name-for-mobile 中新建会话', exact: true }).click();
  const newTask = page.getByRole('dialog', { name: '新对话', exact: true });
  await expect(newTask.getByRole('button', { name: '选择项目', exact: true })).toContainText('a-very-long-project-name-for-mobile');
  await newTask.getByRole('button', { name: '关闭新对话', exact: true }).click();
  await expect(newTask).not.toBeVisible();
  const row = project.locator('a.remote-session');
  await longPress(page, row);
  const actions = page.getByRole('menu', { name: '会话操作', exact: true });
  await actions.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名会话', exact: true });
  await rename.getByRole('textbox', { name: '会话名称', exact: true }).fill('手机改名后的原生名称');
  await rename.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(row).toContainText('手机改名后的原生名称');
  expect(readFileSync(nativePath, 'utf8')).toContain(original.trim());
  expect(JSON.parse(readFileSync(nativePath, 'utf8').trim().split('\n').at(-1)!).type).toBe('session_info');
  expect(existsSync(join(agentDir, 'pi-web', 'owners', id + '.json'))).toBe(false);
  await longPress(page, row);
  await actions.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect(actions).not.toBeVisible();
  await expect(project.locator('a.remote-session')).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  const panel = page.getByRole('region', { name: '已归档会话列表', exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog', { name: '历史会话' })).toHaveCount(0);
  await panel.getByRole('searchbox', { name: '搜索会话', exact: true }).fill('手机改名');
  await expect(panel.locator('a.remote-session')).toHaveCount(1);
  expect(await project.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole('searchbox')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('project-history-320.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await panel.getByRole('searchbox').fill('手机改名');
  await expect(panel.locator('a.remote-session')).toHaveCount(1);
  await panel.locator('a.remote-session').click();
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(id));
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  expect(existsSync(join(agentDir, 'pi-web', 'owners', id + '.json'))).toBe(false);
  expect((await (await request.get('/api/sessions?project=' + encodeURIComponent(cwd))).json()).sessions.map((item: any) => item.id)).toContain(id);
});

test('统一归档区按文件夹加载与无限滚动，搜索覆盖未加载记录，选择后原生resume', async ({ page, request, sessionsDir, workingDir, agentDir }, info) => {
  const cwd = join(workingDir, 'history-pages');
  mkdirSync(cwd);
  const prefix = uniqueSessionName(info, 'history').replace(/\.jsonl$/, '');
  let historyReads = 0;
  page.on('request', (request) => { const url = new URL(request.url()); if (url.searchParams.get('archived') === 'true' && url.searchParams.get('project') === cwd) historyReads++; });
  const ids: string[] = [];
  for (let index = 0; index < 65; index++) {
    const id = prefix + '-' + index + '.jsonl';
    namedSession(sessionsDir, cwd, id, '历史任务 ' + index, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
    ids.push(id);
    expect((await request.post('/api/session/archive?id=' + encodeURIComponent(id), { data: { archived: true } })).ok()).toBe(true);
  }
  await page.goto('/');
  const project = page.getByRole('region', { name: cwd, exact: true });
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await project.locator('.remote-project-toggle').click();
  const panel = page.getByRole('region', { name: '已归档会话列表', exact: true });
  await expect(panel.locator('a.remote-session')).toHaveCount(30);
  for (const count of [60, 65]) {
    await project.evaluate((node) => node.querySelector('.remote-more')?.scrollIntoView({ block: 'nearest' }));
    await expect.poll(() => panel.locator('a.remote-session').count()).toBeGreaterThanOrEqual(count);
  }
  await expect(panel.locator('a.remote-session')).toHaveCount(65);
  expect(await panel.locator('a.remote-session').evaluateAll((nodes) => new Set(nodes.map((node) => node.getAttribute('href'))).size)).toBe(65);
  const readsBeforeActivity = historyReads;
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions' && new URL(response.url()).searchParams.get('summary') === 'true');
  const nativePath = join(sessionsDir, '--home-user-demo-project--', ids[64]);
  const parent = JSON.parse(readFileSync(nativePath, 'utf8').trim().split('\n').at(-1)!).id;
  appendEntry(sessionsDir, ids[64], { type: 'custom', id: 'status-only', parentId: parent, timestamp: new Date().toISOString(), customType: 'progress', data: {} });
  await (await refreshed).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(historyReads, 'native progress must not abort or redownload an unchanged history panel').toBe(readsBeforeActivity);
  await panel.getByRole('searchbox').fill('历史任务 0');
  await expect(panel.locator('a.remote-session')).toHaveCount(1);
  await panel.locator('a.remote-session').click();
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(ids[0]));
  const ownerFile = join(agentDir, 'pi-web', 'owners', ids[0] + '.json');
  expect(existsSync(ownerFile)).toBe(false);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('Continue recovered history');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('Stub reply: Continue recovered history', { exact: true })).toBeVisible();
  expect(existsSync(ownerFile)).toBe(true);
});

test('按创建时间稳定排列，完成、改名和归档恢复均不置顶', async ({ page, request, sessionsDir, workingDir, agentDir }, info) => {
  const cwd = join(workingDir, 'creation-order');
  mkdirSync(cwd);
  const prefix = uniqueSessionName(info, 'order').replace(/\.jsonl$/, '');
  const a = prefix + '-a.jsonl', b = prefix + '-b.jsonl', c = prefix + '-c.jsonl';
  const native = namedSession(sessionsDir, cwd, a, '较早任务', '2026-01-01T00:00:00Z');
  namedSession(sessionsDir, cwd, b, '中间任务', '2026-01-02T00:00:00Z');
  namedSession(sessionsDir, cwd, c, '较新任务', '2026-01-03T00:00:00Z');
  let state = 'running';
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', a), getState: () => ({ state }) });
  try {
    await page.goto('/');
    const project = page.getByRole('region', { name: cwd, exact: true });
    await searchSessions(page, prefix);
    const order = () => project.locator('a.remote-session').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get('id')));
    await expect.poll(order).toEqual([c, b, a]);
    await longPress(page, project.locator('a.remote-session').last());
    const menu = page.getByRole('menu', { name: '会话操作', exact: true });
    await expect(menu.getByRole('menuitem')).toHaveText(['重命名', '分叉为新会话', '归档']);
    await expect(project.locator('[data-session-drag]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    const result = assistantTextEntry(native.lastId, 'Completion must not reorder');
    appendEntry(sessionsDir, a, result.entry);
    state = 'idle'; owner.publish();
    await expect.poll(order).toEqual([c, b, a]);
    await page.reload();
    await searchSessions(page, prefix);
    await expect.poll(order).toEqual([c, b, a]);
    await longPress(page, project.locator('a.remote-session').last());
    await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名会话', exact: true });
    await rename.getByRole('textbox').fill('改名但不移动');
    await rename.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(rename).not.toBeVisible();
    await expect.poll(order).toEqual([c, b, a]);
    for (const archived of [true, false]) expect((await request.post('/api/session/archive?id=' + encodeURIComponent(a), { data: { archived } })).ok()).toBe(true);
    await expect.poll(order).toEqual([c, b, a]);
    const data = await (await request.get('/api/sessions?project=' + encodeURIComponent(cwd))).json();
    expect(data.sessions.map((item: any) => item.id)).toEqual([c, b, a]);
    expect(data.sessions.every((item: any) => item.createdAt && !('order' in item))).toBe(true);
  } finally { await owner.close(); }
});

test('popover贴着会话行，归档即时响应且多个请求并行，失败恢复对应行', async ({ page, sessionsDir, workingDir, request }, info) => {
  const cwd = join(workingDir, 'quick-archive');
  mkdirSync(cwd);
  const prefix = uniqueSessionName(info, 'quick').replace(/\.jsonl$/, '');
  const ids = [0, 1, 2].map((n) => prefix + '-' + n + '.jsonl');
  ids.forEach((id, n) => namedSession(sessionsDir, cwd, id, '快速归档 ' + n));
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await searchSessions(page, prefix);
  const project = page.getByRole('region', { name: cwd, exact: true });
  const rows = project.locator('a.remote-session');
  await expect(rows).toHaveCount(3);
  const queued: any[] = [];
  await page.route('**/api/session/archive?*', (route) => { queued.push(route); });
  const menu = page.getByRole('menu', { name: '会话操作', exact: true });
  for (let n = 0; n < 2; n++) {
    if (n === 1) await page.emulateMedia({ colorScheme: 'dark' });
    await longPress(page, rows.first());
    const rowBox = (await rows.first().boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.width).toBeLessThan(250);
    expect(menuBox.x).toBeGreaterThanOrEqual(12);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(308);
    expect(Math.min(Math.abs(menuBox.y - rowBox.y - rowBox.height), Math.abs(rowBox.y - menuBox.y - menuBox.height))).toBeLessThan(12);
    await expect(page).toHaveURL('/');
    await expect(menu.getByRole('menuitem')).toHaveText(['重命名', '分叉为新会话', '归档']);
    await page.screenshot({ path: info.outputPath('session-popover-320-' + n + '.png'), animations: 'disabled' });
    await menu.getByRole('menuitem', { name: '归档', exact: true }).click();
    await expect(menu).not.toBeVisible();
    await expect(rows).toHaveCount(2 - n);
  }
  await expect.poll(() => queued.length).toBe(2);
  const remainingURL = await rows.first().getAttribute('href');
  await rows.first().click();
  await expect(page).toHaveURL(remainingURL!);
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  await searchSessions(page, prefix, drawer);
  await expect(rows).toHaveCount(1);
  // A list refresh before either write finishes must not revive optimistic archives.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(rows).toHaveCount(1);
  const failedId = new URL(queued[0].request().url()).searchParams.get('id');
  const savedId = new URL(queued[1].request().url()).searchParams.get('id');
  await queued[1].continue();
  await expect.poll(async () => (await (await request.get('/api/sessions?archived=true&project=' + encodeURIComponent(cwd))).json()).sessions.map((item: any) => item.id)).toContain(savedId);
  await queued[0].fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '本次归档未保存' }) });
  await expect(page.getByRole('alert')).toContainText('本次归档未保存');
  await expect(rows).toHaveCount(2);
  await expect(project.locator('[data-session-id="' + failedId + '"]')).toBeVisible();
  await expect(project.locator('[data-session-id="' + savedId + '"]')).toHaveCount(0);
  await longPress(page, rows.first());
  await page.getByRole('searchbox', { name: '搜索会话', exact: true }).click();
  await expect(menu).not.toBeVisible();
  await expect(project.locator('.remote-menu-active')).toHaveCount(0);
  await expect(page).toHaveURL(remainingURL!);
  await rows.first().focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '分叉为新会话', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '归档', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(rows.first()).toBeFocused();
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(remainingURL!);
  const current = drawer.locator('a[aria-current="page"]');
  const hasTouch = Boolean(info.project.use.hasTouch);
  await longPress(page, current);
  if (hasTouch) await current.tap(); else await current.click();
  await expect(menu).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await longPress(page, current);
  const other = drawer.locator('a.remote-session:not([aria-current])');
  const destination = await other.getAttribute('href');
  if (hasTouch) await other.tap(); else await other.click();
  await expect(menu).not.toBeVisible();
  await expect(page).toHaveURL(remainingURL!);
  await expect(drawer).toBeVisible();
  if (hasTouch) await other.tap(); else await other.click();
  await expect(page).toHaveURL(destination!);
  await page.goto('/');
  await searchSessions(page, prefix);
  await expect(rows).toHaveCount(2);
});

test('归档运行中的会话不终止Pi、不删除原生记录，恢复后可通过同一owner改名', async ({ page, sessionsDir, workingDir, agentDir, request }, info) => {
  const id = uniqueSessionName(info, 'live-archive');
  namedSession(sessionsDir, workingDir, id, '运行中的原生会话');
  const path = join(sessionsDir, '--home-user-demo-project--', id);
  const original = readFileSync(path, 'utf8');
  const owner = await openFixtureOwner({ agentDir, sessionPath: path, getState: () => ({ state: 'running' }) });
  try {
    await page.goto('/session?id=' + encodeURIComponent(id));
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await searchSessions(page, id, drawer);
    await expect(drawer.locator('a.remote-session')).toHaveCount(1);
    await longPress(page, drawer.locator('a.remote-session'));
    const menu = page.getByRole('menu', { name: '会话操作', exact: true });
    await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名会话', exact: true });
    await rename.getByRole('textbox').fill('保持运行的同一会话');
    await rename.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(drawer.locator('a.remote-session')).toContainText('保持运行的同一会话');
    await longPress(page, drawer.locator('a.remote-session'));
    await menu.getByRole('menuitem', { name: '归档', exact: true }).click();
    await expect(menu).not.toBeVisible();
    await expect(page).toHaveURL('/session?id=' + encodeURIComponent(id));
    await expect(drawer).toBeVisible();
    expect(owner.snapshot().state).toBe('running');
    expect(readFileSync(path, 'utf8').startsWith(original)).toBe(true);
    expect((await request.post('/api/session/archive?id=' + encodeURIComponent(id), { data: { archived: false } })).ok()).toBe(true);
    expect(owner.snapshot().state).toBe('running');
  } finally { await owner.close(); }
});
