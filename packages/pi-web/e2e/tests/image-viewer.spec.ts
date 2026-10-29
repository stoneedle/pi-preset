import type { Page } from '@playwright/test';
import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

async function picture(page: Page) {
  return Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 2412;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = '36px sans-serif';
    for (let row = 0; row < 50; row++) {
      context.fillStyle = row % 2 ? '#e0f2fe' : '#f0f9ff';
      context.fillRect(0, row * 48, canvas.width, 48);
      context.fillStyle = '#075985';
      context.fillText(`图片预览 · 第 ${row + 1} 行`, 24, row * 48 + 40);
      context.fillText(`第 ${row + 1} 行`, 750, row * 48 + 40);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
}

function session(sessionsDir: string, workingDir: string, name: string, image: Buffer) {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'viewer-picture', parentId: lastId, message: {
    role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }],
  } });
  return writeSession(sessionsDir, name, entries);
}

test('真实双指放大后可以单指横纵拖动图片，不缩放网页或打开会话抽屉', async ({ page, sessionsDir, workingDir }, info) => {
  test.skip(info.project.name !== 'Mobile Chrome', 'Real multi-touch uses Chromium mobile CDP');
  const image = await picture(page);
  const id = session(sessionsDir, workingDir, uniqueSessionName(info, 'image-touch'), image);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const input = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await input.fill('缩放、拖动和关闭图片都不丢草稿');
  await input.blur();
  await page.locator('.remote-attach input').setInputFiles({ name: 'touch.png', mimeType: 'image/png', buffer: image });
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const kind of ['message', 'draft']) {
      await page.setViewportSize({ width: 320, height: 640 });
      if (kind === 'message') await page.getByRole('link', { name: '打开图片', exact: true }).click();
      else await page.getByRole('button', { name: '查看图片：touch.png', exact: true }).click();
      const preview = page.getByRole('dialog').filter({ has: page.locator('img') });
      const fullImage = preview.locator('img');
      await expect(fullImage).toHaveJSProperty('naturalWidth', 1080);
      const initial = (await fullImage.boundingBox())!;
      const x = 160, y = 340;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
        { id: 1, x: x - 22, y: y - 32 }, { id: 2, x: x + 22, y: y + 32 },
      ] });
      for (const spread of [1.3, 1.8, 2.4, 3.2]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
          { id: 1, x: x - 22 * spread, y: y - 32 * spread },
          { id: 2, x: x + 22 * spread, y: y + 32 * spread },
        ] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => (await fullImage.boundingBox())!.width).toBeGreaterThan(initial.width * 2);
      expect(await page.evaluate(() => window.visualViewport!.scale)).toBeCloseTo(1, 2);
      const zoomed = (await fullImage.boundingBox())!;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
      for (const distance of [20, 40, 60, 80]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
          { id: 1, x: x - distance, y: y - distance * 1.5 },
        ] });
      }
      // Check while the finger is still down, not just after an inertial animation.
      await expect.poll(async () => (await fullImage.boundingBox())!.x).toBeLessThan(zoomed.x - 40);
      await expect.poll(async () => (await fullImage.boundingBox())!.y).toBeLessThan(zoomed.y - 40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 80, y: y - 120 }] });
      const reverse = (await fullImage.boundingBox())!;
      for (const distance of [20, 40, 60, 80]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
          { id: 1, x: x - 80 + distance, y: y - 120 + distance * 1.5 },
        ] });
      }
      await expect.poll(async () => (await fullImage.boundingBox())!.x).toBeGreaterThan(reverse.x + 40);
      await expect.poll(async () => (await fullImage.boundingBox())!.y).toBeGreaterThan(reverse.y + 40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      for (let drag = 0; drag < 4; drag++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y: 500 }] });
        for (const distance of [60, 140, 220, 320]) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x, y: 500 - distance }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await expect.poll(async () => {
        const box = (await fullImage.boundingBox())!;
        return box.y + box.height;
      }).toBeCloseTo(640, 0);
      await expect(preview).toBeVisible();
      await expect(page.locator('.remote-drawer')).not.toBeVisible();
      await expect(preview.getByRole('button', { name: '关闭图片预览', exact: true })).toBeVisible();
      expect(await preview.evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.top === 0 && box.left === 0 && box.right === innerWidth && box.bottom === innerHeight;
      })).toBe(true);
      await page.screenshot({ path: info.outputPath(`${kind}-pinch-and-pan-320.png`) });
      await preview.getByRole('button', { name: '适应屏幕', exact: true }).click();
      await expect.poll(async () => (await fullImage.boundingBox())!.width).toBeCloseTo(initial.width, 0);
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
      await expect.poll(async () => (await fullImage.boundingBox())!.width).toBeGreaterThan(initial.width * 2);
      await preview.getByRole('button', { name: '关闭图片预览', exact: true }).click();
      await expect(input).toHaveValue('缩放、拖动和关闭图片都不丢草稿');
    }
  } finally {
    await cdp.detach();
  }
});

test('缩放按钮放大后可用鼠标横纵拖动，还原后整图可见', async ({ page, sessionsDir, workingDir }, info) => {
  const image = await picture(page);
  const id = session(sessionsDir, workingDir, uniqueSessionName(info, 'image-mouse'), image);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.setViewportSize({ width: 390, height: 640 });
  await page.getByRole('link', { name: '打开图片', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览：图片', exact: true });
  const fullImage = preview.locator('img');
  await expect(fullImage).toHaveJSProperty('naturalHeight', 2412);
  const initial = (await fullImage.boundingBox())!;
  await preview.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect.poll(async () => (await fullImage.boundingBox())!.width).toBeGreaterThan(450);
  const zoomed = (await fullImage.boundingBox())!;
  await page.mouse.move(195, 330);
  await page.mouse.down();
  await page.mouse.move(115, 230, { steps: 8 });
  await expect.poll(async () => (await fullImage.boundingBox())!.x).toBeLessThan(zoomed.x - 40);
  await expect.poll(async () => (await fullImage.boundingBox())!.y).toBeLessThan(zoomed.y - 40);
  await page.mouse.up();
  await preview.getByRole('button', { name: '适应屏幕', exact: true }).click();
  await expect.poll(async () => (await fullImage.boundingBox())!.width).toBeCloseTo(initial.width, 0);
  const restored = (await fullImage.boundingBox())!;
  expect(restored.y).toBeGreaterThanOrEqual(0);
  expect(restored.y + restored.height).toBeLessThanOrEqual(640);
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
});

test('图片原件只在点击时读取一次，失败后显式重试', async ({ page, sessionsDir, workingDir }, info) => {
  const image = await picture(page);
  const id = session(sessionsDir, workingDir, uniqueSessionName(info, 'image-load'), image);
  let originals = 0;
  await page.route('**/api/session/image?**', async route => {
    if (new URL(route.request().url()).searchParams.get('thumbnail') === '1') return route.continue();
    originals++;
    if (originals === 1) await route.fulfill({ status: 503, body: 'temporary image error' });
    else await route.continue();
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('.remote-image-preview img')).toHaveJSProperty('naturalHeight', 240);
  expect(originals).toBe(0);
  await page.getByRole('link', { name: '打开图片', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览：图片', exact: true });
  await expect(preview.getByRole('alert')).toContainText('图片加载失败');
  expect(originals).toBe(1);
  await preview.getByRole('button', { name: '重试', exact: true }).click();
  await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 1080);
  await expect(preview.getByRole('button', { name: '放大图片', exact: true })).toBeEnabled();
  expect(originals).toBe(2);
});

test('新任务中的离线图片预览位于编辑器上层，关闭后保留图文草稿', async ({ page }, info) => {
  const image = await picture(page);
  await page.goto('/');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  const input = editor.getByRole('textbox', { name: '给 Pi 发消息…' });
  await input.fill('新任务的图文草稿');
  await editor.locator('input[type=file]').setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: image });
  await page.context().setOffline(true);
  await editor.getByRole('button', { name: '查看图片：offline.png', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览：offline.png', exact: true });
  await expect(preview.locator('img')).toHaveJSProperty('naturalHeight', 2412);
  await preview.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(preview.getByRole('button', { name: '适应屏幕', exact: true })).toBeVisible();
  expect(await preview.evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.width / 2, box.height / 2));
  })).toBe(true);
  if (info.project.name === 'Mobile Safari') await page.screenshot({ path: info.outputPath('new-task-offline-image.png') });
  await preview.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  await expect(input).toHaveValue('新任务的图文草稿');
  await expect(editor.getByRole('button', { name: '移除 offline.png', exact: true })).toBeVisible();
});
