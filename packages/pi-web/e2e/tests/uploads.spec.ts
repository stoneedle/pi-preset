import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDYsAAAAASUVORK5CYII=', 'base64');

test('new task preserves mixed attachments and keeps sending reachable with a small keyboard viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.goto('/');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  const add = editor.getByRole('button', { name: '添加附件', exact: true });
  for (const label of ['图片', '文件']) {
    await add.click();
    const selecting = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await (await selecting).setFiles(label === '图片'
      ? { name: 'pixel.png', mimeType: 'image/png', buffer: pixel }
      : { name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('retained') });
  }
  await editor.getByRole('textbox').fill('long draft\n'.repeat(20));
  const send = editor.getByRole('button', { name: '发送', exact: true });
  const box = await send.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(320);
  await expect(editor.getByRole('button', { name: '查看图片：pixel.png', exact: true })).toBeVisible();
  await expect(editor.getByLabel('待发送文件')).toContainText('draft.txt');
  await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  await expect(editor.getByLabel('待发送文件')).toContainText('draft.txt');
  await expect(editor.getByRole('textbox')).toHaveValue('long draft\n'.repeat(20));
});

test('attachment menu selects ordinary files, preserves drafts and sends readable temporary paths', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'uploads'), entries);
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const add = page.getByRole('button', { name: '添加附件', exact: true });
  await add.click();
  const menu = page.getByRole('menu', { name: '添加附件' });
  await expect(menu.getByRole('menuitem')).toHaveText(['图片', '文件', '画图']);
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath('attachment-menu-320.png') });
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(add).toBeFocused();
  await add.click();
  const selecting = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', { name: '文件', exact: true }).click();
  const chooser = await selecting;
  expect(chooser.isMultiple()).toBe(true);
  await expect(page.locator('input[type=file]')).not.toHaveAttribute('accept');
  const payload = Buffer.from([0, 255, 128, 13, 10, 42]);
  await chooser.setFiles([
    { name: '需要保留完整名称的很长文件名-报告?final.bin', mimeType: 'application/octet-stream', buffer: payload },
    { name: 'remove.txt', mimeType: 'text/plain', buffer: Buffer.from('remove me') },
    { name: 'invoice\\\\2026"final.pdf', mimeType: 'application/pdf', buffer: payload },
  ]);
  await page.getByRole('button', { name: '移除文件：remove.txt' }).click();
  await expect(page.getByLabel('待发送文件')).not.toContainText('remove.txt');
  const editor = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await editor.fill('下一份草稿');
  await page.screenshot({ path: info.outputPath('attachment-draft-320.png') });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Definite rejection retains the original file for editing rather than replaying.
  await page.route('**/api/chat?*', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '暂时不能发送' }) }));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新编辑', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新编辑', exact: true }).click();
  await expect(page.getByLabel('待发送文件')).toContainText('报告?final.bin');
  await page.unroute('**/api/chat?*');
  await editor.fill('');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  const response = page.waitForResponse(r => r.url().includes('/api/chat?') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect((await response).status()).toBe(202);
  await expect(page.getByLabel('待发送文件')).toHaveCount(0);
  // Read the native message, not a mocked upload result.
  await expect.poll(() => readFileSync(`${sessionsDir}/--home-user-demo-project--/${id}`, 'utf8')).toContain('pi-web-upload-');
  const messages = readFileSync(`${sessionsDir}/--home-user-demo-project--/${id}`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const uploaded = messages.filter(entry => entry.message?.role === 'user').at(-1);
  const text = uploaded.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  expect(text).toContain(JSON.stringify('invoice\\\\2026"final.pdf'));
  const path = JSON.parse(text.trim().split('\n').at(-1));
  try {
    expect(readFileSync(path)).toEqual(payload);
  } finally {
    rmSync(dirname(dirname(path)), { recursive: true, force: true });
  }
});
