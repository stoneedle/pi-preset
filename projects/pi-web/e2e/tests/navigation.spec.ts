import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

async function watchGlobalStream(page: Page) {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    (window as any).__globalStreams = [];
    (window as any).__globalCloses = 0;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (new URL(String(url), location.href).searchParams.get('id') === '__all__') {
          (window as any).__globalStreams.push(this);
          const close = this.close.bind(this);
          this.close = () => { (window as any).__globalCloses++; close(); };
        }
      }
    };
  });
}

test('session navigation keeps the live drawer, expanded projects and loaded pages without restarting global observation', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const ids: string[] = [];
  for (let index = 0; index < 35; index++) {
    const { entries } = buildSession({ cwd: workingDir });
    entries[0].timestamp = new Date(Date.now() - index * 2000).toISOString();
    ids.push(writeSession(sessionsDir, uniqueSessionName(info, `navigation-${index}`), entries));
  }
  const extraDir = join(workingDir, 'expanded-project');
  mkdirSync(extraDir);
  writeSession(sessionsDir, uniqueSessionName(info, 'navigation-extra'), buildSession({ cwd: extraDir }).entries);
  const owners = await Promise.all(ids.slice(0, 2).map((id) => openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', unread: false }) })));
  try {
    for (const id of ids.slice(0, 2)) await expect.poll(async () =>
      (await (await request.get(`/api/status?id=${encodeURIComponent(id)}`)).json()).availability).toBe('connected');
    await watchGlobalStream(page);
    await page.goto(`/session?id=${encodeURIComponent(ids[0])}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
    await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('切换后仍属于第一个会话的草稿');
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const project = drawer.locator('.remote-project').filter({ has: page.locator('.remote-project-label strong', { hasText: basename(workingDir) }) });
    await expect(project.locator('.remote-session')).toHaveCount(30);
    await project.getByRole('button', { name: '更多会话', exact: true }).click();
    await expect(project.locator('.remote-session')).toHaveCount(35);
    const extra = drawer.locator('.remote-project').filter({ has: page.locator('.remote-project-label strong', { hasText: 'expanded-project' }) });
    await extra.locator('.remote-project-toggle').click();
    await expect(extra.locator('.remote-session')).toHaveCount(1);
    // Let the initial owner/list refresh coalesce before measuring navigation itself.
    await page.waitForTimeout(900);
    await drawer.evaluate((element) => {
      (window as any).__drawer = element;
      (window as any).__list = element.querySelector('.remote-session-list');
    });
    let listReads = 0;
    let statusReads = 0;
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/sessions') listReads++;
      if (path === '/api/status') statusReads++;
    });
    for (const id of [ids[1], ids[0], ids[1]]) {
      await drawer.locator(`a.remote-session[href="/session?id=${encodeURIComponent(id)}"]`).click();
      await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);
      await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
      await page.getByRole('button', { name: '会话列表', exact: true }).click();
      expect(await drawer.evaluate((element) => element === (window as any).__drawer && element.querySelector('.remote-session-list') === (window as any).__list)).toBe(true);
      await expect(project.locator('.remote-session')).toHaveCount(35);
      await expect(extra.locator('.remote-project-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(extra.locator('.remote-session')).toHaveCount(1);
      await expect(drawer.locator(`[data-session-id="${id}"] .remote-state`)).toHaveAttribute('data-visual', 'running');
    }
    expect(await page.evaluate(() => ({ count: (window as any).__globalStreams.length, closes: (window as any).__globalCloses }))).toEqual({ count: 1, closes: 0 });
    expect(listReads).toBe(0);
    expect(statusReads).toBe(0);
    await page.goBack();
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('切换后仍属于第一个会话的草稿');
  } finally { await Promise.all(owners.map((owner) => owner.close())); }
});

test('drawer search and active filtering survive session navigation', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const ids = [0, 1].map((index) => {
    const { entries, lastId } = buildSession({ cwd: workingDir });
    entries.push({ type: 'session_info', id: `title-${index}`, parentId: lastId, name: `navigation-filter-${index}` });
    return writeSession(sessionsDir, uniqueSessionName(info, 'navigation-filter'), entries);
  });
  const owners = await Promise.all(ids.map((id) => openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', unread: false }) })));
  try {
    await page.goto(`/session?id=${encodeURIComponent(ids[0])}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await drawer.getByRole('button', { name: '只看活跃会话', exact: true }).click();
    await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
    await drawer.getByRole('searchbox').fill('navigation-filter');
    await expect(drawer.locator('.remote-session')).toHaveCount(2);
    await drawer.locator(`a.remote-session[href="/session?id=${encodeURIComponent(ids[1])}"]`).click();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(ids[1])}`);
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '只看活跃会话', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(drawer.getByRole('searchbox')).toHaveValue('navigation-filter');
    await expect(drawer.getByRole('searchbox')).not.toBeFocused();
    await expect(drawer.locator('.remote-session')).toHaveCount(2);
    await expect(drawer.locator('[aria-current="page"]')).toHaveCount(1);
  } finally { await Promise.all(owners.map((owner) => owner.close())); }
});

test('a fresh bookmarked document bootstraps its message window only once', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'navigation-bootstrap'), buildSession({ cwd: workingDir }).entries);
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', unread: false }) });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
    await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pi-web:reading'))).toBeTruthy();
    const fresh = await page.context().newPage();
    let initialReads = 0;
    fresh.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/session' && !url.searchParams.get('after') && !url.searchParams.has('before') && !url.searchParams.has('forward')) initialReads++;
    });
    await fresh.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(fresh.getByText('Initial reply.', { exact: true })).toBeVisible();
    await expect(fresh.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
    await fresh.waitForTimeout(350);
    expect(initialReads).toBe(1);
  } finally { await owner.close(); }
});

test('an open stream awaiting its snapshot never declares connected Pi owners disconnected', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const ids = [0, 1].map(() => writeSession(sessionsDir, uniqueSessionName(info, 'snapshot-gap'), buildSession({ cwd: workingDir }).entries));
  const owners = await Promise.all(ids.map((id) => openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', unread: false }) })));
  await page.addInitScript(() => {
    (window as any).__holdRuntime = false;
    (window as any).__heldRuntime = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = new Proxy(NativeEventSource, {
      construct(Target, args) {
        const source = new Target(...args);
        const add = source.addEventListener.bind(source);
        source.addEventListener = (name, listener, options) => add(name,
          name.startsWith('status-') ? (event) => {
            const invoke = () => typeof listener === 'function' ? listener.call(source, event) : listener.handleEvent(event);
            if ((window as any).__holdRuntime) (window as any).__heldRuntime.push(invoke);
            else invoke();
          } : listener, options);
        return source;
      },
    });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if ((window as any).__holdRuntime && ['/api/status', '/api/sessions'].includes(path))
        await new Promise<void>((resolve) => (window as any).__heldRuntime.push(resolve));
      return nativeFetch(...args);
    };
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(ids[0])}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    for (const id of ids) await expect(drawer.locator(`[data-session-id="${id}"] .remote-state`)).toHaveAttribute('data-visual', 'running');
    await page.evaluate(() => {
      (window as any).__holdRuntime = true;
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForFunction(() => (window as any).__heldRuntime.length > 0);
    await expect(drawer.locator('.remote-warning')).toHaveCount(0);
    for (const id of ids) {
      await expect(drawer.locator(`[data-session-id="${id}"] .remote-state`)).toHaveAttribute('data-visual', 'unknown');
      await expect(drawer.locator(`[data-session-id="${id}"] .remote-state`)).not.toHaveAttribute('aria-label', '未连接 Pi');
    }
    await page.evaluate(() => {
      (window as any).__holdRuntime = false;
      (window as any).__heldRuntime.splice(0).forEach((resume) => resume());
    });
    for (const id of ids) await expect(drawer.locator(`[data-session-id="${id}"] .remote-state`)).toHaveAttribute('data-visual', 'running');
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-visual', 'running');
  } finally { await page.evaluate(() => (window as any).__heldRuntime?.splice(0).forEach((resume) => resume())).catch(() => {}); await Promise.all(owners.map((owner) => owner.close())); }
});
