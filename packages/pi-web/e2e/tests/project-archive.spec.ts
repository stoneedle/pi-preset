import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession, appendEntry, assistantTextEntry } from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block' });

function session(sessionsDir: string, cwd: string, id: string, name: string) {
  const native = buildSession({ cwd });
  native.entries.push({ type: 'session_info', id: 'name-' + native.entries[0].id, parentId: native.lastId, timestamp: new Date().toISOString(), name });
  writeSession(sessionsDir, id, native.entries);
}
async function menu(page: any, row: any, name = '文件夹操作') {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  await page.mouse.down();
  const panel = page.getByRole('menu', { name, exact: true });
  await expect(panel).toBeVisible();
  await page.mouse.up();
  await expect(panel).toBeVisible();
  return panel;
}

test('文件夹按点击加载，整组归档，单条恢复与新会话复活，旧回复不复活', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'folder').replace(/\.jsonl$/, '');
  const path = join(workingDir, 'archived-project');
  const ids = Array.from({ length: 65 }, (_, n) => prefix + '-' + n + '.jsonl');
  ids.forEach((id, n) => session(sessionsDir, path, id, '目标会话 ' + n));
  const outside = prefix + '-outside.jsonl';
  session(sessionsDir, workingDir, outside, '当前会话');
  let pageReads = 0;
  page.on('request', (r) => { if (new URL(r.url()).searchParams.get('project') === path) pageReads++; });
  const list = async (archived = false) => (await request.get('/api/sessions?limit=100&project=' + encodeURIComponent(path) + (archived ? '&archived=true' : ''))).json();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/session?id=' + encodeURIComponent(outside));
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  const project = drawer.getByRole('region', { name: path, exact: true });
  await expect(project).toBeVisible();
  await expect(project.locator('.remote-project-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(project.locator('.remote-session')).toHaveCount(0);
  expect(pageReads).toBe(0);
  await menu(page, project.locator('.remote-project-toggle'));
  await expect(project.locator('.remote-project-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(project.locator('.remote-session')).toHaveCount(0);
  expect(pageReads).toBe(0);
  await page.keyboard.press('Escape');
  await project.locator('.remote-project-toggle').click();
  await expect(project.locator('.remote-session')).toHaveCount(30);
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(outside));
  expect(pageReads).toBe(1);
  const held: any[] = [];
  await page.route('**/api/project/archive', (route) => { held.push(route); });
  const actions = await menu(page, project.locator('.remote-project-toggle'));
  await expect(actions.getByRole('menuitem')).toHaveText(['归档断开会话', '归档整个文件夹']);
  await actions.getByRole('menuitem', { name: '归档整个文件夹', exact: true }).click();
  await expect(actions).not.toBeVisible();
  await expect(project).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(project).toHaveCount(0);
  await expect.poll(() => held.length).toBe(1);
  await held[0].continue();
  await expect.poll(async () => (await list(true)).total).toBe(65);
  expect((await list()).projects.some((item: any) => item.path === path)).toBe(false);
  const parent = JSON.parse(readFileSync(join(sessionsDir, '--home-user-demo-project--', ids[0]), 'utf8').trim().split('\n').at(-1)!).id;
  appendEntry(sessionsDir, ids[0], assistantTextEntry(parent, '旧会话的新回复仍然归档').entry);
  await expect(project).toHaveCount(0);
  expect((await list()).projects.some((item: any) => item.path === path)).toBe(false);
  await page.unroute('**/api/project/archive');
  await drawer.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '返回会话列表', exact: true })).toBeVisible();
  await expect(project.locator('.remote-session')).toHaveCount(0);
  await project.locator('.remote-project-toggle').click();
  await expect(project.locator('.remote-session')).toHaveCount(30);
  await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
  await drawer.getByRole('searchbox', { name: '搜索会话', exact: true }).fill('目标会话 0');
  await expect(project.locator('.remote-session')).toHaveCount(1);
  await project.locator('.remote-session').click();
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(ids[0]));
  await expect(drawer).not.toBeVisible();
  expect((await list()).sessions.map((item: any) => item.id)).toEqual([ids[0]]);
  expect((await list(true)).total).toBe(64);
  expect((await list()).projects.find((item: any) => item.path === path).archived).toBe(false);
  expect((await request.post('/api/session/archive?id=' + encodeURIComponent(ids[0]), { data: { archived: true } })).ok()).toBe(true);
  expect((await list()).projects.find((item: any) => item.path === path).count).toBe(0);
  expect((await request.post('/api/project/archive', { data: { project: path } })).ok()).toBe(true);
  expect((await list()).projects.some((item: any) => item.path === path)).toBe(false);
  const newId = prefix + '-new.jsonl';
  session(sessionsDir, path, newId, '电脑明确新建的会话');
  await expect.poll(async () => (await list()).sessions.map((item: any) => item.id)).toEqual([newId]);
  expect((await list(true)).total).toBe(65);
  expect((await list()).projects.find((item: any) => item.path === path).archived).toBe(false);
  expect((await request.get('/api/sessions?summary=true&project=' + encodeURIComponent(path))).ok()).toBe(true);
});

test('抽屉归档后刷新不清空已加载行，随后断网仍能打开缓存正文', async ({ page, sessionsDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'archive-offline').replace(/\.jsonl$/, '');
  const current = prefix + '-current.jsonl';
  const victim = prefix + '-victim.jsonl';
  const retained = prefix + '-retained.jsonl';
  session(sessionsDir, workingDir, current, '当前对话');
  session(sessionsDir, workingDir, victim, '归档这一条');
  session(sessionsDir, workingDir, retained, '离线仍可打开的会话');
  await page.setViewportSize({ width: 320, height: 540 });
  await page.goto('/session?id=' + encodeURIComponent(retained));
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('离线保留的草稿');
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const project = drawer.getByRole('region', { name: workingDir, exact: true });
  await expect(project.locator('.remote-session')).toHaveCount(3);
  await project.locator(`[data-session-id="${current}"] a`).click();
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(current));
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(project.locator('.remote-session')).toHaveCount(3);
  await page.evaluate((path) => {
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/sessions' && url.searchParams.get('project') === path)
        await new Promise(() => {});
      return original(...args);
    };
  }, workingDir);
  const actions = await menu(page, project.locator(`[data-session-id="${victim}"] a`), '会话操作');
  const refreshed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/sessions' && url.searchParams.get('summary') === 'true';
  });
  await actions.getByRole('menuitem', { name: '归档', exact: true }).click();
  await (await refreshed).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(project.locator(`[data-session-id="${victim}"]`)).toHaveCount(0);
  await expect(project.locator(`[data-session-id="${retained}"]`)).toHaveCount(1, { timeout: 750 });
  await page.evaluate(() => {
    window.fetch = async () => { throw new TypeError('Simulated tailnet outage'); };
    window.dispatchEvent(new Event('offline'));
  });
  await project.locator(`[data-session-id="${retained}"] a`).click();
  await expect(page).toHaveURL('/session?id=' + encodeURIComponent(retained));
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible({ timeout: 750 });
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('离线保留的草稿');
});

test('项目修订刷新保留超过百条的阅读深度，中途再次变化不混入旧分页', async ({ page, request, sessionsDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'archive-window').replace(/\.jsonl$/, '');
  const ids = Array.from({ length: 130 }, (_, n) => prefix + '-' + String(n).padStart(3, '0') + '.jsonl');
  ids.forEach((id, n) => session(sessionsDir, workingDir, id, '深度窗口 ' + n));
  await page.setViewportSize({ width: 320, height: 540 });
  await page.goto('/session?id=' + encodeURIComponent(ids[129]));
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  const project = drawer.getByRole('region', { name: workingDir, exact: true });
  await expect(project.locator('.remote-session')).toHaveCount(30);
  for (const count of [60, 90, 120, 130]) {
    await project.getByRole('button', { name: '更多会话', exact: true }).click();
    await expect(project.locator('.remote-session')).toHaveCount(count);
  }
  let hold = true;
  const held: any[] = [];
  await page.route('**/api/sessions?*', (route) => {
    const url = new URL(route.request().url());
    if (hold && url.searchParams.get('project') === workingDir && url.searchParams.get('offset') === '100')
      held.push(route);
    else return route.continue();
  });
  const actions = await menu(page, project.locator(`[data-session-id="${ids[0]}"] a`), '会话操作');
  await actions.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  await expect(project.locator('.remote-session')).toHaveCount(129);
  await expect(project.locator(`[data-session-id="${ids[1]}"]`)).toHaveCount(1);
  const added = prefix + '-new.jsonl';
  session(sessionsDir, workingDir, added, '刷新途中新增');
  await expect.poll(async () => (await (await request.get('/api/sessions?project=' + encodeURIComponent(workingDir))).json()).total).toBe(130);
  hold = false;
  await held[0].continue();
  await expect(project.locator(`[data-session-id="${added}"]`)).toHaveCount(1);
  await expect(project.locator('.remote-session')).toHaveCount(130);
  await expect(project.locator(`[data-session-id="${ids[0]}"]`)).toHaveCount(0);
  expect(await project.locator('.remote-session').evaluateAll((nodes) => new Set(nodes.map((node) => node.getAttribute('href'))).size)).toBe(130);
});

test('切换归档后断网返回，分页外当前会话入口和正文仍在', async ({ page, sessionsDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'archive-switch').replace(/\.jsonl$/, '');
  const ids = Array.from({ length: 35 }, (_, n) => prefix + '-' + n + '.jsonl');
  ids.forEach((id, n) => {
    const native = buildSession({ cwd: workingDir });
    native.entries[0].timestamp = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
    writeSession(sessionsDir, id, native.entries);
  });
  await page.setViewportSize({ width: 320, height: 540 });
  await page.goto('/session?id=' + encodeURIComponent(ids[0]));
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  const project = drawer.getByRole('region', { name: workingDir, exact: true });
  await expect(project.locator('.remote-session')).toHaveCount(31);
  await expect(project.locator('[aria-current="page"]')).toBeInViewport();
  await page.evaluate(() => {
    window.fetch = async () => { throw new TypeError('Simulated tailnet outage'); };
    window.dispatchEvent(new Event('offline'));
  });
  await drawer.getByRole('button', { name: '已归档', exact: true }).click();
  await drawer.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(project.locator('.remote-session')).toHaveCount(31, { timeout: 750 });
  await expect(project.locator('[aria-current="page"]')).toBeInViewport();
  await project.locator('[aria-current="page"]').click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
});

test('会话与文件夹归档保持滚动锚点，当前会话归档不导航，批量失败原子回滚', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'archive-anchor').replace(/\.jsonl$/, '');
  const projects = Array.from({ length: 24 }, (_, n) => join(workingDir, 'scroll-' + String(n).padStart(2, '0')));
  projects.forEach((path, n) => session(sessionsDir, path, prefix + '-' + n + '.jsonl', '位置保持 ' + n));
  await page.setViewportSize({ width: 320, height: 540 });
  await page.goto('/');
  const project = page.getByRole('region', { name: projects[12], exact: true });
  await expect(project.locator('.remote-session')).toHaveCount(1);
  await project.evaluate((node) => { const scroll = node.closest('.remote-list-main')!; scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 170; });
  const scroller = page.locator('.remote-list-main');
  const sessionActions = await menu(page, project.locator('.remote-session'), '会话操作');
  const readingAnchor = page.getByRole('region', { name: projects[11], exact: true }).locator('.remote-project-toggle');
  const position = await readingAnchor.evaluate((node) => node.getBoundingClientRect().top);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
  await sessionActions.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect(project.locator('.remote-session')).toHaveCount(0);
  await expect.poll(() => readingAnchor.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(position, 0);
  const folderActions = await menu(page, project.locator('.remote-project-toggle'));
  const folderPosition = await readingAnchor.evaluate((node) => node.getBoundingClientRect().top);
  await folderActions.getByRole('menuitem', { name: '归档整个文件夹', exact: true }).click();
  await expect(project).toHaveCount(0);
  await expect.poll(() => readingAnchor.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(folderPosition, 0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect.poll(() => readingAnchor.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(folderPosition, 0);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);

  const currentId = prefix + '-13.jsonl';
  const nativePath = join(sessionsDir, '--home-user-demo-project--', currentId);
  const original = readFileSync(nativePath, 'utf8');
  const owner = await openFixtureOwner({ agentDir, sessionPath: nativePath, getState: () => ({ state: 'running' }) });
  try {
    await page.goto('/session?id=' + encodeURIComponent(currentId));
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    const currentProject = drawer.getByRole('region', { name: projects[13], exact: true });
    await expect(currentProject.locator('[aria-current="page"]')).toBeInViewport({ ratio: 1 });
    const actions = await menu(page, currentProject.locator('.remote-project-toggle'));
    await actions.getByRole('menuitem', { name: '归档整个文件夹', exact: true }).click();
    await expect(currentProject).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL('/session?id=' + encodeURIComponent(currentId));
    expect(owner.snapshot().state).toBe('running');
    expect(readFileSync(nativePath, 'utf8')).toBe(original);

    const failedPath = projects[14];
    const extra = prefix + '-failure-extra.jsonl';
    session(sessionsDir, failedPath, extra, '原子事务里的另一条');
    const db = new DatabaseSync(join(agentDir, 'pi-web.sqlite'));
    const uuid = JSON.parse(readFileSync(join(sessionsDir, '--home-user-demo-project--', extra), 'utf8').split('\n')[0]).id;
    db.exec(`CREATE TRIGGER reject_project_archive BEFORE INSERT ON session_management WHEN NEW.session_id='${uuid.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT,'模拟批量写入失败'); END;`);
    try {
      const failed = drawer.getByRole('region', { name: failedPath, exact: true });
      const held: any[] = [];
      await page.route('**/api/project/archive', (route) => { held.push(route); });
      const failureMenu = await menu(page, failed.locator('.remote-project-toggle'));
      await failureMenu.getByRole('menuitem', { name: '归档整个文件夹', exact: true }).click();
      await expect(failed).toHaveCount(0);
      await expect.poll(() => held.length).toBe(1);
      await held[0].continue();
      await expect(drawer.getByRole('alert')).toContainText('模拟批量写入失败');
      await expect(failed).toBeVisible();
      const data = await (await request.get('/api/sessions?project=' + encodeURIComponent(failedPath))).json();
      expect(data.total).toBe(2);
      expect(data.projects.find((item: any) => item.path === failedPath).archived).toBe(false);
      expect((await (await request.get('/api/sessions?archived=true&project=' + encodeURIComponent(failedPath))).json()).total).toBe(0);
    } finally { db.exec('DROP TRIGGER reject_project_archive'); db.close(); }
  } finally { await owner.close(); }
});
