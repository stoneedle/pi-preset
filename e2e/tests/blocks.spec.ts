import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../lib/test";
import { buildSession, uniqueSessionName, writeSession } from "../lib/sessions";

const thinkingPreview = "先检查窄屏布局，再验证工具调用与状态图标。";
const command = "printf '%s\\n' " + "a-very-long-project-path/".repeat(30);
const code =
  'const result = await tools.bash({ command: "ls -la" });\ntext(result);';

async function openBlocks(
  {
    page,
    sessionsDir,
    workingDir,
  }: { page: Page; sessionsDir: string; workingDir: string },
  info: TestInfo,
) {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({
    type: "message",
    id: "signature-only",
    parentId: lastId,
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "opaque-provider-signature",
        },
      ],
    },
  });
  entries.push({
    type: "message",
    id: "compact-calls",
    parentId: "signature-only",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            thinkingPreview +
            "\n\n" +
            "Keep the original reasoning readable, and verify the narrow-screen layout before changing controls. ".repeat(
              20,
            ) +
            "full-thinking-body-only-after-click",
        },
        {
          type: "toolCall",
          id: "complete",
          name: "bash",
          arguments: { command },
        },
        {
          type: "toolCall",
          id: "pending",
          name: "bash",
          arguments: { command },
        },
        {
          type: "toolCall",
          id: "failed",
          name: "bash",
          arguments: { command },
        },
        {
          type: "toolCall",
          id: "empty",
          name: "a-very-long-custom-tool-name-without-summary",
          arguments: {},
        },
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "opaque-provider-signature",
        },
        {
          type: "thinking",
          thinking: "\n\t ",
          thinkingSignature: "opaque-provider-signature",
        },
        { type: "toolCall", id: "code", name: "codemode", arguments: { code } },
      ],
    },
  });
  entries.push({
    type: "message",
    id: "compact-result",
    parentId: "compact-calls",
    message: {
      role: "toolResult",
      toolCallId: "complete",
      content: [{ type: "text", text: "tool-result-only-after-click" }],
    },
  });
  entries.push({
    type: "message",
    id: "compact-error",
    parentId: "compact-result",
    message: {
      role: "toolResult",
      toolCallId: "failed",
      isError: true,
      content: [{ type: "text", text: "Command failed." }],
    },
  });
  entries.push({
    type: "message", id: "commentary", parentId: "compact-error",
    message: { role: "assistant", content: [{ type: "text", text: "已定位窄屏问题，接下来验证修改后的布局。" }] },
  });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, "compact-blocks"),
    entries,
  );
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.locator(".remote-block-toggle").nth(4)).toBeVisible();
  return requests;
}

test("tool headers stay horizontal at the real device width and 320px", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  await openBlocks({ page, sessionsDir, workingDir }, info);
  const nativeSize = page.viewportSize()!;
  for (const width of [...new Set([nativeSize.width, 360, 320])]) {
    await page.setViewportSize({ width, height: nativeSize.height });
    const headers = await page
      .locator(".remote-block-toggle")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          const children = [...element.children].map((child) => {
            const rect = child.getBoundingClientRect();
            return {
              text: child.textContent,
              left: rect.left,
              right: rect.right,
              height: rect.height,
            };
          });
          return {
            height: box.height,
            left: box.left,
            right: box.right,
            children,
          };
        }),
      );
    expect(
      headers.every((header) => header.height <= 30),
      JSON.stringify({ width, headers }),
    ).toBe(true);
    expect(
      headers.every((header) => header.left >= 0 && header.right <= width),
      JSON.stringify({ width, headers }),
    ).toBe(true);
    expect(
      headers.every((header) =>
        header.children.every((child) => child.height <= 24),
      ),
      JSON.stringify({ width, headers }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: info.outputPath("compact-320.png"),
    fullPage: true,
  });
});

test("conversation has no repeated role labels, message separators or tool-card borders", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  await openBlocks({ page, sessionsDir, workingDir }, info);
  await expect(page.locator(".remote-role")).toHaveCount(0);
  const borders = await page
    .locator("article, .remote-block")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ];
      }),
    );
  expect(
    borders.every((sides) => sides.every((width) => width === "0px")),
    JSON.stringify(borders),
  ).toBe(true);
});

test("signature-only thinking never creates an empty expandable row or message", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const requests = await openBlocks({ page, sessionsDir, workingDir }, info);
  await expect(
    page.locator(".remote-block-name").filter({ hasText: /^思考$/ }),
  ).toHaveCount(1);
  await expect(page.locator('[data-message-id="signature-only"]')).toHaveCount(
    0,
  );
  await expect(page.locator(".remote-block-toggle")).toHaveCount(6);
  const response = await page.request.get(
    requests.find((url) => new URL(url).pathname === "/api/session")!,
  );
  const payload = await response.json();
  expect(
    payload.window.messages.every(
      (message: { blocks: unknown[]; error?: string }) => message.blocks.length > 0 || message.error,
    ),
  ).toBe(true);
  expect(JSON.stringify(payload)).not.toContain("opaque-provider-signature");
});

test("codemode shows a code preview and expands the complete original input", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const requests = await openBlocks({ page, sessionsDir, workingDir }, info);
  const header = page.locator(".remote-block-toggle").filter({
    has: page.locator(".remote-block-name", { hasText: /^codemode$/ }),
  });
  await expect(header.locator(".remote-block-summary")).toHaveText(
    code.replace(/\s+/g, " "),
  );
  expect(requests.some((url) => url.includes("/api/session/block"))).toBe(
    false,
  );
  await header.click();
  const input = await page.locator(".remote-block pre").textContent();
  expect(JSON.parse(input!).code).toBe(code);
  await header.click();
  await expect(page.locator(".remote-block pre")).toHaveCount(0);
});

test("composer exposes no delivery selector and process rows remain secondary to commentary", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  await openBlocks({ page, sessionsDir, workingDir }, info);
  await expect(page.getByRole("combobox", { name: "消息投递" })).toHaveCount(0);
  await expect(page.locator(".remote-delivery")).toHaveCount(0);
  const hierarchy = await page.evaluate(() => {
    const text = document.querySelector('[data-message-id="commentary"] .remote-markdown')!;
    const rows = [...document.querySelectorAll(".remote-block-toggle")];
    return {
      textSize: parseFloat(getComputedStyle(text).fontSize),
      textColor: getComputedStyle(text).color,
      rows: rows.map((row) => ({ height: row.getBoundingClientRect().height, size: parseFloat(getComputedStyle(row).fontSize), color: getComputedStyle(row).color })),
      processHeight: document.querySelector('[data-message-id="compact-calls"]')!.getBoundingClientRect().height,
    };
  });
  expect(hierarchy.rows.every((row) => row.height <= 30 && row.size < hierarchy.textSize && row.color !== hierarchy.textColor)).toBe(true);
  expect(hierarchy.processHeight).toBeLessThanOrEqual(180);
});

test("thinking has a bounded preview without downloading folded bodies", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const requests = await openBlocks({ page, sessionsDir, workingDir }, info);
  const thinking = page.locator(".remote-block-toggle").first();
  await expect(thinking.locator(".remote-block-summary")).toContainText(
    thinkingPreview,
  );
  const response = await page.request.get(
    requests.find((url) => new URL(url).pathname === "/api/session")!,
  );
  const content = await response.text();
  expect(content).toContain(thinkingPreview);
  expect(content).not.toContain("full-thinking-body-only-after-click");
  expect(content).not.toContain("tool-result-only-after-click");
  expect(requests.some((url) => url.includes("/api/session/block"))).toBe(
    false,
  );
  await thinking.click();
  await expect(page.locator(".remote-block pre").first()).toContainText(
    "full-thinking-body-only-after-click",
  );
  await expect(page.locator(".remote-thinking")).toHaveCSS(
    "white-space",
    "pre-wrap",
  );
  await page.screenshot({
    path: info.outputPath("thinking-expanded.png"),
    fullPage: true,
  });
  await thinking.click();
  await expect(page.locator(".remote-block pre")).toHaveCount(0);
});

test("tool states are accessible icons and expand with touch or keyboard", async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  await openBlocks({ page, sessionsDir, workingDir }, info);
  for (const [index, state] of [
    [1, "done"],
    [2, "pending"],
    [3, "error"],
  ] as const) {
    const header = page.locator(".remote-block-toggle").nth(index);
    const status = header.locator(".remote-block-state");
    await expect(status).toHaveAttribute("data-state", state);
    await expect(status).toHaveAttribute("aria-label", /.+/);
    await expect(status.locator("svg")).toHaveCount(1);
    expect(await status.innerText()).toBe("");
  }
  const completed = page.locator(".remote-block-toggle").nth(1);
  await completed.focus();
  await page.keyboard.press("Enter");
  await expect(completed).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".remote-block pre").last()).toHaveText(
    "tool-result-only-after-click",
  );
  await page.screenshot({
    path: info.outputPath("compact-expanded.png"),
    fullPage: true,
  });
  await completed.click();
  await expect(completed).toHaveAttribute("aria-expanded", "false");
});
