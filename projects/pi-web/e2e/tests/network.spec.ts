import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

// These tests hold the actual fetch consumer, including WebKit service-worker requests.
test('losing live updates is not a bridge error and does not block a single HTTP send', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'transport-not-owner'), buildSession({ cwd: workingDir }).entries);
  const sends: string[] = [];
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    control: (input) => { if (input.action === 'send') sends.push(input.chat.message); return { status: 'accepted' }; } });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'idle');
    // Lose only SSE; HTTP remains usable, as with an interrupted mobile stream.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'unknown');
    await expect(page.getByText('控制桥接未连接', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '在后台继续', exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('send despite lost live updates');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => sends).toEqual(['send despite lost live updates']);
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'idle');
  } finally { await owner.close(); }
});

test('empty native text never takes down a conversation', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'empty-text', parentId: lastId,
    message: { role: 'assistant', content: [{ type: 'text', text: '' }] } });
  entries.push(assistantTextEntry('empty-text', 'Reply after an empty native text.').entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'empty-text'), entries);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Reply after an empty native text.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '会话列表', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('drawer retains its loaded rows and search without waiting for another network trip', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'instant-drawer'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const trigger = page.getByRole('button', { name: '会话列表', exact: true });
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  await trigger.click();
  await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
  const search = drawer.getByRole('searchbox');
  await search.fill(id);
  await expect(drawer.locator('.remote-session')).toHaveCount(1);
  await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname === '/api/sessions')
        await new Promise(() => {});
      return nativeFetch(...args);
    };
  });
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(search).toHaveValue(id, { timeout: 500 });
  await expect(drawer.locator('.remote-session')).toHaveCount(1, { timeout: 500 });
});

test('returning to a visited conversation is local and preserves its draft during an outage', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, 'Previously read reply stays visible offline.').entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'cached-conversation'), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, 'cached-other'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Previously read reply stays visible offline.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('保留未发送草稿');
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '会话', exact: true });
  await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
  await drawer.getByRole('searchbox').fill(other);
  await expect(drawer.locator('.remote-session')).toHaveCount(1);
  await drawer.locator('.remote-session').click();
  await expect(page).toHaveURL(`/session?id=${encodeURIComponent(other)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(2);
  let documents = 0;
  page.on('request', (request) => { if (request.isNavigationRequest()) documents++; });
  await page.evaluate(() => {
    window.fetch = async () => { throw new TypeError('Simulated tailnet outage'); };
  });
  await page.goBack();
  await expect(page).toHaveURL(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Previously read reply stays visible offline.', { exact: true })).toBeVisible({ timeout: 750 });
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('保留未发送草稿');
  expect(documents).toBe(0);
});

test('a send receipt survives session navigation without losing the next draft', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'pending-receipt'), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, 'pending-other'), buildSession({ cwd: workingDir }).entries);
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id) });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname === '/api/chat')
        return new Promise<Response>((resolve) => {
          (window as any).__releaseSend = () => resolve(new Response('{}', {
            headers: { 'Content-Type': 'application/json' },
          }));
        });
      return nativeFetch(...args);
    };
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const input = page.getByRole('textbox', { name: '给 Pi 发消息…' });
    await input.fill('等待回执的消息');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => (window as any).__releaseSend);
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    await page.getByRole('dialog', { name: '会话', exact: true }).getByRole('button', { name: '搜索会话', exact: true }).click();
    await page.getByRole('dialog', { name: '会话', exact: true }).getByRole('searchbox').fill(other);
    await page.locator(`a.remote-session[href="/session?id=${encodeURIComponent(other)}"]`).click();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(other)}`);
    await page.goBack();
    await expect(input).toHaveValue('等待回执的消息');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await input.fill('发送期间继续写的下一份草稿');
    await page.evaluate(() => (window as any).__releaseSend());
    await expect(input).toHaveValue('发送期间继续写的下一份草稿');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await expect(page.locator('.remote-compose-context [role=status]')).toHaveCount(0);
  } finally { await owner.close(); }
});

test('transient read failures recover automatically without a manual retry', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'retry-content'), entries);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let attempts = 0;
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname === '/api/session' && ++attempts <= 5)
        return new Response(JSON.stringify({ error: 'Temporary transport failure' }), {
          status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
        });
      return nativeFetch(...args);
    };
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a stalled response body times out and does not block the next content refresh', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'stalled-body'), entries);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let held = false;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!held && new URL(String(args[0]), location.href).pathname === '/api/session') {
        held = true;
        (window as any).__bodyStalled = true;
        response.json = () => new Promise(() => {});
      }
      return response;
    };
  });
  await page.clock.install();
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.waitForFunction(() => (window as any).__bodyStalled);
  await page.clock.fastForward(12500);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
});

test('a silently dead event stream reconnects without declaring Pi finished', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'half-open'), entries);
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running' }) });
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    (window as any).__streams = [];
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as any).__streams.push(this);
      }
    };
  });
  try {
    await page.clock.install();
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'running');
    const count = await page.evaluate(() => (window as any).__streams.length);
    await page.evaluate((id) => {
      const stream = (window as any).__streams.find((source: EventSource) => new URL(source.url).searchParams.get('id') === id);
      stream.close(); // No error or online event: reproduce a half-open mobile transport.
    }, id);
    await page.clock.fastForward(46000);
    await expect.poll(() => page.evaluate(() => (window as any).__streams.length)).toBeGreaterThan(count);
    await expect(page.locator('.remote-header > .remote-state')).toHaveAttribute('data-state', 'running');
    await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  } finally { await owner.close(); }
});

test('an uncertain send is never replayed automatically and keeps the unsent draft', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'no-replay'), entries);
  const owner = await openFixtureOwner({ agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id) });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    (window as any).__chatAttempts = 0;
    let held = false;
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname === '/api/chat') {
        (window as any).__chatAttempts++;
        return new Response(JSON.stringify({ error: 'Simulated lost acknowledgement' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
      const response = await nativeFetch(...args);
      if (!held && new URL(String(args[0]), location.href).pathname === '/api/session') {
        held = true;
        await new Promise<void>((resolve) => { (window as any).__releaseContent = resolve; });
      }
      return response;
    };
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await page.waitForFunction(() => (window as any).__releaseContent);
    await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('不能重复发送');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const recovery = page.locator('[data-recovery-message]');
    await expect(recovery).toContainText('未确认是否发送成功');
    await recovery.getByRole('button', { name: '未确认是否发送成功', exact: true }).click();
    await expect(recovery).toContainText('Simulated lost acknowledgement');
    await page.evaluate(() => (window as any).__releaseContent());
    await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
    await expect(recovery).toContainText('Simulated lost acknowledgement');
    await page.waitForTimeout(1800);
    expect(await page.evaluate(() => (window as any).__chatAttempts)).toBe(1);
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('不能重复发送');
  } finally { await owner.close(); }
});
