import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer } from 'node:http';
import { test, expect } from "../lib/test";
import {
  assistantTextEntry,
  buildSession,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

// Keep retry gates on the page's requests, not a newly activated Service Worker.
test.use({ serviceWorkers: 'block' });

const prototype = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"></head><body>
<h1>Interactive prototype</h1><button id="increment">Clicked 0</button><form><label>Prototype name<input name="name"></label><button>Apply</button></form><output></output>
<p id="loaded"></p><script type="module" src="./app.mjs"></script></body></html>`;

function writePrototype(directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), prototype);
  writeFileSync(join(directory, "style.css"), "body{margin:16px;background:rgb(242,244,247);font:16px system-ui}input{display:block;max-width:100%;box-sizing:border-box}button{min-height:44px}");
  writeFileSync(join(directory, "data.json"), JSON.stringify({ message: "Relative module and JSON loaded" }));
  writeFileSync(join(directory, "app.mjs"), `let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#increment').textContent='Clicked '+(++count);
    document.querySelector('form').onsubmit=(event)=>{event.preventDefault();document.querySelector('output').textContent=new FormData(event.target).get('name')};
    document.querySelector('#loaded').textContent=(await(await fetch('./data.json')).json()).message;`);
}

test('read and edit file cards stay compact and single-line at narrow widths', async ({ page, sessionsDir, workingDir }, info) => {
  const names = ['layout.spec.ts', 'mobile.spec.ts', '一个需要保留完整名称且不能挤走预览和下载按钮的很长文件名.md'];
  const source = '# Compact file card\n\nKeep the original bytes.';
  for (const name of names) writeFileSync(join(workingDir, name), source);
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'compact-files', parentId: lastId, message: { role: 'assistant', content: names.map((path, index) => ({ type: 'toolCall', id: `compact-file-${index}`, name: index === 1 ? 'edit' : 'read', arguments: { path } })) } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'compact-files'), entries);
  const reads: string[] = [];
  page.on('request', (request) => { if (/\/api\/session\/(?:file|block|preview)/.test(request.url())) reads.push(request.url()); });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const cards = page.locator('.remote-block .remote-file');
  await expect(cards).toHaveCount(names.length);
  const original = page.viewportSize()!;
  for (const width of [...new Set([original.width, 360, 320])]) {
    await page.setViewportSize({ width, height: original.height });
    const boxes = await cards.evaluateAll((elements) => elements.map((element) => {
      const card = element.getBoundingClientRect();
      const name = element.querySelector('.remote-file-name')!.getBoundingClientRect();
      const actions = element.querySelector('.remote-file-actions')!.getBoundingClientRect();
      return { height: card.height, left: card.left, right: card.right, nameHeight: name.height, actionsLeft: actions.left, nameRight: name.right };
    }));
    expect(boxes.every((box) => box.height <= 36 && box.nameHeight <= 21 && box.left >= 0 && box.right <= width && box.actionsLeft >= box.nameRight), JSON.stringify({ width, boxes })).toBe(true);
  }
  expect(reads).toEqual([]);
  const longCard = page.getByRole('group', { name: names[2], exact: true });
  await expect(longCard.locator('.remote-file-name')).toHaveAttribute('title', names[2]);
  const downloading = page.waitForEvent('download');
  await page.getByRole('group', { name: names[1], exact: true }).getByRole('link', { name: '下载', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(names[1]);
  const chunks = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(source);
  if (info.project.name === 'Mobile Chrome') {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: info.outputPath('compact-file-cards-320.png') });
  }
  await longCard.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.frameLocator('.remote-preview iframe').getByRole('heading', { name: 'Compact file card' })).toBeVisible();
});

test("attachments stay lazy, download intact and render Markdown with relative assets", async ({ page, sessionsDir, workingDir }, info) => {
  const directory = join(workingDir, "documents");
  mkdirSync(directory);
  const documentName = "报告 with spaces.md";
  const source = "# Full document\n\n**Rendered Markdown**\n\n![Local image](./icon.svg)\n\n[Next document](./next.md)\n\n| Key | Value |\n| --- | --- |\n| complete | yes |\n\n" + "download-exact-byte-check-".repeat(3000);
  writeFileSync(join(directory, documentName), source);
  writeFileSync(join(directory, "next.md"), "# Next rendered document\n\n**Still Markdown**");
  writeFileSync(join(directory, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
  writeFileSync(join(directory, "result.bin"), Buffer.from([0, 255, 3, 128, 0, 17]));
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: "message", id: "file-tool", parentId: lastId, message: { role: "assistant", content: [{ type: "toolCall", id: "write-file", name: "write", arguments: { path: `documents/${documentName}`, content: "folded-attachment-input-".repeat(100000) } }] } });
  entries.push(assistantTextEntry("file-tool", `[Document](./documents/${encodeURIComponent(documentName)}) and [Binary](./documents/result.bin)`).entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, "attachments"), entries);
  const lazyRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/session\/(?:file|block|preview)|\/preview\//.test(request.url())) lazyRequests.push(request.url());
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const files = page.getByRole("group", { name: documentName, exact: true });
  await expect(files).toHaveCount(2);
  await expect(page.locator(".remote-main")).not.toContainText("folded-attachment-input-");
  expect(lazyRequests).toEqual([]);
  const downloadPromise = page.waitForEvent("download");
  await files.last().getByRole("link", { name: "下载", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(documentName);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(source);
  const binaryPromise = page.waitForEvent("download");
  await page.getByRole("group", { name: "result.bin", exact: true }).getByRole("link", { name: "下载" }).click();
  const binary = await binaryPromise;
  const binaryChunks = [];
  for await (const chunk of (await binary.createReadStream())!) binaryChunks.push(chunk);
  expect(Buffer.concat(binaryChunks)).toEqual(Buffer.from([0, 255, 3, 128, 0, 17]));
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("Keep my unsent draft");
  await files.first().getByRole("button", { name: "预览", exact: true }).click();
  const frame = page.frameLocator(".remote-preview iframe");
  await expect(frame.getByRole("heading", { name: "Full document" })).toBeVisible();
  await expect(frame.locator("strong")).toHaveText("Rendered Markdown");
  await expect(frame.locator("img")).toHaveJSProperty("naturalWidth", 20);
  await expect(frame.locator("table")).toContainText("complete");
  expect(lazyRequests.filter((url) => url.includes("/api/session/block"))).toEqual([]);
  await frame.getByRole("link", { name: "Next document" }).click();
  await expect(frame.getByRole("heading", { name: "Next rendered document" })).toBeVisible();
  await expect(frame.locator("strong")).toHaveText("Still Markdown");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".remote-preview")).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "给 Pi 发消息…" })).toHaveValue("Keep my unsent draft");
});

test("HTML prototypes run relative modules but cannot acquire remote-control authority or escape their folder", async ({ page, request, sessionsDir, workingDir }, info) => {
  const directory = join(workingDir, "prototype");
  writePrototype(directory);
  writeFileSync(join(directory, ".private.json"), '{"secret":"hidden-must-not-leak"}');
  writeFileSync(join(directory, "private.sqlite"), "not-a-web-resource");
  const outside = join(workingDir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.json"), '{"secret":"outside-must-not-leak"}');
  symlinkSync(outside, join(directory, "escape"), process.platform === "win32" ? "junction" : "dir");
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, "[Prototype](./prototype/index.html) and [Missing](./prototype/missing.html)").entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, "prototype"), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole("group", { name: "index.html", exact: true }).getByRole("button", { name: "预览" }).click();
  const dialog = page.getByRole("dialog", { name: "预览", exact: true });
  const frame = page.frameLocator(".remote-preview iframe");
  await expect(frame.locator("#loaded")).toHaveText("Relative module and JSON loaded");
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(242, 244, 247)");
  await frame.getByRole("button", { name: "Clicked 0" }).click();
  await expect(frame.getByRole("button", { name: "Clicked 1" })).toBeVisible();
  await frame.getByRole("textbox", { name: "Prototype name" }).fill("Mobile form works");
  await frame.getByRole("button", { name: "Apply" }).click();
  await expect(frame.locator("output")).toHaveText("Mobile form works");
  const isolated = page.frames().find((item) => item.parentFrame());
  expect(await isolated!.evaluate(async (id) => {
    let parentBlocked = false, cookiesBlocked = false, controlBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    try { void document.cookie; } catch { cookiesBlocked = true; }
    try { await fetch(`/api/chat/cancel?id=${id}`, { method: "POST", credentials: "include" }); } catch { controlBlocked = true; }
    return { origin: self.origin, parentBlocked, cookiesBlocked, controlBlocked };
  }, id)).toEqual({ origin: "null", parentBlocked: true, cookiesBlocked: true, controlBlocked: true });
  const originalURL = await page.locator(".remote-preview iframe").getAttribute("src");
  const base = originalURL!.slice(0, originalURL!.lastIndexOf("/") + 1);
  for (const [path, status] of [["data.json", 200], [".private.json", 403], ["private.sqlite", 403], ["escape/secret.json", 404]] as const) {
    expect((await request.get(base + path)).status(), path).toBe(status);
  }
  expect((await request.post(originalURL!, { data: {} })).status()).toBe(405);
  expect((await request.get("/preview/guessed-capability/index.html")).status()).toBe(404);
  const previewResponse = await request.get(originalURL!);
  expect(previewResponse.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(previewResponse.headers()["content-security-policy"]).not.toContain("allow-same-origin");
  expect(previewResponse.headers()["referrer-policy"]).toBe("no-referrer");
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(frame.getByRole("button", { name: "Clicked 0" })).toBeVisible();
  const reloadedURL = await page.locator(".remote-preview iframe").getAttribute("src");
  expect(reloadedURL).not.toBe(originalURL);
  await expect.poll(async () => (await request.get(originalURL!)).status()).toBe(404);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  if (info.project.name === "Mobile Chrome" || info.project.name === "iPad") {
    await page.screenshot({ path: info.outputPath("interactive-preview.png") });
  }
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect.poll(async () => (await request.get(reloadedURL!)).status()).toBe(404);
  await page.getByRole("group", { name: "missing.html", exact: true }).getByRole("button", { name: "预览" }).click();
  await expect(dialog.getByRole("alert")).toContainText("file is unavailable");
  writeFileSync(join(directory, "missing.html"), "<h1>Created after the failed preview</h1>");
  await dialog.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(frame.getByRole("heading", { name: "Created after the failed preview" })).toBeVisible();
});

test("draft and message thumbnails stay compact without fetching originals", async ({ page, sessionsDir, workingDir, request }, info) => {
  const pictures = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 2412;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = '32px sans-serif';
    for (let row = 0; row < 55; row++) {
      context.fillStyle = row % 2 ? '#075985' : '#334155';
      context.fillText(`Image attachment: line ${row} — full original stays readable.`, 24, row * 43 + 40);
    }
    return ['image/png', 'image/jpeg', 'image/webp'].map((type) => {
      const url = canvas.toDataURL(type);
      return { mimeType: url.slice(5, url.indexOf(';')), data: url.split(',')[1] };
    });
  });
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'tall-pictures', parentId: lastId, message: {
    role: 'user', content: [{ type: 'text', text: 'Keep the complete tall pictures.' },
      ...pictures.map((picture) => ({ type: 'image', ...picture }))],
  } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'thumbnails'), entries);
  const imageRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/session/image') imageRequests.push(request.url());
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const previews = page.locator('.remote-image-preview img');
  await expect(previews).toHaveCount(pictures.length);
  for (const preview of await previews.all()) {
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toHaveJSProperty('naturalHeight', 240);
  }
  expect(imageRequests.length).toBeGreaterThan(0);
  expect(imageRequests.every((url) => new URL(url).searchParams.get('thumbnail') === '1')).toBe(true);
  const originalURL = await page.getByRole('link', { name: '打开图片', exact: true }).first().getAttribute('href');
  const thumbnail = await request.get(originalURL + '&thumbnail=1');
  expect(thumbnail.headers()['content-type']).toBe('image/jpeg');
  expect((await thumbnail.body()).length).toBeLessThan(Buffer.from(pictures[0].data, 'base64').length / 4);
  const original = await request.get(originalURL!);
  expect(await original.body()).toEqual(Buffer.from(pictures[0].data, 'base64'));
  await expect(page.locator('.remote-image').getByRole('link', { name: '下载', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '打开图片', exact: true }).first().click();
  const opened = page.getByRole('dialog', { name: '图片预览：图片', exact: true });
  await expect(opened.locator('img')).toHaveJSProperty('naturalWidth', 1080);
  await expect(opened.locator('img')).not.toHaveAttribute('src', /[?&]thumbnail=/);
  await expect(opened.getByRole('link', { name: '下载原图', exact: true })).toBeVisible();
  expect(await opened.evaluate((dialog) => {
    const box = dialog.getBoundingClientRect();
    return box.left === 0 && box.top === 0 && box.width === innerWidth && box.height === window.visualViewport!.height;
  })).toBe(true);
  await opened.getByRole('button', { name: '关闭图片预览', exact: true }).click();

  const input = page.getByRole('textbox', { name: '给 Pi 发消息…' });
  await input.fill('Keep this draft while previewing and removing its image.');
  await page.locator('.remote-attach input').setInputFiles({
    name: 'long-mobile-screenshot.png', mimeType: 'image/png', buffer: Buffer.from(pictures[0].data, 'base64'),
  });
  const draftImage = page.locator('.draft-image-thumbnail');
  await expect(draftImage).toHaveJSProperty('naturalHeight', 2412);
  expect((await page.locator('.remote-images').innerText()).trim()).toBe('');
  await expect(page.locator('.remote-images').getByRole('link', { name: '下载', exact: true })).toHaveCount(0);
  if (info.project.name === 'Mobile Chrome') {
    await page.screenshot({ path: info.outputPath('image-thumbnails-mobile.png') });
  }
  await page.setViewportSize({ width: 320, height: page.viewportSize()!.height });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  expect(await draftImage.evaluate((image) => {
    const box = image.getBoundingClientRect();
    return box.width === 56 && box.height === 56;
  })).toBe(true);
  expect(await page.locator('.remote-actions').evaluate((actions) => {
    const box = actions.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= 360;
  })).toBe(true);
  expect(await previews.evaluateAll((images) => images.every((image) => {
    const box = image.getBoundingClientRect();
    return box.width === 96 && box.height === 96;
  }))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === 'Mobile Chrome') {
    await page.screenshot({ path: info.outputPath('image-thumbnails-320-keyboard.png') });
  }
  await page.context().setOffline(true);
  await page.getByRole('button', { name: '查看图片：long-mobile-screenshot.png', exact: true }).click();
  const draftPreview = page.getByRole('dialog', { name: '图片预览：long-mobile-screenshot.png', exact: true });
  await expect(draftPreview).toBeVisible();
  await expect(draftPreview.locator('img')).toHaveJSProperty('naturalHeight', 2412);
  await expect(draftPreview.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(draftPreview.locator('header')).toContainText('long-mobile-screenshot.png');
  const draftDownloadPromise = page.waitForEvent('download');
  await draftPreview.getByRole('link', { name: '下载原图', exact: true }).click();
  const draftDownload = await draftDownloadPromise;
  expect(draftDownload.suggestedFilename()).toBe('long-mobile-screenshot.png');
  const draftChunks = [];
  for await (const chunk of (await draftDownload.createReadStream())!) draftChunks.push(chunk);
  expect(Buffer.concat(draftChunks)).toEqual(Buffer.from(pictures[0].data, 'base64'));
  if (info.project.name === 'Mobile Chrome') {
    await page.screenshot({ path: info.outputPath('draft-image-offline-preview-320.png') });
  }
  expect(await draftPreview.evaluate((dialog) => {
    const box = dialog.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= 360;
  })).toBe(true);
  const fitted = (await draftPreview.locator('img').boundingBox())!;
  expect(fitted.y).toBeGreaterThanOrEqual(0);
  expect(fitted.y + fitted.height).toBeLessThanOrEqual(360);
  await draftPreview.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect.poll(async () => (await draftPreview.locator('img').boundingBox())!.width).toBeGreaterThan(fitted.width * 2);
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  await expect(draftPreview).not.toBeVisible();
  await page.getByRole('button', { name: '移除 long-mobile-screenshot.png', exact: true }).click();
  await expect(draftImage).toHaveCount(0);
  await expect(input).toHaveValue('Keep this draft while previewing and removing its image.');
});

test("failed thumbnails keep the original link and can be retried", async ({ page, sessionsDir, workingDir }, info) => {
  const picture = await page.screenshot();
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'retry-picture', parentId: lastId, message: {
    role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: picture.toString('base64') }],
  } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'thumbnail-retry'), entries);
  let attempts = 0;
  await page.route('**/api/session/image?**', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('thumbnail')).toBe('1');
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, body: 'temporary error' });
    else await route.continue();
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByRole('status').filter({ hasText: '缩略图不可用' })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开图片', exact: true })).not.toHaveAttribute('href', /[?&]thumbnail=/);
  await expect(page.locator('.remote-image').getByRole('link', { name: '下载', exact: true })).toHaveCount(0);
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => page.locator('.remote-image-preview img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(attempts).toBe(2);
});

test("tool image metadata stays body-free and unfolded file links become actionable", async ({ page, sessionsDir, workingDir }, info) => {
  const picture = await page.screenshot();
  writeFileSync(join(workingDir, "generated.md"), "# Tool-generated document\n\n**Complete Markdown**");
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: "message", id: "tool-images", parentId: lastId, message: { role: "assistant", content: [{ type: "toolCall", id: "generated-assets", name: "bash", arguments: { command: "generate assets" } }] } });
  entries.push({ type: "message", id: "generated-result", parentId: "tool-images", message: { role: "toolResult", toolCallId: "generated-assets", content: [{ type: "text", text: "Written [Generated document](./generated.md)" }, { type: "image", data: picture.toString("base64"), mimeType: "image/png" }] } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "tool-assets"), entries);
  const bodyRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/session\/(?:file|block|image|preview)|\/preview\//.test(request.url())) bodyRequests.push(request.url());
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByRole("link", { name: "打开图片", exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".remote-image-preview img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(bodyRequests.filter((url) => new URL(url).searchParams.get("thumbnail") !== "1")).toEqual([]);
  await expect(page.locator(".remote-image")).not.toContainText("下载");
  await page.getByRole("link", { name: "打开图片", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "图片预览：图片", exact: true });
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", picture.readUInt32BE(16));
  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("link", { name: "下载原图", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("image.png");
  const chunks = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(picture);
  await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  expect(bodyRequests.some((url) => url.includes("/api/session/block"))).toBe(false);
  await page.getByRole("button", { name: /bash generate assets/ }).click();
  const generated = page.getByRole("group", { name: "generated.md", exact: true });
  await expect(generated).toBeVisible();
  await generated.getByRole("button", { name: "预览" }).click();
  await expect(page.frameLocator(".remote-preview iframe").getByRole("heading", { name: "Tool-generated document" })).toBeVisible();
});

test('named image references stay thumbnail-only and coordinate notes stay out of the UI', async ({ page, sessionsDir, workingDir }, info) => {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 2412;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e0f2fe';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const picture = Buffer.from(data, 'base64');
  const name = '一份需要点开才能查看完整文件名的很长图片 screenshot.png';
  writeFileSync(join(workingDir, name), picture);
  const note = '[Image: original 1080x2412, displayed at 896x2000. Multiply coordinates by 1.21 to map to original image.]';
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'annotated-picture', parentId: lastId, message: {
    role: 'user', content: [
      { type: 'text', text: '查看这张图\n\n' + note },
      { type: 'image', mimeType: 'image/png', data },
      { type: 'text', text: note },
    ],
  } });
  entries.push({ type: 'message', id: 'named-read', parentId: 'annotated-picture', message: {
    role: 'assistant', content: [{ type: 'toolCall', id: 'read-image', name: 'read', arguments: { path: name } }],
  } });
  entries.push({ type: 'message', id: 'read-picture', parentId: 'named-read', message: {
    role: 'toolResult', toolCallId: 'read-image', content: [{ type: 'image', mimeType: 'image/png', data }],
  } });
  entries.push(assistantTextEntry('read-picture', '[图片文件](./' + encodeURIComponent(name) + ')\n\n![图片说明](./' + encodeURIComponent(name) + ')').entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'named-images'), entries);
  const nativePath = join(sessionsDir, '--home-user-demo-project--', id);
  const originalRecord = readFileSync(nativePath);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/session\/(?:file|image|block|preview)/.test(request.url())) reads.push(request.url());
  });
  await page.goto('/session?id=' + encodeURIComponent(id));
  await page.setViewportSize({ width: 320, height: page.viewportSize()!.height });
  const annotated = page.locator('[data-message-id="annotated-picture"]');
  await expect(annotated.locator('.remote-markdown')).toHaveCount(1);
  await expect(annotated.locator('.remote-markdown')).toHaveText('查看这张图');
  await expect(annotated).not.toContainText('Multiply coordinates');
  await expect(page.locator('.remote-file')).toHaveCount(0);
  const thumbnails = page.locator('.remote-image-preview img');
  await expect(thumbnails).toHaveCount(4);
  await expect(page.locator('[data-message-id="named-read"] .remote-image')).toHaveCount(1);
  for (const thumbnail of await thumbnails.all()) {
    await thumbnail.scrollIntoViewIfNeeded();
    await expect(thumbnail).toHaveJSProperty('naturalHeight', 240);
  }
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((url) => new URL(url).searchParams.get('thumbnail') === '1')).toBe(true);
  expect((await page.locator('.remote-image').allTextContents()).map((text) => text.trim())).toEqual(['', '', '', '']);
  await expect(page.locator('.remote-main').getByRole('link', { name: '下载', exact: true })).toHaveCount(0);
  for (const index of [1, 2, 3]) {
    await page.getByRole('link', { name: '打开图片', exact: true }).nth(index).click();
    const preview = page.getByRole('dialog', { name: `图片预览：${name}`, exact: true });
    await expect(preview.locator('header')).toContainText(name);
    await expect(preview.locator('img')).toHaveJSProperty('naturalHeight', 2412);
    const downloading = page.waitForEvent('download');
    await preview.getByRole('link', { name: '下载原图', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(index === 1 ? 'image.png' : name);
    const chunks = [];
    for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(picture);
    if (index === 2 && info.project.name === 'Mobile Chrome') {
      await page.screenshot({ path: info.outputPath('named-image-fullscreen-320.png') });
    }
    await preview.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  }
  expect(readFileSync(nativePath)).toEqual(originalRecord);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(thumbnails).toHaveCount(4);
  if (info.project.name === 'Mobile Chrome') {
    await page.screenshot({ path: info.outputPath('clean-images-320.png') });
  }
});

test('web tool attachments retain each source instead of reading same-named project files', async ({ page, sessionsDir, workingDir }, info) => {
  const repository = join(workingDir, 'cloned-repository');
  mkdirSync(join(repository, 'docs'), { recursive: true });
  const picture = await page.screenshot();
  writeFileSync(join(repository, 'docs', 'gallery.png'), picture);
  writeFileSync(join(repository, 'docs', 'guide.md'), '# Correct repository guide');
  writeFileSync(join(repository, 'LICENSE'), 'correct repository license');
  writeFileSync(join(workingDir, 'LICENSE'), 'wrong project license');
  const content = `Repository cloned to: ${repository}\n\n[![Build](https://github.com/example/clone/actions/workflows/ci.yml/badge.svg)](https://github.com/example/clone/actions/workflows/ci.yml) [![Version](https://img.shields.io/npm/v/example.svg)](https://www.npmjs.com/package/example)\n\n[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n\n![Gallery](docs/gallery.png)\n\n[Guide](docs/guide.md)`;
  const raw = 'https://raw.githubusercontent.com/example/source/main/docs/README.md';
  const remote = 'https://raw.githubusercontent.com/example/source/main/网络文档.md';
  const text = 'Script completed\nOutput:\n\n==> text 1/2 <==\n' + JSON.stringify({ i: 0, status: 'fulfilled', value: { urls: [{ url: 'https://github.com/example/clone', content }] } }) + '\n==> text 2/2 <==\n' + JSON.stringify({ i: 1, status: 'fulfilled', value: { urls: [{ url: raw, content: '[Remote document](../网络文档.md)' }] } }) + '\n[Unknown relative source](not-a-project-file.md)';
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'web-assets', parentId: lastId, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'fetch-assets', name: 'codemode', arguments: { code: 'fetch web sources' } }] } });
  entries.push({ type: 'message', id: 'web-assets-result', parentId: 'web-assets', message: { role: 'toolResult', toolCallId: 'fetch-assets', content: [{ type: 'text', text }], details: { calls: [{ name: 'fetch_content' }] } } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'web-sources'), entries);
  const reads: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session/file') reads.push(request.url()); });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator('.remote-file')).toHaveCount(0);
  await page.getByRole('button', { name: /codemode fetch web sources/ }).click();
  const gallery = page.locator('.remote-image-preview img');
  await page.locator('.remote-image-preview').scrollIntoViewIfNeeded();
  const [width, height] = [picture.readUInt32BE(16), picture.readUInt32BE(20)];
  const thumbnailSize = width > height ? [240, Math.floor(240 / (width / height))] : [Math.floor(240 * (width / height)), 240];
  await expect(gallery).toHaveJSProperty('naturalWidth', thumbnailSize[0]);
  await expect(gallery).toHaveJSProperty('naturalHeight', thumbnailSize[1]);
  expect(reads.every((url) => new URL(url).searchParams.get('thumbnail') === '1')).toBe(true);
  expect(reads.every((url) => new URL(url).searchParams.get('path')!.startsWith(repository))).toBe(true);
  await expect(page.getByRole('group', { name: 'not-a-project-file.md', exact: true })).toHaveCount(0);
  const license = page.getByRole('group', { name: 'LICENSE', exact: true });
  const downloading = page.waitForEvent('download');
  await license.getByRole('link', { name: '下载', exact: true }).click();
  const chunks = [];
  for await (const chunk of (await (await downloading).createReadStream())!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('correct repository license');
  await page.getByRole('group', { name: 'guide.md', exact: true }).getByRole('button', { name: '预览' }).click();
  await expect(page.frameLocator('.remote-preview iframe').getByRole('heading', { name: 'Correct repository guide' })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const document = page.getByRole('group', { name: '网络文档.md', exact: true });
  await expect(document.locator('.remote-file-name')).toHaveAttribute('title', encodeURI(remote));
  await expect(document.getByRole('link', { name: '原文', exact: true })).toHaveAttribute('href', encodeURI(remote));
  await page.route('**/api/session/file?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('path') === encodeURI(remote) && url.searchParams.get('preview') === '1') {
      await route.fulfill({ contentType: 'text/html', body: '<h1>Remote document preview</h1>' });
    } else await route.continue();
  });
  await document.getByRole('button', { name: '预览' }).click();
  await expect(page.frameLocator('.remote-preview iframe').getByRole('heading', { name: 'Remote document preview' })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 420 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(document.getByRole('button', { name: '预览' })).toBeVisible();
});

test('read document links follow the read file directory, including a root filename', async ({ page, sessionsDir, workingDir }, info) => {
  mkdirSync(join(workingDir, 'docs'));
  writeFileSync(join(workingDir, 'README.md'), '# Project root document');
  writeFileSync(join(workingDir, 'docs', 'guide.md'), '# Nested guide document');
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'read-link-source', parentId: lastId, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-link', name: 'read', arguments: { path: 'docs/guide.md' } }] } });
  entries.push({ type: 'message', id: 'read-link-result', parentId: 'read-link-source', message: { role: 'toolResult', toolCallId: 'read-link', content: [{ type: 'text', text: '[Parent](../README.md)' }] } });
  entries.push({ type: 'message', id: 'read-root-source', parentId: 'read-link-result', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-root', name: 'read', arguments: { path: 'README.md' } }] } });
  entries.push({ type: 'message', id: 'read-root-result', parentId: 'read-root-source', message: { role: 'toolResult', toolCallId: 'read-root', content: [{ type: 'text', text: '[Guide](docs/guide.md)' }] } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'read-link-source'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  for (const [source, heading] of [['docs/guide.md', 'Project root document'], ['README.md', 'Nested guide document']]) {
    await page.getByRole('button', { name: `read ${source}` }).click();
    const block = page.locator('.remote-block').filter({ has: page.getByRole('button', { name: `read ${source}` }) });
    await block.locator('.remote-block-body').getByRole('button', { name: '预览' }).click();
    await expect(page.frameLocator('.remote-preview iframe').getByRole('heading', { name: heading })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  }
});

test('remote attachment reads cannot reach private services or accept URL credentials', async ({ request, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'remote-file-isolation'), entries);
  let hits = 0;
  const trap = createServer((_request, response) => { hits++; response.end('private contents must never be read'); });
  await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
  try {
    const address = trap.address();
    if (!address || typeof address === 'string') throw new Error('Missing private trap port');
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]']) {
      const url = `/api/session/file?${new URLSearchParams({ id, path: `http://${host}:${address.port}/private` })}`;
      const response = await request.get(url);
      expect(response.status()).toBe(502);
      expect(await response.text()).not.toContain('private contents');
    }
    expect(hits).toBe(0);
    const credentialURL = `/api/session/file?${new URLSearchParams({ id, path: 'https://name:password@example.com/file' })}`;
    expect((await request.get(credentialURL)).status()).toBe(400);
  } finally {
    await new Promise<void>((resolve, reject) => trap.close((error) => error ? reject(error) : resolve()));
  }
});
