import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block' });

test('铃铛筛选分页外的未读、主任务、子任务和待处理会话，实时更新且保留搜索与草稿', async ({ page, request, sessionsDir, workingDir, agentDir }, info) => {
  const prefix = uniqueSessionName(info, 'active-drawer').replace(/\.jsonl$/, '');
  const quiet = join(workingDir, 'Quiet'), inbox = join(workingDir, 'Inbox'), waiting = join(workingDir, 'Waiting');
  for (const path of [quiet, inbox, waiting]) mkdirSync(path);
  const make = (label: string, cwd: string, reply = false, timestamp = '2025-01-01T00:00:00Z') => {
    const native = buildSession({ cwd });
    native.entries[0].timestamp = timestamp;
    const id = writeSession(sessionsDir, `${prefix}-${label}.jsonl`, reply ? native.entries : native.entries.slice(0, 2));
    return { id, replyId: native.lastId, path: join(sessionsDir, '--home-user-demo-project--', id) };
  };
  const current = make('current', quiet);
  for (let index = 0; index < 34; index++) make(`quiet-${index}`, quiet, false, '2026-01-01T00:00:00Z');
  const running = make('running', inbox), child = make('child', inbox), attention = make('attention', waiting);
  const unread = make('unread', inbox, true), archived = make('archived', inbox, true);
  const idle = make('idle', quiet), unknown = make('unknown', quiet);
  let state = 'running';
  const owners = await Promise.all([
    openFixtureOwner({ agentDir, sessionPath: running.path, getState: () => ({ state }) }),
    openFixtureOwner({ agentDir, sessionPath: child.path, getState: () => ({ state: 'background' }) }),
    openFixtureOwner({ agentDir, sessionPath: attention.path, getState: () => ({ state: 'needs-you', attentionId: 'confirmation' }) }),
    openFixtureOwner({ agentDir, sessionPath: idle.path, getState: () => ({ state: 'idle' }) }),
    openFixtureOwner({ agentDir, sessionPath: unknown.path, getState: () => ({ state: 'unknown' }) }),
  ]);
  const records = [current, running, child, attention, unread, archived, idle, unknown];
  const before = records.map(item => readFileSync(item.path, 'utf8'));
  const listURL = '/api/sessions?active=true&q=' + encodeURIComponent(prefix);
  const activeIds = async () => (await (await request.get(listURL + '&limit=100')).json()).sessions.map((item: { id: string }) => item.id).sort();
  const expected = [running.id, child.id, attention.id, unread.id].sort();
  try {
    expect((await request.post('/api/session/archive?id=' + encodeURIComponent(archived.id), { data: { archived: true } })).ok()).toBe(true);
    await expect.poll(activeIds).toEqual(expected);
    const first = await (await request.get(listURL + '&limit=1')).json();
    const second = await (await request.get(listURL + '&limit=1&offset=1')).json();
    expect(first.total).toBe(4);
    expect(first.sessions).toHaveLength(1);
    expect(second.sessions).toHaveLength(1);
    expect(first.sessions[0].id).not.toBe(second.sessions[0].id);
    expect(first.projects.reduce((sum: number, project: { count: number }) => sum + project.count, 0)).toBe(4);

    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/session?id=' + encodeURIComponent(current.id));
    const composer = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await composer.fill('筛选不能丢失当前草稿');
    await composer.blur();
    const trigger = page.getByRole('button', { name: '会话列表', exact: true });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
    const search = drawer.getByRole('searchbox');
    await search.fill(prefix);
    await expect(drawer.locator('.remote-session')).toHaveCount(31);
    const bell = drawer.getByRole('button', { name: '只看活跃会话', exact: true });
    await expect(bell).toHaveAttribute('aria-pressed', 'false');
    await bell.click();
    await expect(bell).toHaveAttribute('aria-pressed', 'true');
    const visibleIds = () => drawer.locator('.remote-session').evaluateAll(nodes => nodes.map(node => new URL((node as HTMLAnchorElement).href).searchParams.get('id')).sort());
    await expect.poll(visibleIds).toEqual(expected);
    await expect(drawer.locator('.remote-project-label strong')).toHaveText(['Inbox', 'Waiting']);
    await expect(search).toHaveValue(prefix);
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    expect(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('active-drawer-320-keyboard.png'), animations: 'disabled' });

    state = 'idle'; owners[0].publish();
    await expect.poll(visibleIds).toEqual(expected.filter(id => id !== running.id));
    state = 'running'; owners[0].publish();
    await expect.poll(visibleIds).toEqual(expected);
    expect((await request.post('/api/session/acknowledge?id=' + encodeURIComponent(unread.id), { data: { replyId: unread.replyId } })).ok()).toBe(true);
    await expect.poll(visibleIds).toEqual(expected.filter(id => id !== unread.id));
    await owners[1].close();
    const remaining = [running.id, attention.id].sort();
    await expect.poll(visibleIds).toEqual(remaining);

    await drawer.getByRole('button', { name: '已归档', exact: true }).click();
    await expect(bell).toHaveCount(0);
    await drawer.getByRole('searchbox').fill(prefix);
    await expect(drawer.locator('.remote-session')).toHaveCount(1);
    await drawer.getByRole('button', { name: '返回会话列表', exact: true }).click();
    await expect(bell).toHaveAttribute('aria-pressed', 'true');
    await expect(search).toHaveValue(prefix);
    await expect.poll(visibleIds).toEqual(remaining);
    await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
    await expect(composer).toHaveValue('筛选不能丢失当前草稿');
    await trigger.click();
    await expect(bell).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(visibleIds).toEqual(remaining);
    await bell.click();
    await expect(drawer.locator('.remote-project-label strong')).toContainText(['Inbox', 'Quiet', 'Waiting']);
    await expect(search).toHaveValue(prefix);
    expect(records.map(item => readFileSync(item.path, 'utf8'))).toEqual(before);
  } finally {
    await Promise.all(owners.map(owner => owner.close()));
  }
});

test('无搜索时活跃项目自动展开并继续分页，不混入当前已读空闲行', async ({ page, sessionsDir, workingDir }, info) => {
  const prefix = uniqueSessionName(info, 'active-pagination').replace(/\.jsonl$/, '');
  const current = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, `${prefix}-current.jsonl`, current.entries.slice(0, 2));
  for (let index = 0; index < 35; index++) {
    writeSession(sessionsDir, `${prefix}-${index}.jsonl`, buildSession({ cwd: workingDir }).entries);
  }
  await page.goto('/session?id=' + encodeURIComponent(id));
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  await drawer.getByRole('button', { name: '只看活跃会话', exact: true }).click();
  const project = drawer.getByRole('region', { name: workingDir, exact: true });
  await expect(project.locator('.remote-project-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => project.locator('.remote-session').count()).toBeGreaterThanOrEqual(30);
  await project.locator('.remote-session').last().scrollIntoViewIfNeeded();
  await expect(project.locator('.remote-session')).toHaveCount(35);
  await expect(project.locator('.remote-project-count')).toHaveText('35');
  await expect(project.locator('a[aria-current="page"]')).toHaveCount(0);
  expect(await project.locator('.remote-session').evaluateAll(nodes => new Set(nodes.map(node => (node as HTMLAnchorElement).href)).size)).toBe(35);
});

test('活跃筛选为空时不保留当前空闲会话，迟到的筛选响应不覆盖全部列表', async ({ page, request, sessionsDir, workingDir }, info) => {
  const native = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'active-empty'), native.entries);
  await page.goto('/session?id=' + encodeURIComponent(id));
  await expect.poll(async () => (await (await request.get('/api/status?id=' + encodeURIComponent(id))).json()).unread).toBe(false);
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
  await drawer.getByRole('searchbox').fill(id);
  await expect(drawer.locator('.remote-session')).toHaveCount(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/sessions?*', async route => {
    if (new URL(route.request().url()).searchParams.get('active') === 'true') {
      const response = await route.fetch();
      held = true;
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const bell = drawer.getByRole('button', { name: '只看活跃会话', exact: true });
    await bell.click();
    await expect.poll(() => held).toBe(true);
    await bell.click();
    await expect(drawer.locator('.remote-session')).toHaveCount(1);
    release();
    await expect(bell).toHaveAttribute('aria-pressed', 'false');
    await expect(drawer.locator('.remote-session')).toHaveCount(1);
    await bell.click();
    await expect(drawer.getByText('没有匹配的会话', { exact: true })).toBeVisible();
    await expect(drawer.locator('.remote-session')).toHaveCount(0);
    await drawer.getByRole('searchbox').fill('');
    // Other worker-local fixtures may exist; the current read, idle session must never be injected.
    await expect(drawer.locator(`a[href="/session?id=${encodeURIComponent(id)}"]`)).toHaveCount(0);
  } finally { release(); }
});
