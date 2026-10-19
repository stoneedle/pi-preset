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
  expect(
    readdirSync(join(agentDir, "session-status")).filter((name) =>
      name.startsWith(id + "."),
    ),
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Continue in background", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await page.getByRole("textbox", { name: "Message Pi…" }).fill("hello mobile");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("article").last()).toContainText(
    "Stub reply: hello mobile",
  );
  expect(readFileSync(file, "utf8")).toContain("hello mobile");
  await page.getByRole("textbox", { name: "Message Pi…" }).fill("/mem");
  await page.getByRole("button", { name: /skill:memory/ }).click();
  await expect(page.getByRole("textbox", { name: "Message Pi…" })).toHaveValue(
    "/skill:memory ",
  );
  expect(readFileSync(file, "utf8")).not.toContain("/skill:memory");
  await page
    .getByRole("textbox", { name: "Message Pi…" })
    .fill("phone picture");
  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: pixel });
  await page.getByRole("button", { name: "Send", exact: true }).click();
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
        entry.message.content.some((block) => block.type === "image"),
    ),
  ).toBe(true);
  expect(
    readdirSync(join(agentDir, "session-status")).filter(
      (name) => name.startsWith(id + ".") && name.endsWith(".json"),
    ),
  ).toHaveLength(1);
  await page.locator(".remote-info summary").click();
  await expect(page.locator(".remote-info dl dt")).toHaveCount(7);
  await page
    .locator(".remote-info label")
    .filter({ hasText: "Thinking" })
    .locator("select")
    .selectOption("high");
  await expect(page.locator(".remote-info dd").last()).toHaveText("high");
});

test("quiet runs stay active beyond the heartbeat TTL and stopping is explicit", async ({
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
    .getByRole("button", { name: "Continue in background", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Message Pi…" })
    .fill("quiet task [[slow:30000]]");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
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
    .getByRole("button", { name: "Stop main agent", exact: true })
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
  await expect(card.locator(".remote-unread")).toBeVisible();
  await card.click();
  await expect(page.locator("article")).toHaveCount(2);
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await page.getByRole("searchbox").fill(id);
  await expect(
    page.locator(
      `a[href="/session?id=${encodeURIComponent(id)}"] .remote-unread`,
    ),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByLabel("Working directory", { exact: true }).fill(workingDir);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/session\?id=/);
  await page.getByRole("textbox", { name: "Message Pi…" }).fill("new work");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
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
