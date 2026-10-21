import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "../lib/test";
import { startServer, stopServer } from "../lib/server";
import { buildSession, uniqueSessionName, writeSession } from "../lib/sessions";

test("host switching preserves independent sign-in and carries only browser bookmarks", async ({ page, context, baseURL, workingDir }, info) => {
  const secondAgentDir = join(workingDir, "second-host");
  const secondCwd = join(secondAgentDir, "project");
  mkdirSync(secondCwd, { recursive: true });
  const { entries } = buildSession({ cwd: secondCwd });
  const sessionName = `Only on second host ${randomUUID()}`;
  entries[0].name = sessionName;
  writeSession(join(secondAgentDir, "sessions"), uniqueSessionName(info, "second-host"), entries);
  const token = randomUUID();
  const second = await startServer({ agentDir: secondAgentDir, token });
  const secondURL = second.baseURL.replace("127.0.0.1", "localhost");
  const firstURL = new URL(baseURL!).origin;
  try {
    await page.goto(`${secondURL}/?token=${token}`);
    await expect(page.locator(".remote-session")).toContainText(sessionName);
    const before = (await context.cookies(secondURL)).find((cookie) => cookie.name === "pi_token");
    expect(before?.value).toBe(token);
    await page.goto("/");
    await page.getByRole("button", { name: "切换主机", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "主机", exact: true });
    await dialog.getByRole("textbox", { name: "主机地址", exact: true }).fill(`${secondURL}/session?token=not-a-real-token`);
    await dialog.getByRole("button", { name: "保存主机", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("不含会话路径、令牌");
    await dialog.getByRole("textbox", { name: "主机地址", exact: true }).fill(secondURL);
    const alias = "Notebook with a long descriptive host name — independent machine";
    await dialog.getByRole("textbox", { name: "名称（可选）", exact: true }).fill(alias);
    const secondRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(secondURL) && request.url().includes("/api/")) secondRequests.push(request.url());
    });
    await dialog.getByRole("button", { name: "保存主机", exact: true }).click();
    const destination = dialog.getByRole("button").filter({ hasText: secondURL });
    await expect(destination).toContainText(alias);
    expect(secondRequests).toEqual([]);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (info.project.name === "Mobile Chrome") await page.screenshot({ path: info.outputPath("host-switcher.png") });
    await destination.click();
    await expect(page).toHaveURL(secondURL + "/");
    await expect(page.locator(".remote-session")).toContainText(sessionName);
    await expect(page.getByRole("button", { name: "切换主机", exact: true })).toContainText(new URL(secondURL).host);
    expect((await context.cookies(secondURL)).find((cookie) => cookie.name === "pi_token")).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem("pi-web:hosts"))).not.toContain(token);
    expect((await fetch(secondURL + "/api/sessions")).status).toBe(401);
    await page.reload();
    await page.getByRole("button", { name: "切换主机", exact: true }).click();
    await page.getByRole("dialog", { name: "主机", exact: true }).getByRole("button").filter({ hasText: firstURL }).click();
    await expect(page).toHaveURL(firstURL + "/");
    await expect(page.locator(".remote-sessions")).not.toContainText(sessionName);
    await page.getByRole("button", { name: "切换主机", exact: true }).click();
    await page.getByRole("button", { name: `移除 ${alias}`, exact: true }).click();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "切换主机", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "主机", exact: true })).not.toContainText(secondURL);
    await stopServer(second.child);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await expect(page.locator(".remote-session").first()).toBeVisible();
  } finally {
    if (second.child.exitCode === null) await stopServer(second.child);
  }
});
