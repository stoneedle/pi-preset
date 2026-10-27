import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { appendEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

test('发送过程中只显示按钮进度，成功和跨导航均不插入额外消息', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  (entries[1].message as any).content[0].text = '请调整正在执行的命令';
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'outgoing'), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, 'outgoing-other'), buildSession({ cwd: workingDir }).entries);
  const submissions: any[] = [];
  let release: () => void = () => {};
  const owner = await openFixtureOwner({
    agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', mainRunning: true }),
    control: async (input: any) => {
      if (input.action === 'send') {
        submissions.push(input.chat);
        if (submissions.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      }
      return { status: 'accepted' };
    },
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
    await draft.fill('请调整正在执行的命令');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const pending = page.locator('[data-recovery-message]');
    await expect(pending).toHaveCount(0);
    await expect(page.locator('.remote-main article')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => submissions.length).toBe(1);
    await draft.fill('发送期间的新草稿');
    // A same-text native message does not replace the receipt for this request.
    const firstId = randomUUID();
    appendEntry(sessionsDir, id, { type: 'message', id: firstId, parentId: lastId, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '请调整正在执行的命令' }] } });
    owner.publish();
    await expect(page.locator(`[data-message-id="${firstId}"]`)).toBeVisible();
    await expect(pending).toHaveCount(0);
    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
    await drawer.getByRole('searchbox').fill(other);
    await drawer.locator(`a[href="/session?id=${encodeURIComponent(other)}"]`).click();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(other)}`);
    release();
    await page.goBack();
    await expect(pending).toHaveCount(0);
    await expect(draft).toHaveValue('发送期间的新草稿');

    await draft.fill('请调整正在执行的命令');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(draft).toHaveValue('');
    await expect(pending).toHaveCount(0);
    const secondId = randomUUID();
    appendEntry(sessionsDir, id, { type: 'message', id: secondId, parentId: firstId, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '请调整正在执行的命令' }] } });
    owner.publish();
    await expect(page.locator(`[data-message-id="${secondId}"]`)).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(page.locator('[data-message-id]')).toHaveCount(4);
    expect(submissions).toHaveLength(2);
    await expect(page.getByRole('button', { name: '停止主代理', exact: true })).toBeVisible();
  } finally {
    release();
    await owner.close();
  }
});

test('长按保留输入焦点且仅排队，失败提供恢复入口且不重放', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'follow-up'), entries);
  const other = writeSession(sessionsDir, uniqueSessionName(info, 'follow-up-other'), buildSession({ cwd: workingDir }).entries);
  const submissions: any[] = [];
  let release: () => void = () => {};
  let canQueue = false;
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', mainRunning: true, canQueue }),
    control: async (input: any) => {
      if (input.action === 'send') {
        submissions.push(input.chat);
        if (submissions.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      }
      return { status: 'accepted' };
    },
  });
  try {
    const dormant = await request.post('/api/chat?id=' + encodeURIComponent(other), { multipart: { message: '排队不能启动休眠会话', delivery: 'followUp' } });
    expect(dormant.status()).toBe(409);
    expect(existsSync(join(agentDir, 'pi-web', 'owners', other + '.json'))).toBe(false);
    const unsupported = await request.post('/api/chat?id=' + encodeURIComponent(id), { multipart: { message: '不降级成引导', delivery: 'followUp' } });
    expect(unsupported.status()).toBe(409);
    expect(await unsupported.text()).toContain('/reload');
    const withSettings = await request.post('/api/chat?id=' + encodeURIComponent(id), { multipart: { message: '排队不修改设置', delivery: 'followUp', settings: JSON.stringify({ thinking: 'high' }) } });
    expect(withSettings.status()).toBe(409);
    expect(submissions).toHaveLength(0);
    canQueue = true;
    owner.publish();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    const menu = page.getByRole('menu', { name: '发送选项', exact: true });
    const recovery = page.locator('[data-recovery-message]');
    const holdSend = async () => {
      await send.scrollIntoViewIfNeeded();
      const box = (await send.boundingBox())!;
      if (info.project.name === 'Mobile Chrome') {
        const cdp = await page.context().newCDPSession(page);
        try {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
          await expect(menu).toBeVisible();
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally { await cdp.detach(); }
      } else {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await expect(menu).toBeVisible();
        await page.mouse.up();
      }
      await expect(menu).toBeVisible();
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(box.y);
    };
    const first = '完成当前任务后再做这一项。'.repeat(20);
    await draft.fill(first);
    await page.locator('.remote-attach input').setInputFiles({
      name: 'queued.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'),
    });
    await expect(draft).toBeFocused();
    await holdSend();
    await expect(draft).toBeFocused();
    expect(submissions).toHaveLength(0);
    await menu.getByRole('menuitem', { name: '排队', exact: true }).click();
    await expect(menu).not.toBeVisible();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0].delivery).toBe('followUp');
    expect(submissions[0].images).toHaveLength(1);
    await expect(recovery).toHaveCount(0);
    await expect(send).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.remote-main article')).toHaveCount(2);
    await draft.fill('发送期间继续写的下一份草稿');
    await page.screenshot({ path: info.outputPath('queue-320-sending.png'), animations: 'disabled' });

    await page.getByRole('button', { name: '会话列表', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '会话', exact: true });
    await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
    await drawer.getByRole('searchbox').fill(other);
    await drawer.locator(`a[href="/session?id=${encodeURIComponent(other)}"]`).click();
    await page.goBack();
    await expect(send).toHaveAttribute('aria-busy', 'true');
    await expect(recovery).toHaveCount(0);
    release();
    await expect(send).toHaveAttribute('aria-busy', 'false');
    await expect(draft).toHaveValue('发送期间继续写的下一份草稿');
    await expect(page.locator('.remote-images button')).toHaveCount(0);
    await holdSend();
    await menu.getByRole('menuitem', { name: '排队', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(2);
    await expect(draft).toHaveValue('');
    expect(submissions.every((item) => item.delivery === 'followUp')).toBe(true);
    await expect(recovery).toHaveCount(0);
    let parentId = lastId;
    for (const submitted of submissions) {
      const entryId = randomUUID();
      appendEntry(sessionsDir, id, { type: 'message', id: entryId, parentId, timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: submitted.message }, ...(submitted.images || [])] } });
      parentId = entryId;
      owner.publish();
      await expect(page.locator(`[data-message-id="${entryId}"]`)).toBeVisible();
      await expect(recovery).toHaveCount(0);
    }
    expect(submissions).toHaveLength(2);
    await page.evaluate(() => {
      const nativeFetch = window.fetch.bind(window);
      (window as any).queueFailedCalls = 0;
      window.fetch = async (...args) => {
        if (new URL(String(args[0]), location.href).pathname === '/api/chat') {
          (window as any).queueFailedCalls++;
          throw new TypeError('Simulated queue connection reset');
        }
        return nativeFetch(...args);
      };
    });
    await draft.fill('这次排队结果未确认');
    await holdSend();
    await menu.getByRole('menuitem', { name: '排队', exact: true }).click();
    await expect(recovery).toContainText('未确认是否排队成功');
    await recovery.getByRole('button', { name: '未确认是否排队成功', exact: true }).click();
    await expect(recovery).toContainText('这次排队结果未确认');
    await expect(draft).toHaveValue('这次排队结果未确认');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    owner.publish();
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    expect(await page.evaluate(() => (window as any).queueFailedCalls)).toBe(1);
  } finally {
    release();
    await owner.close();
  }
});

test('图文投递成功不留副本，图片尺寸说明和重复刷新不复制原生回复和工具', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'outgoing-image'), entries);
  let submitted: any;
  const owner = await openFixtureOwner({
    agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'running', mainRunning: true }),
    control: (input: any) => {
      if (input.action === 'send') submitted = input.chat;
      return { status: 'accepted' };
    },
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    const prompt = '当前通知是启用不了的';
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
    await draft.fill(prompt);
    await page.locator('.remote-attach input').setInputFiles({
      name: 'notification.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'),
    });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(draft).toHaveValue('');
    await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
    const userId = randomUUID();
    appendEntry(sessionsDir, id, {
      type: 'message', id: userId, parentId: lastId, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [
        { type: 'text', text: prompt + '\n\n[Image: original 1080x2412, displayed at 896x2000. Multiply coordinates by 1.21 to map to original image.]' },
        ...submitted.images,
      ] },
    });
    const replyId = randomUUID();
    appendEntry(sessionsDir, id, {
      type: 'message', id: replyId, parentId: userId, timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [
        { type: 'text', text: '先检查权限判断和订阅加载流程。' },
        { type: 'toolCall', id: randomUUID(), name: 'codemode', arguments: { code: 'text(await tools.read({path:"web/src/main.js"}));' } },
      ] },
    });
    owner.publish();
    await expect(page.locator(`[data-message-id="${userId}"]`)).toBeVisible();
    await expect(page.locator(`[data-message-id="${userId}"]`)).not.toContainText('[Image: original');
    await expect(page.locator(`[data-message-id="${userId}"] .remote-markdown`)).toHaveText(prompt);
    await expect(page.locator(`[data-message-id="${replyId}"]`)).toBeVisible();
    await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
    for (let index = 0; index < 3; index++) {
      const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session');
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      owner.publish();
      await refreshed;
    }
    await expect(page.locator('[data-message-id]')).toHaveCount(4);
    await expect(page.locator('[data-message-id]').getByText(prompt, { exact: false })).toHaveCount(1);
    await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
    await expect(page.locator('.remote-block-name')).toHaveCount(1);
    await expect(draft).toHaveValue('');
    await page.screenshot({ path: info.outputPath('image-no-local-copy.png'), animations: 'disabled' });
  } finally {
    await owner.close();
  }
});

test('an unconfirmed submission keeps its content and is never resent automatically', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'outgoing-error'), buildSession({ cwd: workingDir }).entries);
  let sends = 0;
  let confirmed = false;
  await page.route('**/api/chat?*', async (route) => {
    sends++;
    if (confirmed) await route.fulfill({ status: 202, json: { status: 'accepted' } });
    else await route.abort('connectionreset');
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('[data-message-id]')).toHaveCount(2);
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await draft.fill('不能静默消失或自动重放');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const recovery = page.locator('[data-recovery-message]');
  await expect(recovery).toContainText('未确认是否发送成功');
  await expect(page.locator('.remote-main article')).toHaveCount(2);
  await recovery.getByRole('button', { name: '未确认是否发送成功', exact: true }).click();
  await expect(recovery).toContainText('不能静默消失或自动重放');
  await expect(draft).toHaveValue('不能静默消失或自动重放');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  expect(sends).toBe(1);
  confirmed = true;
  await draft.fill('成功的下一条');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(draft).toHaveValue('');
  await expect(recovery).toHaveCount(1);
  await expect(recovery).toContainText('不能静默消失或自动重放');
  await expect(recovery).not.toContainText('成功的下一条');
  await recovery.getByRole('button', { name: '重新编辑', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await expect(draft).toHaveValue('不能静默消失或自动重放');
  expect(sends).toBe(2);
});

for (const status of [409, 503]) {
  test(`失败恢复切换编辑而不覆盖下一份图文草稿，HTTP ${status}`, async ({ page, sessionsDir, workingDir }, info) => {
    const id = writeSession(sessionsDir, uniqueSessionName(info, 'reedit-' + status), buildSession({ cwd: workingDir }).entries);
    let release = () => {};
    let calls = 0;
    await page.route('**/api/chat?*', async route => {
      calls++;
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status, json: { error: 'Deterministic send failure' } });
    });
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    const original = '这份原文和图片都不能丢失。'.repeat(40);
    const next = status === 409 ? original : '发送过程中继续写的下一份草稿。'.repeat(30);
    const picture = { mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64') };
    await input.fill(original);
    await page.locator('.remote-composer input[type=file]').setInputFiles({ ...picture, name: 'original.png' });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    try {
      await expect.poll(() => calls).toBe(1);
      await input.fill('中间编辑版本');
      await input.fill(next);
      await page.getByRole('button', { name: '移除 original.png', exact: true }).click();
      await page.locator('.remote-composer input[type=file]').setInputFiles({ ...picture, name: 'next.png' });
      release();
      const recovery = page.locator('[data-recovery-message]');
      await expect(recovery).toHaveCount(1);
      await expect(recovery).toHaveAttribute('data-state', status === 409 ? 'failed' : 'uncertain');
      await expect(recovery.locator('.recovery-text')).toHaveCount(0);
      await expect(page.locator('.remote-main article')).toHaveCount(2);
      await expect(input).toHaveValue(next);
      await page.setViewportSize({ width: 320, height: 380 });
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
      await expect(recovery.getByRole('button', { name: '重新编辑', exact: true })).toBeInViewport();
      await expect.poll(() => page.locator('.composer-recoveries').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(40);
      expect((await recovery.boundingBox())!.height).toBeLessThanOrEqual(40);
      await page.screenshot({ path: info.outputPath('failed-320.png') });
      await recovery.getByRole('button', { name: '重新编辑', exact: true }).click();
      await expect(input).toHaveValue(original);
      await expect(input).toBeFocused();
      await expect(page.getByRole('button', { name: '移除 original.png', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '移除 next.png', exact: true })).toHaveCount(0);
      await expect(recovery).toHaveAttribute('data-state', 'draft');
      await expect(recovery).toContainText('另一份草稿已暂存');
      await expect(recovery.getByRole('button', { name: '继续编辑', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
      expect((await page.locator('.composer-region').boundingBox())!.height).toBeLessThanOrEqual(191);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('reedit-320.png') });
      await recovery.getByRole('button', { name: '继续编辑', exact: true }).click();
      await expect(input).toHaveValue(next);
      await expect(page.getByRole('button', { name: '移除 next.png', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '移除 original.png', exact: true })).toHaveCount(0);
      page.once('dialog', dialog => dialog.dismiss());
      await recovery.getByRole('button', { name: '丢弃这份草稿', exact: true }).click();
      await expect(recovery).toHaveCount(1);
      page.once('dialog', dialog => dialog.accept());
      await recovery.getByRole('button', { name: '丢弃这份草稿', exact: true }).click();
      await expect(recovery).toHaveCount(0);
      await expect(input).toHaveValue(next);
      await expect(page.getByRole('button', { name: '移除 next.png', exact: true })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      expect(calls).toBe(1);
    } finally { release(); }
  });
}
