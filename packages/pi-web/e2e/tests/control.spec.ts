import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import { openFixtureOwner } from "../lib/runtime-owner.mjs";
import {
  buildSession,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
} from "../lib/sessions";

// Keep network gates deterministic; service worker behavior has its own suite.
test.use({ serviceWorkers: 'block' });

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZsAAAAASUVORK5CYII=",
  "base64",
);

test("browse is passive; sending starts and reuses one worker for text, pictures, and skills", async ({
  page,
  sessionsDir,
  workingDir,
  agentDir,
  request,
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
  await expect(page.getByRole('button', { name: '在后台继续', exact: true })).toHaveCount(0);
  await expect(page.getByText('控制桥接未连接', { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".remote-compose-context [role=status]")).toHaveCount(0);
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("hello mobile");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("[data-message-id]").last()).toContainText(
    "Stub reply: hello mobile",
  );
  await expect(page.locator(".remote-compose-context [role=status]")).toHaveCount(0);
  expect(readFileSync(file, "utf8")).toContain("hello mobile");
  const ownerFile = join(agentDir, 'pi-web', 'owners', id + '.json');
  const firstPID = JSON.parse(readFileSync(ownerFile, 'utf8')).pid;
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("/exa");
  await page.getByRole("button", { name: /skill:example/ }).click();
  await expect(page.getByRole("textbox", { name: "给 Pi 发消息…" })).toHaveValue(
    "/skill:example ",
  );
  expect(readFileSync(file, "utf8")).not.toContain("/skill:example");
  await page
    .getByRole("textbox", { name: "给 Pi 发消息…" })
    .fill("phone picture");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("[data-message-id]").last()).toContainText(
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
  expect(JSON.parse(readFileSync(ownerFile, 'utf8')).pid).toBe(firstPID);
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).blur();
  const infoBar = page.getByRole('group', { name: '会话信息', exact: true });
  for (const label of ['输入 token', '输出 token', '缓存命中率', '上下文窗口']) {
    await expect(infoBar.locator(`[aria-label="${label}"]`)).toBeVisible();
  }
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "模型设置", exact: true });
  await settings.getByRole("group", { name: "思考强度", exact: true }).getByRole("button", { name: "高", exact: true }).click();
  await settings.getByRole("button", { name: "关闭模型设置", exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/status?id=' + encodeURIComponent(id))).json()).thinking).toBe('high');
  await expect(page.locator('.model-trigger')).toContainText('高');
  await expect(page.locator(".remote-compose-context [role=status]")).toHaveCount(0);
});

test("all matching skills remain scrollable and selectable with the mobile keyboard open", async ({
  page, sessionsDir, workingDir, agentDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "all-skills"), entries);
  const file = join(sessionsDir, "--home-user-demo-project--", id);
  const commandNames = Array.from({ length: 37 }, (_, i) => `skill:workflow-${i}`);
  const controls: string[] = [];
  const owner = await openFixtureOwner({
    agentDir, sessionPath: file,
    getState: () => ({ state: "running" }),
    control: (input: any) => {
      controls.push(input.action);
      return input.action === "commands" ? { commands: commandNames.map((name) => ({ name, source: "skill" })) } : {};
    },
  });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    const textbox = page.getByRole("textbox", { name: "给 Pi 发消息" });
    const candidates = page.locator(".remote-skills button");
    const originalSize = page.viewportSize()!;
    for (const width of [...new Set([originalSize.width, 320])]) {
      await page.setViewportSize({ width, height: originalSize.height });
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 360 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await textbox.fill("/");
      await expect(candidates).toHaveText(commandNames);
      await textbox.fill("/workflow-3");
      await expect(candidates).toHaveText(commandNames.filter((name) => name.includes("workflow-3")));
      await textbox.fill("/");
      await expect(candidates).toHaveText(commandNames);
      await candidates.last().scrollIntoViewIfNeeded();
      await expect(candidates.last()).toBeInViewport();
      const layout = await page.evaluate(() => {
        const auxiliary = document.querySelector(".remote-skills")!;
        const controls = [...document.querySelectorAll(".remote-composer textarea, .remote-composer .remote-actions")];
        return {
          scrollable: auxiliary.scrollHeight > auxiliary.clientHeight,
          controlsReachable: controls.every((element) => {
            const box = element.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= 361 && box.height > 0;
          }),
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        };
      });
      expect(layout).toEqual({ scrollable: true, controlsReachable: true, noOverflow: true });
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "停止主代理", exact: true })).toBeInViewport();
      await candidates.last().click();
      await expect(textbox).toHaveValue(`/${commandNames.at(-1)} `);
      await expect(candidates).toHaveCount(0);
    }
    expect(controls).not.toContain("send");
    expect(readFileSync(file, "utf8")).not.toContain("skill:workflow-");
  } finally { await owner.close(); }
});

test('new task and dormant session load skills before the first send without starting a worker', async ({
  page, sessionsDir, workingDir, agentDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'draft-skills'), entries);
  const commandNames = Array.from({ length: 37 }, (_, i) => `skill:draft-workflow-${i}`);
  const owners = join(agentDir, 'pi-web', 'owners');
  const registrations = () => existsSync(owners) ? readdirSync(owners).sort() : [];
  const before = registrations();
  const reads: URL[] = [];
  let creations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/new-session') creations++;
  });
  await page.route(/\/api\/commands\?/, (route) => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({ json: { commands: commandNames.map((name) => ({ name, source: "skill" })) } });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  await editor.getByRole('button', { name: '选择项目', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择项目', exact: true });
  await picker.locator('summary').filter({ hasText: '系统路径' }).click();
  await picker.getByRole('textbox', { name: '文件夹路径', exact: true }).fill(workingDir);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await picker.getByRole('button', { name: '使用此文件夹', exact: true }).click();
  const textbox = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await textbox.fill('/');
  const candidates = editor.locator('.remote-skills button');
  await expect(candidates).toHaveText(commandNames);
  expect(reads.at(-1)!.searchParams.get('path')).toBe(workingDir);
  await candidates.last().scrollIntoViewIfNeeded();
  await expect(candidates.last()).toBeInViewport();
  const layout = await editor.evaluate((element) => ({
    scrollable: element.querySelector('.remote-skills')!.scrollHeight > element.querySelector('.remote-skills')!.clientHeight,
    controlsReachable: [...element.querySelectorAll('textarea, .remote-actions')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= 361 && box.height > 0;
    }),
    noOverflow: element.scrollWidth <= 320,
  }));
  expect(layout).toEqual({ scrollable: true, controlsReachable: true, noOverflow: true });
  await page.screenshot({ path: info.outputPath('new-task-skills-320.png'), animations: 'disabled' });
  await candidates.last().click();
  await expect(textbox).toHaveValue(`/${commandNames.at(-1)} `);
  await expect(candidates).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  expect(await editor.evaluate((element) => element.scrollWidth <= 320)).toBe(true);
  expect(registrations()).toEqual(before);
  expect(creations).toBe(0);
  await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true }).fill('/draft-workflow-3');
  await expect(page.locator('.remote-skills button')).toHaveText(commandNames.filter((name) => name.includes('workflow-3')));
  expect(reads.at(-1)!.searchParams.get('id')).toBe(id);
  expect(registrations()).toEqual(before);
  expect(creations).toBe(0);
});

test('skill completion retries failed discovery and ignores the previous project response', async ({ page, workingDir }) => {
  const second = join(workingDir, 'second-project');
  mkdirSync(second);
  let firstReads = 0;
  await page.route(/\/api\/commands\?/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === workingDir && ++firstReads === 1) return route.fulfill({ status: 409, json: { error: 'Fixture read failure' } });
    return route.fulfill({ json: { commands: [{ name: path === second ? 'skill:second-project' : 'skill:first-project', source: 'skill' }] } });
  });
  await page.addInitScript(({ first }) => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/commands' && url.searchParams.get('path') === first) {
        if (!response.ok) {
          (window as any).__failedSkillReadHeld = true;
          await new Promise<void>((resolve) => { (window as any).__releaseFailedSkillRead = resolve; });
        } else {
          (window as any).__skillReadHeld = true;
          await new Promise<void>((resolve) => { (window as any).__releaseSkillRead = resolve; });
          (window as any).__skillReadReleased = true;
        }
      }
      return response;
    };
  }, { first: workingDir });
  await page.goto('/');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  const choose = async (path: string) => {
    await editor.getByRole('button', { name: '选择项目', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择项目', exact: true });
    await picker.locator('summary').filter({ hasText: '系统路径' }).click();
    await picker.getByRole('textbox', { name: '文件夹路径', exact: true }).fill(path);
    await picker.getByRole('button', { name: '前往', exact: true }).click();
    await picker.getByRole('button', { name: '使用此文件夹', exact: true }).click();
  };
  await choose(workingDir);
  const textbox = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  const failed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands');
  await textbox.fill('/');
  expect((await failed).status()).toBe(409);
  await page.waitForFunction(() => (window as any).__failedSkillReadHeld);
  await textbox.fill('/first');
  await page.evaluate(() => (window as any).__releaseFailedSkillRead());
  await page.waitForFunction(() => (window as any).__skillReadHeld);
  try {
    await choose(second);
    await textbox.fill('/');
    const candidates = editor.locator('.remote-skills button');
    await expect(candidates).toHaveText(['skill:second-project']);
    await page.evaluate(() => (window as any).__releaseSkillRead());
    await page.waitForFunction(() => (window as any).__skillReadReleased);
    await expect(candidates).toHaveText(['skill:second-project']);
    await candidates.first().click();
    await expect(textbox).toHaveValue('/skill:second-project ');
    expect(firstReads).toBe(2);
  } finally {
    await page.evaluate(() => (window as any).__releaseSkillRead?.());
  }
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
    .getByRole("textbox", { name: "给 Pi 发消息…" })
    .fill("quiet task [[slow:30000]]");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator('[data-message-id]').last()).toContainText('quiet task');
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
  await expect(page.locator(".remote-compose-context [role=status]")).toHaveCount(0);
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
  await page.getByRole('dialog', { name: '会话', exact: true }).getByRole('button', { name: '搜索会话', exact: true }).click();
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
  await picker.locator("summary").filter({ hasText: "系统路径" }).click();
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
  await expect(page.locator("[data-message-id]").last()).toContainText(
    "Stub reply: new work",
  );
});

test('a crashed worker becomes unavailable and the next send replaces it', async ({ page, sessionsDir, workingDir, agentDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'crash'), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('before crash');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('[data-message-id]').last()).toContainText('Stub reply: before crash');
  const file = join(agentDir, 'pi-web', 'owners', id + '.json');
  await expect.poll(() => existsSync(file)).toBe(true);
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'idle');
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  process.kill(owner.pid, 'SIGKILL');
  await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'unknown');
  await expect(page.getByText('控制桥接未连接', { exact: false })).toHaveCount(0);
  await page.getByRole('textbox', { name: "给 Pi 发消息…" }).fill('recovered task');
  const replacing = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/chat');
  await page.getByRole('button', { name: "发送", exact: true }).click();
  const replaced = await replacing;
  expect(replaced.status(), await replaced.text()).toBe(202);
  await expect(page.locator('[data-message-id]').last()).toContainText('Stub reply: recovered task');
  expect(JSON.parse(readFileSync(file, 'utf8')).pid).not.toBe(owner.pid);
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
    await expect(page.locator('[data-message-id]').last()).toContainText('Stub reply: second draft');
    await page.getByRole('button', { name: "停止主代理", exact: true }).click();
  } finally { await page.evaluate(() => (window as any).__releaseReceipt?.()).catch(() => {}); }
});

test('runtime state and controls work before the initial ordinary reply body resolves', async ({ page, request, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push(assistantTextEntry(lastId, 'Large ordinary reply. '.repeat(8000)).entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'independent-controls'), entries);
  expect((await request.post(`/api/chat?id=${encodeURIComponent(id)}`, { multipart: { message: 'prepare runtime' } })).status()).toBe(202);
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
    await expect(page.locator('[data-message-id]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true })).toHaveValue('');
    await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
    await page.evaluate(() => (window as any).__releaseBody());
    await expect(page.locator('.remote-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.remote-main')).toContainText('Large ordinary reply.');
    await expect(page.locator('[data-recovery-message]')).toHaveCount(0);
    await expect(page.locator('[data-message-id]').filter({ hasText: 'immediate control' })).toHaveCount(1);
  } finally { await page.evaluate(() => (window as any).__releaseBody?.()).catch(() => {}); }
});
