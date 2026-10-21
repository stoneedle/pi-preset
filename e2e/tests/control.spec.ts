import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import {
  buildSession,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
} from "../lib/sessions";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZsAAAAASUVORK5CYII=",
  "base64",
);

test("browse is passive; explicit continue reuses one worker for text, pictures, and skills", async ({
  page,
  sessionsDir,
  workingDir,
  agentDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "control"),
    entries,
  );
  const file = join(sessionsDir, "--home-user-demo-project--", id);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator("article")).toHaveCount(2);
  expect(existsSync(join(agentDir, "pi-web", "owners", id + ".json"))).toBe(false);
  await page
    .getByRole("button", { name: "在后台继续", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("hello mobile");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("article").last()).toContainText(
    "Stub reply: hello mobile",
  );
  expect(readFileSync(file, "utf8")).toContain("hello mobile");
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("/mem");
  await page.getByRole("button", { name: /skill:memory/ }).click();
  await expect(page.getByRole("textbox", { name: "给 Pi 发消息…" })).toHaveValue(
    "/skill:memory ",
  );
  expect(readFileSync(file, "utf8")).not.toContain("/skill:memory");
  await page
    .getByRole("textbox", { name: "给 Pi 发消息…" })
    .fill("phone picture");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("article").last()).toContainText(
    "Stub reply: phone picture",
  );
  const native = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    native.some(
      (entry) =>
        entry.message?.role === "user" &&
        entry.message.content.some((block: { type: string }) => block.type === "image"),
    ),
  ).toBe(true);
  expect(readdirSync(join(agentDir, "pi-web", "owners")).filter((name) => name === id + ".json")).toHaveLength(1);
  expect(existsSync(join(agentDir, "session-status"))).toBe(false);
  await page.locator(".remote-info summary").click();
  await expect(page.locator(".remote-info dl dt")).toHaveCount(7);
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "模型设置", exact: true });
  await settings.getByRole("group", { name: "思考强度", exact: true }).getByRole("button", { name: "高", exact: true }).click();
  await settings.getByRole("button", { name: "关闭模型设置", exact: true }).click();
  await expect(page.locator(".remote-info dd").last()).toHaveText("high");
});

test("quiet runs stay active without activity files and stopping is explicit", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  test.setTimeout(45000);
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "quiet"),
    entries,
  );
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page
    .getByRole("button", { name: "在后台继续", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "给 Pi 发消息…" })
    .fill("quiet task [[slow:30000]]");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("article").last()).toContainText("quiet task");
  const file = join(sessionsDir, "--home-user-demo-project--", id);
  const modified = statSync(file).mtimeMs;
  await expect(page.locator(".remote-header .remote-state")).toHaveAttribute(
    "data-state",
    "running",
  );
  await page.waitForTimeout(11500);
  expect(statSync(file).mtimeMs).toBe(modified);
  await expect(page.locator(".remote-header .remote-state")).toHaveAttribute(
    "data-state",
    "running",
  );
  await page
    .getByRole("button", { name: "停止主代理", exact: true })
    .click();
  await expect(page.locator(".remote-header .remote-state")).toHaveAttribute(
    "data-state",
    "idle",
  );
});

test("new sessions use an existing directory and unread clears on click", async ({
  page,
  workingDir,
  sessionsDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  (entries.at(-1)!.message as { stopReason: string }).stopReason = "length";
  const later = assistantTextEntry(lastId, "Later reply in another branch.");
  entries.push(later.entry);
  entries.push({
    type: "branch_summary",
    id: "feedbeef",
    parentId: lastId,
    fromId: later.id,
    summary: "Returned to the earlier branch.",
    timestamp: new Date().toISOString(),
  });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "unread"),
    entries,
  );
  await page.goto("/");
  await page.getByRole("searchbox").fill(id);
  const card = page.locator(`a[href="/session?id=${encodeURIComponent(id)}"]`);
  await expect(page.locator('.remote-session')).toHaveCount(1);
  await expect(card.locator(".remote-unread")).toBeVisible();
  await card.click();
  await expect(page.locator("article")).toHaveCount(2);
  await page.getByRole("button", { name: "会话列表", exact: true }).click();
  await page.getByRole("searchbox").fill(id);
  await expect(page.locator('.remote-session')).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(
    page.locator(
      `a[href="/session?id=${encodeURIComponent(id)}"] .remote-unread`,
    ),
  ).toHaveCount(0);
  await page.getByRole("dialog", { name: "会话", exact: true }).getByRole("button", { name: "新建会话", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新对话", exact: true });
  await editor.getByRole("button", { name: "选择项目", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择项目", exact: true });
  await picker.getByRole("textbox", { name: "文件夹路径", exact: true }).fill(workingDir);
  await picker.getByRole("button", { name: "前往", exact: true }).click();
  await picker.getByRole("button", { name: "使用此文件夹", exact: true }).click();
  await editor.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("new work");
  await expect(editor.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).not.toHaveURL(`/session?id=${encodeURIComponent(id)}`);
  await expect(page).toHaveURL(/\/session\?id=/);
  const created = new URL(page.url()).searchParams.get("id")!;
  const nativePath = readdirSync(sessionsDir)
    .map((directory) => join(sessionsDir, directory, created))
    .find(existsSync)!;
  await expect
    .poll(() => readFileSync(nativePath, "utf8"))
    .toContain("Stub reply: new work");
  await expect(page.locator("article").last()).toContainText(
    "Stub reply: new work",
  );
});

test('a crashed worker becomes unavailable and explicit continue replaces it', async ({ page, sessionsDir, workingDir, agentDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'crash'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: "在后台继续", exact: true }).click();
  const file = join(agentDir, 'pi-web', 'owners', id + '.json');
  await expect.poll(() => existsSync(file)).toBe(true);
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'idle');
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  process.kill(owner.pid, 'SIGKILL');
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'unknown');
  await page.getByRole('button', { name: "在后台继续", exact: true }).click();
  await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).pid).not.toBe(owner.pid);
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('recovered task');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  await expect(page.locator('article').last()).toContainText('Stub reply: recovered task');
});

test('an accepted send never erases text or a picture drafted while its receipt is pending', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'draft-race'), entries);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let held = false;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!held && new URL(String(args[0]), location.href).pathname === '/api/chat') {
        held = true; (window as any).__receiptHeld = true;
        await new Promise<void>((resolve) => { (window as any).__releaseReceipt = resolve; });
      }
      return response;
    };
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: "在后台继续", exact: true }).click();
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('first task [[slow:10000]]');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  try {
    await page.waitForFunction(() => (window as any).__receiptHeld);
    await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('second draft');
    await page.locator('input[type=file]').setInputFiles({ name: 'next-photo.png', mimeType: 'image/png', buffer: pixel });
    await page.evaluate(() => (window as any).__releaseReceipt());
    await expect(page.getByRole('button', { name: "发送", exact: true })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: "给 Pi 发消息…" })).toHaveValue('second draft');
    await expect(page.locator('.remote-images')).toContainText('next-photo.png');
    await page.getByRole('button', { name: "发送", exact: true }).click();
    await expect(page.locator('article').last()).toContainText('Stub reply: second draft');
    await page.getByRole('button', { name: "停止主代理", exact: true }).click();
  } finally { await page.evaluate(() => (window as any).__releaseReceipt?.()).catch(() => {}); }
});

test('runtime state and controls work before the initial ordinary reply body resolves', async ({ page, request, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, 'Large ordinary reply. '.repeat(8000)).entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'independent-controls'), entries);
  expect((await request.post(`/api/session/continue?id=${encodeURIComponent(id)}`)).ok()).toBe(true);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let held = false;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!held && new URL(String(args[0]), location.href).pathname === '/api/session') {
        held = true; (window as any).__bodyHeld = true;
        await new Promise<void>((resolve) => { (window as any).__releaseBody = resolve; });
      }
      return response;
    };
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  try {
    await page.waitForFunction(() => (window as any).__bodyHeld);
    await expect(page.locator('.remote-main')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('article')).toHaveCount(0);
    await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('immediate control [[slow:10000]]');
    await page.getByRole('button', { name: "发送", exact: true }).click();
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
    await expect.poll(() => readFileSync(join(sessionsDir, '--home-user-demo-project--', id), 'utf8')).toContain('immediate control');
    await page.getByRole('button', { name: "停止主代理", exact: true }).click();
    await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('article')).toHaveCount(0);
    await page.evaluate(() => (window as any).__releaseBody());
    await expect(page.locator('.remote-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.remote-main')).toContainText('Large ordinary reply.');
  } finally { await page.evaluate(() => (window as any).__releaseBody?.()).catch(() => {}); }
});
