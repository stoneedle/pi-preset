import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test('drawing assets are not precached with chat and the used editor can reopen offline', async ({ page, context, sessionsDir, workingDir }, info) => {
  test.skip(info.project.name !== 'Mobile Chrome', 'Service Worker integration uses mobile Chromium');
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'sketch-offline'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  async function cachedURLs() {
    return page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat());
  }
  expect((await cachedURLs()).filter(url => /sketch-editor-|\.woff2/.test(url))).toEqual([]);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('menuitem', { name: '画图', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '画图', exact: true });
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  const canvas = editor.locator('canvas.interactive');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 220, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await cachedURLs()).some(url => url.includes('sketch-editor-'))).toBe(true);
  await editor.getByRole('button', { name: '关闭画图并保留草图', exact: true }).click();
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await page.getByRole('menuitem', { name: '画图', exact: true }).click();
    await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.locator('.draft-image')).toHaveCount(1);
    expect((await cachedURLs()).some(url => url.includes('/api/'))).toBe(false);
  } finally {
    await context.setOffline(false);
  }
});

test.describe('editor interaction', () => {
test.use({ serviceWorkers: 'block' });

test('default pen makes a fine structure line rather than a broad pressure brush', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'fine-sketch'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('menuitem', { name: '画图', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '画图', exact: true });
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  const canvas = editor.locator('canvas.interactive');
  const box = (await canvas.boundingBox())!;
  if (info.project.name === 'Mobile Chrome') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.2, y: box.y + 180, force: 0.1 }] });
    for (let step = 1; step <= 24; step++)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * (0.2 + 0.6 * step / 24), y: box.y + 180, force: step % 2 ? 0.9 : 0.1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(box.x + box.width * 0.2, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + 180, { steps: 24 });
    await page.mouse.up();
  }
  const lineWidth = (fraction = 0.5) => editor.locator('canvas').first().evaluate((canvas: HTMLCanvasElement, fraction) => {
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const data = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width * fraction), 0, 1, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 200 && data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) ink++;
    return ink / ratio;
  }, fraction);
  await expect.poll(() => lineWidth()).toBeGreaterThan(0);
  for (const fraction of [0.32, 0.5, 0.68]) {
    const width = await lineWidth(fraction);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(2);
  }
  // Pressure normalization must not create an extra undo step for one stroke.
  await editor.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => lineWidth()).toBe(0);
  await editor.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(() => lineWidth()).toBeGreaterThan(0);
  expect(await lineWidth()).toBeLessThanOrEqual(2);
});

test('sketch opens lazily, keeps editable work and adds a PNG without sending', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'sketch'), buildSession({ cwd: workingDir }).entries);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('用草图解释');
  expect(requests.some(url => url.includes('sketch-editor-'))).toBe(false);
  async function open() {
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await page.getByRole('menuitem', { name: '画图', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '画图', exact: true });
    await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
    await expect(editor.locator('canvas.interactive')).toBeVisible();
    return editor;
  }
  const editor = await open();
  await page.screenshot({ path: info.outputPath('sketch-initial.png') });
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('先画点什么');
  const canvas = editor.locator('canvas.interactive');
  const box = (await canvas.boundingBox())!;
  if (info.project.name === 'Mobile Chrome') {
    const cdp = await page.context().newCDPSession(page);
    const start = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let step = 1; step <= 12; step++)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + box.width * 0.35 * step / 12, y: start.y + box.height * 0.2 * step / 12 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 12 });
    await page.mouse.up();
  }
  await expect(editor.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await editor.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await editor.getByRole('button', { name: '重做', exact: true }).click();
  await editor.getByRole('button', { name: '关闭画图并保留草图', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await open();
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.draft-image')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('用草图解释');
  expect(requests.filter(url => url.includes('/api/chat?'))).toEqual([]);
  // B is retained in the editor, but the attachment is still the completed A.
  await open();
  const nextBox = (await canvas.boundingBox())!;
  await page.mouse.move(nextBox.x + nextBox.width * 0.3, nextBox.y + nextBox.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(nextBox.x + nextBox.width * 0.65, nextBox.y + nextBox.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await editor.getByRole('button', { name: '关闭画图并保留草图', exact: true }).click();
  const sending = page.waitForResponse(response => response.url().includes('/api/chat?') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect((await sending).status()).toBe(202);
  await expect(page.locator('.draft-image')).toHaveCount(0);
  await open();
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.draft-image')).toHaveCount(1);
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (new URL(String(args[0]), location.href).pathname === '/api/chat') {
        await new Promise<void>(resolve => {
          (window as any).__releaseSketchReceipt = () => { window.fetch = original; resolve(); };
        });
      }
      return response;
    };
  });
  const sendingB = page.waitForResponse(response => response.url().includes('/api/chat?') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).__releaseSketchReceipt));
  // Merely viewing the submitted sketch must not turn it into new work.
  await open();
  await editor.getByRole('button', { name: '关闭画图并保留草图', exact: true }).click();
  await page.evaluate(() => (window as any).__releaseSketchReceipt());
  const replyB = await sendingB;
  expect(replyB.status(), await replyB.text()).toBe(202);
  await expect(page.locator('.draft-image')).toHaveCount(0);
  await open();
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('先画点什么');
  expect(errors).toEqual([]);
  expect(requests.filter(url => !url.startsWith(new URL(page.url()).origin) && !url.startsWith('blob:') && !url.startsWith('data:'))).toEqual([]);
});

test('compact controls draw a labelled multi-level structure at 320px without property panels', async ({ page, sessionsDir, workingDir }, info) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.emulateMedia({ colorScheme: 'light' });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'structure-sketch'), buildSession({ cwd: workingDir }).entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('menuitem', { name: '画图', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '画图', exact: true });
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  await expect(editor.getByRole('radio')).toHaveCount(0);
  const toolbar = editor.getByRole('group', { name: '绘图工具', exact: true });
  await expect(toolbar.getByRole('button')).toHaveCount(6);
  for (const button of await toolbar.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  const canvas = editor.locator('canvas.interactive');
  const box = (await canvas.boundingBox())!;
  async function drag(x: number, y: number, endX: number, endY: number) {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    // Pace gesture samples with rendered frames instead of sending an
    // entire human drag inside a single WebKit frame.
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(box.x + x + (endX - x) * step / 6, box.y + y + (endY - y) * step / 6);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await page.mouse.up();
  }
  await editor.getByRole('button', { name: '方框', exact: true }).click();
  for (const [x, y] of [[106, 35], [20, 150], [190, 150], [20, 270], [190, 270]])
    await drag(x, y, x + 108, y + 36);
  await expect(editor.getByRole('button', { name: '方框', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => editor.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const context = canvas.getContext('2d')!;
    return [[160, 35], [74, 150], [244, 150], [74, 270], [244, 270]].every(([x, y]) => {
      const data = context.getImageData(Math.round((x - 2) * ratio), Math.round((y - 2) * ratio), Math.ceil(4 * ratio), Math.ceil(4 * ratio)).data;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 200) return true;
      return false;
    });
  })).toBe(true);
  await editor.getByRole('button', { name: '箭头', exact: true }).click();
  for (const [x, y, endX, endY] of [[160, 75, 75, 145], [160, 75, 245, 145], [75, 190, 75, 265], [245, 190, 245, 265]])
    await drag(x, y, endX, endY);
  await editor.getByRole('button', { name: '文字', exact: true }).click();
  for (const [x, y, label] of [[144, 44, '输入'], [58, 159, '解析'], [228, 159, '校验'], [58, 279, '保存'], [228, 279, '返回']] as const) {
    await canvas.click({ position: { x, y } });
    const text = editor.locator('textarea');
    await expect(text).toBeVisible();
    await expect(text).toHaveValue('');
    await text.fill(label);
  }
  await editor.getByRole('button', { name: '画笔', exact: true }).click();
  await page.screenshot({ path: info.outputPath('sketch-compact-structure-320.png') });
  const settings = editor.getByRole('button', { name: '画图设置', exact: true });
  await settings.click();
  const menu = page.getByRole('menu', { name: '画图设置', exact: true });
  await menu.getByRole('menuitemradio', { name: '红色', exact: true }).click();
  await menu.getByRole('menuitemradio', { name: '中等', exact: true }).click();
  await page.screenshot({ path: info.outputPath('sketch-compact-style-320.png') });
  await settings.click();
  await expect(menu).not.toBeVisible();
  await drag(40, 370, 280, 370);
  const redPixels = () => editor.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 200) red++;
    return red;
  });
  await expect.poll(redPixels).toBeGreaterThan(50);
  await editor.getByRole('button', { name: '橡皮', exact: true }).click();
  await drag(160, 350, 160, 390);
  await expect.poll(redPixels).toBe(0);
  await editor.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(redPixels).toBeGreaterThan(50);
  await editor.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(redPixels).toBe(0);
  await settings.click();
  await menu.getByRole('menuitem', { name: '选择／移动', exact: true }).click();
  await expect(settings).toContainText('移动');
  await canvas.click({ position: { x: 160, y: 35 } });
  await settings.click();
  await expect(menu.getByRole('menuitemradio', { name: '黑色', exact: true })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: '中等', exact: true }).click();
  await expect.poll(redPixels).toBe(0);
  await expect(menu.getByRole('menuitemradio', { name: '黑色', exact: true })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitem', { name: '清空画布', exact: true }).click();
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('先画点什么');
  await editor.getByRole('button', { name: '撤销', exact: true }).click();
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.draft-image')).toHaveCount(1);
});

test('new-task image annotation exports actual image and Chinese text, with reachable controls at 320px', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: undefined }); });
  await page.goto('/');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const task = page.getByRole('dialog', { name: '新对话', exact: true });
  await task.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('menuitem', { name: '画图', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '画图', exact: true });
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  await expect(editor.getByRole('radio', { name: '插入图像', exact: true })).toHaveCount(0);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2048; canvas.height = 1536;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#0c4ea0'; context.fillRect(0, 0, 2048, 1536);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const selecting = page.waitForEvent('filechooser');
  await editor.getByRole('button', { name: '添加图片到画布', exact: true }).click();
  await (await selecting).setFiles({ name: 'background.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  await expect.poll(() => editor.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 12 && data[i + 1] === 78 && data[i + 2] === 160) blue++;
    return blue;
  })).toBeGreaterThan(1000);
  const textTool = editor.getByRole('button', { name: '文字', exact: true });
  await textTool.click();
  await expect(textTool).toHaveAttribute('aria-pressed', 'true');
  const canvas = editor.locator('canvas.interactive');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.75 } });
  const text = editor.locator('textarea');
  await expect(text).toBeVisible();
  await text.fill('这里需要修改');
  if (info.project.name === 'Mobile Chrome') {
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
  } else await page.setViewportSize({ width: 320, height: 360 });
  await expect.poll(async () => (await editor.locator('.sketch-tools').boundingBox())!.y).toBeLessThan(360);
  const toolbarTop = (await editor.locator('.sketch-tools').boundingBox())!.y;
  await expect.poll(async () => { const rect = (await text.boundingBox())!; return rect.y + rect.height; }).toBeLessThanOrEqual(toolbarTop - 8);
  const done = editor.getByRole('button', { name: '完成', exact: true });
  const doneBox = (await done.boundingBox())!;
  expect(doneBox.y + doneBox.height).toBeLessThanOrEqual(360);
  await page.screenshot({ path: info.outputPath('sketch-annotation-keyboard-320.png') });
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      (window as any).__releaseSketchExport = () => {
        HTMLCanvasElement.prototype.toBlob = original;
        original.call(this, callback, type, quality);
      };
    };
  });
  await done.click();
  await page.waitForFunction(() => Boolean((window as any).__releaseSketchExport));
  await expect(done).toBeDisabled();
  await expect(editor.locator('.sketch-host')).toHaveAttribute('inert', '');
  await page.evaluate(() => (window as any).__releaseSketchExport());
  await expect(editor).toHaveCount(0);
  await expect(task.locator('.draft-image')).toHaveCount(1);
  const pixels = await task.locator('.draft-image img').evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0, dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 12 && data[i + 1] === 78 && data[i + 2] === 160) blue++;
      if (data[i] < 50 && data[i + 1] < 50 && data[i + 2] < 50 && data[i + 3] > 0) dark++;
    }
    return { blue, dark, width: canvas.width, height: canvas.height };
  });
  expect(pixels.blue).toBeGreaterThan(1000);
  expect(pixels.dark).toBeGreaterThan(30);
  expect(Math.max(pixels.width, pixels.height)).toBe(1600);
  // Reopening edits the same sketch and replaces its PNG, rather than duplicating it.
  await task.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('menuitem', { name: '画图', exact: true }).click();
  await expect(editor.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(task.locator('.draft-image')).toHaveCount(1);
  await expect(task).toBeVisible();
});
});
