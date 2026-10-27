import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { readDiagnostics } from '../lib/diagnostics';
import { appendEntry, assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=';
const image = { name: 'new-local-image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };

test('回执丢失时只在输入区保留恢复入口，历史不猜测确认且可离线保存图片', async ({ page, context, sessionsDir, agentDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  (entries[1].message as any).content = [
    { type: 'text', text: '继续看这张图' },
    { type: 'image', mimeType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' },
  ];
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'late-receipt'), entries);
  const sessionPath = join(sessionsDir, '--home-user-demo-project--', id);
  let calls = 0;
  const owner = await openFixtureOwner({ agentDir, sessionPath, getState: () => ({ state: 'running' }), control: (input: any) => {
    if (input.action === 'send') calls++;
    return { status: 'accepted' };
  } });
  await page.addInitScript(() => {
    const native = window.fetch.bind(window);
    let held = false;
    window.fetch = async (...args) => {
      const response = await native(...args);
      if (new URL(String(args[0]), location.href).pathname === '/api/chat')
        throw new TypeError('Lost send acknowledgement');
      if (new URL(String(args[0]), location.href).pathname === '/api/session' && !held) {
        held = true;
        await new Promise<void>(resolve => { (window as any).__releaseSession = resolve; });
      }
      return response;
    };
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await page.waitForFunction(() => Boolean((window as any).__releaseSession));
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await input.fill('继续看这张图');
    await page.locator('.remote-composer input[type=file]').setInputFiles(image);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue('继续看这张图');
    const local = page.locator('[data-recovery-message]');
    await expect(local).toContainText('未确认是否发送成功');
    await local.getByRole('button', { name: '未确认是否发送成功', exact: true }).click();
    await expect(local).toContainText(image.name);
    await page.evaluate(() => (window as any).__releaseSession());
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    // Give every queued incremental refresh an opportunity to encounter the old record.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(local).toContainText('继续看这张图');
    await expect(local).toContainText(image.name);
    expect(calls).toBe(1);
    expect(readFileSync(sessionPath, 'utf8').split('\n').filter(line => line.includes('"role":"user"'))).toHaveLength(1);
    await page.setViewportSize({ width: 320, height: 380 });
    await input.fill('忽略消息不能删除这份草稿');
    await page.locator('.remote-composer input[type=file]').setInputFiles({ ...image, name: 'next-draft.png' });
    await context.setOffline(true);
    const downloading = page.waitForEvent('download');
    await local.getByRole('link', { name: `保存图片：${image.name}`, exact: true }).click();
    const download = await downloading;
    const chunks: Buffer[] = [];
    for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(image.buffer);
    expect(download.suggestedFilename()).toBe(image.name);
    page.once('dialog', dialog => dialog.dismiss());
    await local.getByRole('button', { name: '忽略这条消息', exact: true }).click();
    await expect(local).toContainText(image.name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('recovery-320-expanded.png') });
    page.once('dialog', dialog => dialog.accept());
    await local.getByRole('button', { name: '忽略这条消息', exact: true }).click();
    await expect(local).toHaveCount(0);
    await expect(input).toHaveValue('忽略消息不能删除这份草稿');
    await expect(page.getByRole('button', { name: '移除 next-draft.png', exact: true })).toBeVisible();
    expect(calls).toBe(1);
  } finally {
    await page.evaluate(() => (window as any).__releaseSession?.()).catch(() => {});
    await owner.close();
  }
});

test('工具与思考正文在断网切换会话后仍可展开，不重新下载', async ({ page, context, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const tool = randomUUID(), call = randomUUID();
  entries.push({ type: 'message', id: tool, parentId: lastId, message: { role: 'assistant', stopReason: 'toolUse', content: [
    { type: 'thinking', thinking: '已经读过的完整思考\n' + '保留推理细节。'.repeat(50) },
    { type: 'toolCall', id: call, name: 'bash', arguments: { command: 'print-loaded-body' } },
  ] } });
  entries.push({ type: 'message', id: randomUUID(), parentId: tool, message: { role: 'toolResult', toolCallId: call, content: [{ type: 'text', text: 'ALREADY_LOADED_TOOL_RESULT_123' }] } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'cached-block'), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, 'cached-other'), buildSession({ cwd: workingDir }).entries);
  const reads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session/block') reads.push(request.url()); });
  await page.goto(`/session?id=${encodeURIComponent(other)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(2);
  await page.evaluate(id => { history.pushState(null, '', `/session?id=${encodeURIComponent(id)}`); window.dispatchEvent(new PopStateEvent('popstate')); }, id);
  const toggle = page.locator('.remote-block-toggle').filter({ hasText: 'print-loaded-body' });
  await toggle.click();
  await page.getByRole('button', { name: '展开推理内容', exact: true }).click();
  await expect(page.locator('.remote-main')).toContainText('ALREADY_LOADED_TOOL_RESULT_123');
  await expect(page.locator('.remote-block-thinking .remote-block-body')).toContainText('保留推理细节。'.repeat(50));
  await page.getByRole('button', { name: '收起推理内容', exact: true }).click();
  expect(reads).toHaveLength(2);
  await context.setOffline(true);
  await page.goBack();
  await expect(page.locator('[data-message-id]')).toHaveCount(2);
  await page.goForward();
  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  await toggle.click();
  await page.getByRole('button', { name: '展开推理内容', exact: true }).click();
  await expect(page.locator('.remote-main')).toContainText('ALREADY_LOADED_TOOL_RESULT_123');
  await expect(page.locator('.remote-block-thinking .remote-block-body')).toContainText('保留推理细节。'.repeat(50));
  expect(reads).toHaveLength(2);
});

test('历史重置不把在途空增量解释为完整窗口，连续切换分支后仍能阅读', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  let tip = lastId;
  for (let i = 0; i < 65; i++) {
    const next = assistantTextEntry(tip, `Branch A visible answer ${i}`);
    entries.push(next.entry); tip = next.id;
  }
  const branchB = assistantTextEntry(lastId, 'Branch B answer');
  entries.push(branchB.entry);
  let leaf = tip;
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'history-race'), entries);
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id), getState: () => ({ state: 'idle', leafId: leaf }) });
  const observedLeaf = async () => (await (await request.get(`/api/status?id=${encodeURIComponent(id)}`)).json()).leafId;
  try {
    await expect.poll(observedLeaf).toBe(tip);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-message-id]').last()).toContainText('Branch A visible answer 64');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      let held = false;
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href);
        const response = await native(...args);
        if (url.pathname === '/api/session' && url.searchParams.has('after') && !held) {
          held = true;
          (window as any).__heldDelta = await response.clone().json();
          await new Promise<void>(resolve => { (window as any).__releaseDelta = resolve; });
        }
        if (url.pathname === '/api/session' && url.searchParams.has('before')) {
          (window as any).__historyWindow = await response.clone().json();
        }
        return response;
      };
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => Boolean((window as any).__releaseDelta));
    leaf = branchB.id; owner.publish();
    await expect.poll(observedLeaf).toBe(branchB.id);
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForFunction(() => Boolean((window as any).__historyWindow));
    await page.waitForTimeout(100);
    leaf = tip; owner.publish();
    await expect.poll(observedLeaf).toBe(tip);
    expect(await page.evaluate(() => (window as any).__heldDelta.window.messages)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__historyWindow.window.reset)).toBe(true);
    await page.evaluate(() => (window as any).__releaseDelta());
    await expect(page.locator('.remote-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('[data-message-id]')).toHaveCount(30);
    await expect(page.locator('[data-message-id]').last()).toContainText('Branch A visible answer 64');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // Scroll-into-view can itself load 30 rows before the click loads seven more.
    // Pin one explicit request here; real scrolling/prefetch is covered by history.spec.ts.
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('[data-message-id]')).toHaveCount(60);
    await expect(page.locator('.remote-main')).not.toContainText('Branch B answer');
  } catch (error) {
    const records = readDiagnostics(agentDir);
    const path = info.outputPath('diagnostics.json');
    writeFileSync(path, JSON.stringify(records, null, 2));
    await info.attach('diagnostics', { path, contentType: 'application/json' });
    throw error;
  } finally {
    await page.evaluate(() => (window as any).__releaseDelta?.()).catch(() => {});
    await owner.close();
  }
});

test('迟到的旧分支重置与后续读取失败不替换已经加载的六十条消息', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  let tip = lastId;
  for (let i = 0; i < 65; i++) {
    const next = assistantTextEntry(tip, `Readable A ${i}`);
    entries.push(next.entry); tip = next.id;
  }
  const abandoned = assistantTextEntry(lastId, 'Abandoned B must not replace the screen');
  entries.push(abandoned.entry);
  let leaf = tip;
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'stale-reset'), entries);
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id), getState: () => ({ state: 'idle', leafId: leaf }) });
  try {
    await expect.poll(async () => (await (await request.get(`/api/status?id=${encodeURIComponent(id)}`)).json()).leafId).toBe(tip);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-message-id]')).toHaveCount(30);
    // Keep setup to one read rather than scrolling into an automatic history load first.
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('[data-message-id]')).toHaveCount(60);
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href);
        if (url.pathname === '/api/session' && (window as any).__failSession) throw new TypeError('Injected content outage');
        const response = await native(...args);
        if (url.pathname === '/api/session' && url.searchParams.has('after') && !(window as any).__releaseReset) {
          const data = await response.clone().json();
          if (data.window.reset) await new Promise<void>(resolve => { (window as any).__releaseReset = resolve; });
        }
        return response;
      };
    });
    leaf = abandoned.id; owner.publish();
    await page.waitForFunction(() => Boolean((window as any).__releaseReset));
    await page.evaluate(() => { (window as any).__failSession = true; });
    leaf = tip; owner.publish();
    await expect.poll(async () => (await (await request.get(`/api/status?id=${encodeURIComponent(id)}`)).json()).leafId).toBe(tip);
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).__releaseReset());
    await expect(page.locator('.remote-main [role=alert]')).toContainText('Injected content outage');
    await expect(page.locator('[data-message-id]')).toHaveCount(60);
    await expect(page.locator('[data-message-id]').last()).toContainText('Readable A 64');
    await expect(page.locator('.remote-main')).not.toContainText('Abandoned B');
    await page.evaluate(() => { (window as any).__failSession = false; window.dispatchEvent(new Event('focus')); });
    await expect(page.locator('.remote-main [role=alert]')).toHaveCount(0);
    await expect(page.locator('[data-message-id]')).toHaveCount(60);
  } finally {
    await page.evaluate(() => (window as any).__releaseReset?.()).catch(() => {});
    await owner.close();
  }
});

test('工具正文按原生结果身份更新，迟到响应不回退，更新失败继续展示已读正文', async ({ page, context, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const tool = randomUUID(), call = randomUUID();
  entries.push({ type: 'message', id: tool, parentId: lastId, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: call, name: 'bash', arguments: { command: 'versioned-body' } }] } });
  const results = ['A', 'B', 'C', 'D'].map(label => ({ type: 'message', id: randomUUID(), parentId: tool, message: { role: 'toolResult', toolCallId: call, content: [{ type: 'text', text: `Loaded result ${label}` }] } }));
  entries.push(...results);
  let leaf = results[0].id;
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'versioned-block'), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, 'versioned-other'), buildSession({ cwd: workingDir }).entries);
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id), getState: () => ({ state: 'idle', leafId: leaf }) });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const toggle = page.locator('.remote-block-toggle').filter({ hasText: 'versioned-body' });
    await toggle.click();
    const body = page.locator('.remote-block-body');
    await expect(body).toContainText('Loaded result A');
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      (window as any).__blockMode = 'hold';
      window.fetch = async (...args) => {
        const block = new URL(String(args[0]), location.href).pathname === '/api/session/block';
        if (block && (window as any).__blockMode === 'fail') throw new TypeError('Injected block outage');
        const response = await native(...args);
        if (block && (window as any).__blockMode === 'hold') await new Promise<void>(resolve => { (window as any).__releaseBlock = resolve; });
        return response;
      };
    });
    leaf = results[1].id; owner.publish();
    await page.waitForFunction(() => Boolean((window as any).__releaseBlock));
    await expect(body).toContainText('Loaded result A');
    await expect(body).toContainText('正在更新');
    await page.evaluate(() => { (window as any).__blockMode = 'normal'; });
    leaf = results[2].id; owner.publish();
    await expect(body).toContainText('Loaded result C');
    await page.evaluate(() => (window as any).__releaseBlock());
    await page.waitForTimeout(200);
    await expect(body).not.toContainText('Loaded result B');
    await expect(body).toContainText('Loaded result C');
    await page.evaluate(() => { (window as any).__blockMode = 'fail'; });
    leaf = results[3].id; owner.publish();
    await expect(body.getByRole('alert')).toContainText('更新失败，以下保留已加载内容。');
    await expect(body).toContainText('Loaded result C');
    await page.evaluate(() => { (window as any).__blockMode = 'normal'; });
    await body.getByRole('button', { name: '重试', exact: true }).click();
    await expect(body).toContainText('Loaded result D');
    await expect(body.getByRole('alert')).toHaveCount(0);
    await page.evaluate(id => { history.pushState(null, '', `/session?id=${encodeURIComponent(id)}`); window.dispatchEvent(new PopStateEvent('popstate')); }, other);
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    await context.setOffline(true);
    await page.goBack();
    await toggle.click();
    await expect(body).toContainText('Loaded result D');
    await expect(body.getByRole('alert')).toHaveCount(0);
  } finally {
    await page.evaluate(() => (window as any).__releaseBlock?.()).catch(() => {});
    await owner.close();
  }
});

test('连续新增消息期间，较慢但有效的增量仍逐步可读，不等运行静默', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'progressive-window'), entries);
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id), getState: () => ({ state: 'running' }) });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const native = window.fetch.bind(window);
      (window as any).__releases = [];
      window.fetch = async (...args) => {
        const response = await native(...args);
        if (new URL(String(args[0]), location.href).pathname === '/api/session' && !(window as any).__stopHolding) {
          await new Promise<void>(resolve => { (window as any).__releases.push(resolve); });
        }
        return response;
      };
    });
    const first = assistantTextEntry(lastId, 'First incremental answer is readable while more arrive');
    appendEntry(sessionsDir, id, first.entry); owner.publish();
    await page.waitForFunction(() => (window as any).__releases.length === 1);
    const second = assistantTextEntry(first.id, 'Second incremental answer');
    appendEntry(sessionsDir, id, second.entry); owner.publish();
    await expect.poll(async () => (await (await request.get(`/api/status?id=${encodeURIComponent(id)}`)).json()).leafId).toBe(second.id);
    const statusRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/status');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await statusRead;
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).__releases[0]());
    await page.waitForFunction(() => (window as any).__releases.length >= 2);
    await expect(page.locator(`[data-message-id="${first.id}"]`)).toContainText('First incremental answer');
    await page.evaluate(() => { (window as any).__stopHolding = true; (window as any).__releases.forEach((release: () => void) => release()); });
    await expect(page.locator(`[data-message-id="${second.id}"]`)).toContainText('Second incremental answer');
    await expect(page.locator('[data-message-id]')).toHaveCount(4);
  } finally {
    await page.evaluate(() => { (window as any).__stopHolding = true; (window as any).__releases?.forEach((release: () => void) => release()); }).catch(() => {});
    await owner.close();
  }
});
