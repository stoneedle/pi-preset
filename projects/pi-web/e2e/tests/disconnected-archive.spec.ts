import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block' });

function session(sessionsDir: string, cwd: string, id: string, name: string) {
  const native = buildSession({ cwd });
  native.entries.push({ type: 'session_info', id: 'title-' + native.entries[0].id, parentId: native.lastId, timestamp: new Date().toISOString(), name });
  writeSession(sessionsDir, id, native.entries);
  return native.entries[0].id;
}

async function longPress(page: any, target: any, name: string) {
  await target.scrollIntoViewIfNeeded();
  await target.click({ trial: true });
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const panel = page.getByRole('menu', { name, exact: true });
  if (page.context().browser()?.browserType().name() === 'chromium' && await page.evaluate(() => navigator.maxTouchPoints > 0)) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await expect(panel).toBeVisible();
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await client.detach(); }
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(panel).toBeVisible();
    await page.mouse.up();
  }
  await expect(panel).toBeVisible();
  return panel;
}

test('文件夹批量归档跨未加载页与搜索，提交时跳过重连及所有已连接状态', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'disconnected-folder').replace(/\.jsonl$/, '');
  const cwd = join(workingDir, '批量清理');
  const ids = Array.from({ length: 65 }, (_, n) => prefix + '-' + n + '.jsonl');
  ids.forEach((id, n) => session(sessionsDir, cwd, id, n === 4 ? '唯一搜索匹配' : '未匹配会话 ' + n));
  const outside = prefix + '-outside.jsonl';
  session(sessionsDir, workingDir, outside, '其他文件夹保持不变');
  const nativePath = (id: string) => join(sessionsDir, '--home-user-demo-project--', id);
  const originals = ids.map((id) => readFileSync(nativePath(id), 'utf8'));
  const owners: any[] = [];
  const list = async (path = cwd, archived = false) => (await request.get('/api/sessions?limit=100&project=' + encodeURIComponent(path) + (archived ? '&archived=true' : ''))).json();
  try {
    for (const [n, state] of ['running', 'idle', 'unknown'].entries()) {
      owners.push(await openFixtureOwner({ agentDir, sessionPath: nativePath(ids[n]), getState: () => ({ state }) }));
      await expect.poll(async () => (await (await request.get('/api/status?id=' + encodeURIComponent(ids[n]))).json()).availability).toBe('connected');
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: '搜索会话', exact: true });
    await search.fill('唯一搜索匹配');
    const project = page.getByRole('region', { name: cwd, exact: true });
    await expect(project.locator('.remote-session')).toHaveCount(1);
    let held: any;
    let calls = 0;
    await page.route('**/api/sessions/archive-disconnected', (route) => { calls++; held = route; });
    const actions = await longPress(page, project.locator('.remote-project-toggle'), '文件夹操作');
    await expect(actions.getByRole('menuitem')).toHaveText(['归档断开会话', '归档整个文件夹']);
    await actions.getByRole('menuitem', { name: '归档断开会话', exact: true }).click();
    await expect(actions).not.toBeVisible();
    await expect.poll(() => calls).toBe(1);
    expect(held.request().postDataJSON()).toEqual({ project: cwd });
    await longPress(page, project.locator('.remote-project-toggle'), '文件夹操作');
    await expect(actions.getByRole('menuitem', { name: '归档中…', exact: true })).toBeDisabled();
    await expect(actions.getByRole('menuitem', { name: '归档整个文件夹', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    // The browser chose the action while this session was disconnected; the server must recheck it.
    owners.push(await openFixtureOwner({ agentDir, sessionPath: nativePath(ids[3]), getState: () => ({ state: 'background' }) }));
    await expect.poll(async () => (await (await request.get('/api/status?id=' + encodeURIComponent(ids[3]))).json()).availability).toBe('connected');
    const response = page.waitForResponse('**/api/sessions/archive-disconnected');
    await held.continue();
    expect((await (await response).json()).count).toBe(61);
    await search.fill('');
    await expect(project.locator('.remote-session')).toHaveCount(4);
    expect((await list()).sessions.map((item: any) => item.id).sort()).toEqual(ids.slice(0, 4).sort());
    expect((await list(cwd, true)).total).toBe(61);
    expect((await list(workingDir)).sessions.map((item: any) => item.id)).toEqual([outside]);
    expect((await list()).projects.find((item: any) => item.path === cwd).archived).toBe(false);
    expect(ids.map((id) => readFileSync(nativePath(id), 'utf8'))).toEqual(originals);
    expect(existsSync(join(agentDir, 'pi-web', 'owners', ids[4] + '.json'))).toBe(false);
    expect(await project.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(calls).toBe(1);
  } finally { for (const owner of owners) await owner.close(); }
});

test('首页与抽屉归档图标长按不切视图，全局清理不依赖网页SSE且保留当前草稿', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'disconnected-all').replace(/\.jsonl$/, '');
  const current = prefix + '-current.jsonl', hidden = prefix + '-hidden.jsonl', live = prefix + '-live.jsonl';
  const other = join(workingDir, '未展开目录');
  session(sessionsDir, workingDir, current, '只匹配当前');
  session(sessionsDir, other, hidden, '未加载断开会话');
  session(sessionsDir, other, live, '在线会话不能归档');
  const nativePath = join(sessionsDir, '--home-user-demo-project--', current);
  const original = readFileSync(nativePath, 'utf8');
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', live), getState: () => ({ state: 'running' }) });
  let archivedIds: string[] = [];
  let calls = 0;
  try {
    await expect.poll(async () => (await (await request.get('/api/status?id=' + encodeURIComponent(live))).json()).availability).toBe('connected');
    await page.route('**/events?*', (route) => route.abort());
    await page.route('**/api/sessions/archive-disconnected', async (route) => {
      calls++;
      expect(route.request().postDataJSON()).toEqual({});
      const response = await route.fetch();
      archivedIds = (await response.json()).ids;
      await route.fulfill({ response });
    });
    await page.setViewportSize({ width: 320, height: 540 });
    await page.goto('/');
    const homeActions = await longPress(page, page.getByRole('button', { name: '已归档', exact: true }), '归档操作');
    await expect(homeActions.getByRole('menuitem')).toHaveText(['归档所有断开会话']);
    await expect(page.getByRole('region', { name: '会话列表', exact: true })).toBeVisible();
    expect(calls).toBe(0);
    await page.keyboard.press('Escape');
    const archiveButton = page.getByRole('button', { name: '已归档', exact: true });
    await archiveButton.focus();
    await page.keyboard.press('Shift+F10');
    await expect(homeActions.getByRole('menuitem')).toBeFocused();
    await page.keyboard.press('Escape');
    await archiveButton.click({ button: 'right' });
    await expect(homeActions).toBeVisible();
    await page.keyboard.press('Escape');
    await archiveButton.click();
    await expect(page.getByRole('region', { name: '已归档会话列表', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
    await page.goto('/session?id=' + encodeURIComponent(current));
    const composer = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await composer.fill('批量归档后仍要继续编辑的草稿');
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await expect(drawer.getByRole('region', { name: other, exact: true }).locator('.remote-session')).toHaveCount(0);
    await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
    await drawer.getByRole('searchbox').fill('只匹配当前');
    await expect(drawer.locator('.remote-session')).toHaveCount(1);
    await expect(drawer.getByRole('status')).toContainText('实时更新连接中');
    const actions = await longPress(page, drawer.getByRole('button', { name: '已归档', exact: true }), '归档操作');
    const box = (await actions.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: info.outputPath('disconnected-archive-menu-320.png'), animations: 'disabled' });
    await actions.getByRole('menuitem', { name: '归档所有断开会话', exact: true }).click();
    await expect(actions).not.toBeVisible();
    await expect.poll(() => archivedIds.includes(hidden)).toBe(true);
    expect(archivedIds).toContain(current);
    expect(archivedIds).not.toContain(live);
    await expect(drawer.locator('.remote-session')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL('/session?id=' + encodeURIComponent(current));
    await drawer.getByRole('searchbox').fill('');
    const emptied = drawer.getByRole('region', { name: workingDir, exact: true });
    await expect(emptied).toBeVisible();
    await expect(emptied.locator('.remote-project-count')).toHaveText('0');
    await page.screenshot({ path: info.outputPath('disconnected-archive-320.png'), animations: 'disabled' });
    await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
    await expect(composer).toHaveValue('批量归档后仍要继续编辑的草稿');
    expect(readFileSync(nativePath, 'utf8')).toBe(original);
    expect(existsSync(join(agentDir, 'pi-web', 'owners', current + '.json'))).toBe(false);
    expect(owner.snapshot().state).toBe('running');
    expect(calls).toBe(1);
  } finally {
    await owner.close();
    // The all-scope action may include fixtures from earlier tests sharing this worker.
    for (const id of archivedIds) await request.post('/api/session/archive?id=' + encodeURIComponent(id), { data: { archived: false } });
  }
});

test('批量写入失败全量回滚、不重放；再次清理和零条清理均保留空目录', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'disconnected-rollback').replace(/\.jsonl$/, '');
  const ids = [prefix + '-a.jsonl', prefix + '-b.jsonl'];
  const uuid = session(sessionsDir, workingDir, ids[0], '事务失败目标');
  session(sessionsDir, workingDir, ids[1], '先写入后回滚');
  const db = new DatabaseSync(join(agentDir, 'pi-web.sqlite'));
  db.exec(`CREATE TRIGGER reject_disconnected_archive BEFORE INSERT ON session_management WHEN NEW.session_id='${uuid}' BEGIN SELECT RAISE(ABORT,'模拟断开归档失败'); END;`);
  let calls = 0;
  try {
    await page.route('**/api/sessions/archive-disconnected', (route) => { calls++; return route.continue(); });
    await page.goto('/');
    const project = page.getByRole('region', { name: workingDir, exact: true });
    await expect(project.locator('.remote-session')).toHaveCount(2);
    const actions = await longPress(page, project.locator('.remote-project-toggle'), '文件夹操作');
    await actions.getByRole('menuitem', { name: '归档断开会话', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('模拟断开归档失败');
    await expect(project.locator('.remote-session')).toHaveCount(2);
    const list = async (archived = false) => (await request.get('/api/sessions?project=' + encodeURIComponent(workingDir) + (archived ? '&archived=true' : ''))).json();
    expect((await list()).total).toBe(2);
    expect((await list(true)).total).toBe(0);
    expect(calls).toBe(1);
    db.exec('DROP TRIGGER reject_disconnected_archive');
    await longPress(page, project.locator('.remote-project-toggle'), '文件夹操作');
    await actions.getByRole('menuitem', { name: '归档断开会话', exact: true }).click();
    await expect(project.locator('.remote-session')).toHaveCount(0);
    await expect(project.locator('.remote-project-count')).toHaveText('0');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await list()).projects.find((item: any) => item.path === workingDir).archived).toBe(false);
    const empty = await request.post('/api/sessions/archive-disconnected', { data: { project: workingDir } });
    expect(await empty.json()).toEqual({ ids: [], count: 0 });
    expect((await request.get('/api/sessions/archive-disconnected')).status()).toBe(405);
    expect(calls).toBe(2);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_disconnected_archive');
    db.close();
  }
});
