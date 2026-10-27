import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { readDiagnostics } from '../lib/diagnostics';
import { startServer, stopServer } from '../lib/server';
import { buildSession, writeSession, uniqueSessionName } from '../lib/sessions';

const outbox = 'pi-web:diagnostic-outbox:';

test('foreground recovery keeps the document and cursor and automatically leaves its trace on the server', async ({ page, context, sessionsDir, agentDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'resume-trace'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  const originalPage = await page.evaluate(() => {
    (window as any).__sameDocument = true;
    return sessionStorage.getItem('pi-web:diagnostic-page');
  });
  const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await input.fill('PRIVATE-DRAFT-MUST-NOT-BE-IN-TRACE');
  const reads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session') reads.push(request.url()); });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await context.setOffline(false);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads.every(url => new URL(url).searchParams.has('after'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
  await expect(input).toHaveValue('PRIVATE-DRAFT-MUST-NOT-BE-IN-TRACE');
  await expect.poll(() => readDiagnostics(agentDir).some(event => event.page === originalPage && event.event === 'session.read' && event.mode === 'after'), { timeout: 15000 }).toBe(true);
  const raw = JSON.stringify(readDiagnostics(agentDir));
  expect(raw).not.toContain('PRIVATE-DRAFT');
  expect(raw).not.toContain('Initial reply.');
  expect(readDiagnostics(agentDir).some(event => event.page === originalPage && event.event === 'page.visibility' && event.hidden)).toBe(true);
  await page.locator('summary[aria-label="更多"]').click();
  await expect(page.getByRole('button', { name: '导出诊断日志', exact: true })).toHaveCount(0);
  await page.locator('summary[aria-label="更多"]').click();
  await input.fill('');
  await Promise.all([
    page.waitForEvent('framenavigated', frame => frame === page.mainFrame()),
    page.evaluate(() => location.reload()),
  ]);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  const current = await page.evaluate(() => sessionStorage.getItem('pi-web:diagnostic-page'));
  expect(current).not.toBe(originalPage);
  await expect.poll(() => readDiagnostics(agentDir).some(event => event.page === current && event.event === 'page.start' && event.navigation === 'reload' && event.previousPage === originalPage), { timeout: 15000 }).toBe(true);
  expect(readDiagnostics(agentDir).some(event => event.page === originalPage && event.event === 'page.reload')).toBe(false);
});

test('manual refresh records its cause on the server without user export', async ({ page, agentDir, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'refresh-trace'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  const originalPage = await page.evaluate(() => sessionStorage.getItem('pi-web:diagnostic-page'));
  await page.locator('summary[aria-label="更多"]').click();
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
  await navigation;
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  await expect.poll(() => readDiagnostics(agentDir).some(event => event.page === originalPage && event.event === 'page.reload' && event.reason === 'manual'), { timeout: 15000 }).toBe(true);
});

test('undelivered diagnostics survive document replacement and automatically catch up when ingestion recovers', async ({ page, agentDir }) => {
  await page.route('**/api/diagnostics', route => route.fulfill({ status: 503 }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始新任务', exact: true })).toBeVisible();
  const originalPage = await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    return sessionStorage.getItem('pi-web:diagnostic-page');
  });
  await expect.poll(() => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, outbox)).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '开始新任务', exact: true })).toBeVisible();
  await page.unroute('**/api/diagnostics');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => readDiagnostics(agentDir).some(event => event.page === originalPage && event.event === 'page.focus'), { timeout: 15000 }).toBe(true);
  await expect.poll(() => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, outbox), { timeout: 15000 }).toBe(0);
});

test('diagnostic failures remain invisible, bounded and independent of editing at 320px', async ({ page, context }) => {
  await page.route('**/api/diagnostics', route => route.fulfill({ status: 503 }));
  await page.setViewportSize({ width: 320, height: 560 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '开始新任务', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => {
    for (let i = 0; i < 350; i++) window.dispatchEvent(new Event('focus'));
  });
  const queued = await page.evaluate(prefix => {
    const values = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => localStorage.getItem(key)!);
    return { count: values.length, bytes: values.reduce((sum, value) => sum + value.length * 2, 0) };
  }, outbox);
  expect(queued.count).toBeGreaterThan(0);
  expect(queued.count).toBeLessThanOrEqual(64);
  expect(queued.bytes).toBeLessThanOrEqual(256 * 1024);
  await expect(page.getByRole('button', { name: '导出诊断日志', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const input = page.getByRole('dialog', { name: '新对话', exact: true }).getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await input.fill('诊断故障不影响离线编辑');
  await expect(input).toHaveValue('诊断故障不影响离线编辑');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('denied browser storage cannot prevent automatic server logging or normal use', async ({ page, agentDir, sessionsDir, workingDir }, info) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('storage unavailable', 'QuotaExceededError'); };
    Storage.prototype.getItem = () => { throw new DOMException('storage unavailable', 'SecurityError'); };
  });
  let diagnosticPage = '';
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/diagnostics') diagnosticPage ||= request.postDataJSON().page;
  });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'trace-storage-denied'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
  await expect.poll(() => readDiagnostics(agentDir).some(event => event.page === diagnosticPage && event.event === 'page.start'), { timeout: 15000 }).toBe(true);
});

test('ingestion is authenticated, metadata-only, deduplicated, size-limited and rotated, and disk failures do not break the app', async () => {
  const server = await startServer({ token: 'diagnostics-test-token' });
  try {
    const url = server.baseURL + '/api/diagnostics';
    const headers = { Cookie: 'pi_token=diagnostics-test-token', 'Content-Type': 'application/json' };
    const event = { seq: 1, time: Date.now(), elapsed: 1, event: 'page.start', navigation: 'navigate', message: 'PRIVATE-CONTENT-MUST-BE-DROPPED', url: 'https://secret.invalid/?token=PRIVATE' };
    const batch = { client: 'cafe1234', page: 'face1234', build: 'app-test.js', userAgent: 'diagnostic-e2e', events: [event] };
    const post = (body = batch, extraHeaders = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })).status).toBe(401);
    expect((await post(batch, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(url, { headers })).status).toBe(405);
    const dir = join(server.agentDir, 'pi-web', 'diagnostics');
    expect(existsSync(dir)).toBe(false);
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(204);
    const records = readDiagnostics(server.agentDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ client: batch.client, page: batch.page, event: 'page.start', seq: 1 });
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
    expect((await post({ ...batch, events: [{ ...event, seq: 2, message: 'x'.repeat(40000) }] })).status).toBe(413);
    writeFileSync(join(dir, 'browser.jsonl'), Buffer.alloc(4 << 20, ' '));
    writeFileSync(join(dir, 'browser.1.jsonl'), 'previous-log');
    writeFileSync(join(dir, 'browser.2.jsonl'), 'oldest-log');
    expect((await post({ ...batch, events: [{ ...event, seq: 2 }] })).status).toBe(204);
    expect(readdirSync(dir).sort()).toEqual(['browser.1.jsonl', 'browser.2.jsonl', 'browser.jsonl']);
    expect(readFileSync(join(dir, 'browser.1.jsonl')).length).toBe(4 << 20);
    expect(readFileSync(join(dir, 'browser.2.jsonl'), 'utf8')).toBe('previous-log');
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'block-log-directory');
    expect((await post({ ...batch, events: [{ ...event, seq: 3 }] })).status).toBe(503);
    expect((await fetch(server.baseURL + '/', { headers })).status).toBe(200);
  } finally {
    await stopServer(server.child);
    rmSync(server.agentDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});
