import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import {
  assistantTextEntry,
  buildSession,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

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
  await expect(page.getByRole("button", { name: "打开图片", exact: true })).toBeVisible();
  expect(bodyRequests).toEqual([]);
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".remote-image-actions").getByRole("link", { name: "下载" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("image.png");
  const chunks = [];
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(picture);
  expect(bodyRequests.some((url) => url.includes("/api/session/block"))).toBe(false);
  await page.getByRole("button", { name: /bash generate assets/ }).click();
  const generated = page.getByRole("group", { name: "generated.md", exact: true });
  await expect(generated).toBeVisible();
  await generated.getByRole("button", { name: "预览" }).click();
  await expect(page.frameLocator(".remote-preview iframe").getByRole("heading", { name: "Tool-generated document" })).toBeVisible();
});
