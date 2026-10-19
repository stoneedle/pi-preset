import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import {
  buildSession,
  uniqueSessionName,
  writeSession,
  assistantTextEntry,
  appendEntry,
} from "../lib/sessions";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZsAAAAASUVORK5CYII=";

test("mobile has one compact interface and no workspace entry points", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".remote-session").first()).toBeVisible();
  await expect(page.locator(".remote-header")).toContainText("127.0.0.1");
  for (const path of [
    "/settings",
    "/schedules",
    "/api/annotations",
    "/api/scratchpad",
    "/api/chat/queue",
    "/api/fork-session",
    "/share",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("folded tools, thinking, and images never travel before a click", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const large = "private-folded-body-".repeat(100000);
  entries.push({
    type: "message",
    id: "tool-call",
    parentId: lastId,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: large },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "inspect project", payload: large },
        },
      ],
    },
  });
  entries.push({
    type: "message",
    id: "tool-result",
    parentId: "tool-call",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: large }],
    },
  });
  entries.push({
    type: "message",
    id: "photo",
    parentId: "tool-result",
    message: {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: pixel }],
    },
  });
  entries.push(
    assistantTextEntry(
      "photo",
      "Answer stays complete. ![deferred image](https://example.invalid/do-not-fetch.png)",
    ).entry,
  );
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "lazy"),
    entries,
  );
  const requests: string[] = [];
  const initial: Promise<string>[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (["/session", "/api/session", "/api/status"].includes(path))
      initial.push(response.text().catch(() => ""));
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator(".remote-main")).toContainText(
    "Answer stays complete.",
  );
  const bodies = await Promise.all(initial);
  expect(bodies.join("")).not.toContain("private-folded-body-");
  expect(
    requests.some(
      (url) =>
        url.includes("/api/session/block") ||
        url.includes("/api/session/image") ||
        url.includes("do-not-fetch.png"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: /bash inspect project/ }).click();
  await expect(page.locator(".remote-block pre").first()).toContainText(
    "private-folded-body-",
  );
  expect(
    requests.filter((url) => url.includes("/api/session/block")).length,
  ).toBe(1);
  await page.getByRole("button", { name: "Open image", exact: true }).click();
  await expect(page.locator(".remote-block img")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("ordinary long replies remain whole and older history preserves its anchor", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  let parent = lastId;
  for (let i = 0; i < 85; i++) {
    const next = assistantTextEntry(parent, `History message ${i}.`);
    entries.push(next.entry);
    parent = next.id;
  }
  const text =
    "Long ordinary answer stays intact. ".repeat(4000) + "END-OF-ANSWER";
  const answer = assistantTextEntry(parent, text);
  entries.push(answer.entry);
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "history"),
    entries,
  );
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator(".remote-markdown").last()).toHaveText(text);
  const main = page.locator(".remote-main");
  await main.evaluate((element) => (element.scrollTop = 0));
  const first = page.locator("article").first();
  const anchor = await first.getAttribute("data-message-id");
  const position = (await first.boundingBox())!.y;
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await expect.poll(() => page.locator("article").count()).toBeGreaterThan(1);
  const anchored = page.locator(`[data-message-id="${anchor}"]`);
  await expect
    .poll(async () => Math.abs((await anchored.boundingBox())!.y - position))
    .toBeLessThan(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("background and attention are distinct; expired state becomes unknown", async ({
  page,
  sessionsDir,
  agentDir,
  workingDir,
}, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "state"),
    entries,
  );
  const directory = join(agentDir, "session-status");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${id}.12345.json`);
  const publish = (state: string, updatedAt = new Date().toISOString()) =>
    writeFileSync(file, JSON.stringify({ id, state, updatedAt }));
  publish("background");
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const state = page.locator(".remote-header .remote-state");
  await expect(state).toHaveAttribute("data-state", "background");
  publish("needs-you");
  await expect(state).toHaveAttribute("data-state", "needs-you");
  await expect(page.locator(".remote-main")).toContainText(
    "Native dialogs must be handled on the computer.",
  );
  publish("running", new Date(Date.now() - 60000).toISOString());
  await expect(state).toHaveAttribute("data-state", "unknown");
});

test("bursty live updates stay incremental and never overlap session downloads", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "burst"),
    entries,
  );
  let active = 0,
    maximum = 0;
  const paths: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/session") {
      active++;
      maximum = Math.max(maximum, active);
      paths.push(request.url());
    }
  });
  const finish = (request) => {
    if (new URL(request.url()).pathname === "/api/session") active--;
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  await page.route("**/api/session?**", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ response });
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator("article")).toHaveCount(2);
  let parent = lastId;
  for (let i = 0; i < 8; i++) {
    const next = assistantTextEntry(parent, `Incremental result ${i}`);
    appendEntry(sessionsDir, id, next.entry);
    parent = next.id;
    await page.waitForTimeout(80);
  }
  await expect(page.locator("article").last()).toContainText(
    "Incremental result 7",
  );
  await page.unrouteAll({ behavior: "wait" });
  expect(maximum).toBe(1);
  expect(paths.length).toBeGreaterThan(1);
  expect(paths.slice(1).every((path) => path.includes("&after="))).toBe(true);
});
