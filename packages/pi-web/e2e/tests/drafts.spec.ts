import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });
const image = {
  name: 'next-draft.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'),
};

test('an edited draft is not cleared when it returns to the same text before a late receipt', async ({ page, sessionsDir, agentDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'revision'), buildSession({ cwd: workingDir }).entries);
  let release = () => {};
  let calls = 0;
  const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    control: async (input: any) => {
      if (input.action === 'send') { calls++; await new Promise<void>((resolve) => { release = resolve; }); }
      return { status: 'accepted' };
    } });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await input.fill('重复的同一段 prompt');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await input.fill('编辑过程中的其他文字');
    await input.fill('重复的同一段 prompt');
    release();
    await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
    await expect(input).toHaveValue('重复的同一段 prompt');
    expect(calls).toBe(1);
  } finally { release(); await owner.close(); }
});

for (const leave of [false, true]) {
  test(`new-task receipt transfers the next text and image without ${leave ? 'stealing later navigation' : 'hiding them in the closed editor'}`, async ({ page, sessionsDir, workingDir }, info) => {
    const old = writeSession(sessionsDir, uniqueSessionName(info, 'new-task-old'), buildSession({ cwd: workingDir }).entries);
    const created = writeSession(sessionsDir, uniqueSessionName(info, 'new-task-created'), buildSession({ cwd: workingDir }).entries);
    await page.route('**/api/project-options?*', route => route.fulfill({ json: { models: [] } }));
    await page.route('**/api/new-session', route => route.fulfill({ json: { id: created } }));
    await page.goto('/');
    await page.getByRole('searchbox').fill(old);
    await page.locator(`a.remote-session[href="/session?id=${encodeURIComponent(old)}"]`).click();
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(old)}`);
    await page.evaluate((path) => {
      localStorage.setItem('pi-web:last-project', path);
      const nativeFetch = window.fetch.bind(window);
      (window as any).__draftCalls = 0;
      window.fetch = (...args) => {
        if (new URL(String(args[0]), location.href).pathname === '/api/chat') {
          (window as any).__draftCalls++;
          return new Promise<Response>((resolve) => {
            (window as any).__releaseDraftSend = () => resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
          });
        }
        return nativeFetch(...args);
      };
    }, workingDir);
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新对话', exact: true });
    const input = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await input.fill('首条提交内容');
    await editor.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => Boolean((window as any).__releaseDraftSend));
    await input.fill('新任务发送期间继续输入的下一条');
    await editor.locator('input[type=file]').setInputFiles(image);
    if (leave) {
      await page.goBack();
      await expect(page).toHaveURL('/');
    }
    await page.evaluate(() => (window as any).__releaseDraftSend());
    if (leave) {
      await expect.poll(() => page.getByRole('button', { name: '开始新任务', exact: true }).isVisible()).toBe(true);
      await expect(page).toHaveURL('/');
      await page.getByRole('searchbox').fill(created);
      await page.locator(`a.remote-session[href="/session?id=${encodeURIComponent(created)}"]`).click();
    }
    await expect(page).toHaveURL(`/session?id=${encodeURIComponent(created)}`);
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('新任务发送期间继续输入的下一条');
    await expect(page.getByRole('button', { name: '移除 next-draft.png', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__draftCalls)).toBe(1);
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('');
    await expect(editor.getByRole('button', { name: '移除 next-draft.png', exact: true })).toHaveCount(0);
  });
}

test('新任务失败后的恢复入口跟随草稿交接，重新编辑不覆盖下一条', async ({ page, sessionsDir, workingDir }, info) => {
  const created = writeSession(sessionsDir, uniqueSessionName(info, 'new-task-recovery'), buildSession({ cwd: workingDir }).entries);
  let release = () => {};
  let calls = 0;
  await page.route('**/api/project-options?*', route => route.fulfill({ json: { models: [] } }));
  await page.route('**/api/new-session', route => route.fulfill({ json: { id: created } }));
  await page.route('**/api/chat?*', async route => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: { error: 'New task acknowledgement lost' } });
  });
  await page.goto('/');
  await page.evaluate(path => localStorage.setItem('pi-web:last-project', path), workingDir);
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  const input = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await input.fill('新任务首条原文');
  await editor.locator('input[type=file]').setInputFiles({ ...image, name: 'first.png' });
  await editor.getByRole('button', { name: '发送', exact: true }).click();
  try {
    await expect.poll(() => calls).toBe(1);
    await input.fill('新任务中的下一条草稿');
    await editor.getByRole('button', { name: '移除 first.png', exact: true }).click();
    await editor.locator('input[type=file]').setInputFiles(image);
    release();
    await expect(editor.locator('[data-recovery-message]')).toContainText('未确认是否发送成功');
    await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
    await page.getByRole('button', { name: '开始新任务', exact: true }).click();
    await expect(input).toHaveValue('新任务中的下一条草稿');
    await editor.getByRole('button', { name: '打开会话继续', exact: true }).click();
    await expect(page).toHaveURL('/session?id=' + encodeURIComponent(created));
    const mainInput = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    const recovery = page.locator('[data-recovery-message]');
    await expect(mainInput).toHaveValue('新任务中的下一条草稿');
    await recovery.getByRole('button', { name: '重新编辑', exact: true }).click();
    await expect(mainInput).toHaveValue('新任务首条原文');
    await expect(page.getByRole('button', { name: '移除 first.png', exact: true })).toBeVisible();
    await recovery.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(mainInput).toHaveValue('新任务中的下一条草稿');
    await expect(page.getByRole('button', { name: '移除 next-draft.png', exact: true })).toBeVisible();
    expect(calls).toBe(1);
  } finally { release(); }
});
