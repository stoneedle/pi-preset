/** Stable session names with optional background summaries and live terminal status. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { externalBadge, renderTitle } from "./format.ts";
import { observeTerminalFocus } from "./focus.ts";
import { SessionTitle, firstUserText, titleModel } from "./session-title.ts";
import { openTitleOwner, type TitleOwner } from "./owner.ts";

function statusFile(): string {
  return process.env.PI_TITLE_GLYPHS_STATUS_FILE
    ?? path.join(getAgentDir(), "extension-data", "pi-title-glyphs", `status-${process.pid}.json`);
}

export default function (pi: ExtensionAPI) {
  let state: "working" | "needs-you" | "resting" = "resting";
  let unread = false;
  let focused = true;
  let stopObservingFocus: (() => void) | undefined;
  let nameWatcher: fs.FSWatcher | undefined;
  let title: SessionTitle | undefined;
  let owner: TitleOwner | undefined;
  let ctxRef: ExtensionContext | undefined;

  function render() {
    if (!ctxRef || ctxRef.mode !== "tui") return;
    ctxRef.ui.setTitle(renderTitle({
      state, unread, cwdName: path.basename(ctxRef.cwd),
      title: title?.name,
      badge: externalBadge(statusFile()),
    }));
  }

  async function close() {
    stopObservingFocus?.();
    stopObservingFocus = undefined;
    nameWatcher?.close();
    nameWatcher = undefined;
    await title?.close();
    await owner?.close();
    title = undefined;
    owner = undefined;
    ctxRef = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    await close();
    ctxRef = ctx;
    state = ctx.isIdle() ? "resting" : "working";
    unread = false;
    focused = true;
    title = new SessionTitle(pi, ctx, titleModel(getAgentDir()));
    owner = await openTitleOwner(getAgentDir(), ctx, title);
    const first = firstUserText(ctx);
    if (first) await owner.initialize(first);

    const file = ctx.sessionManager.getSessionFile();
    if (file) {
      nameWatcher = fs.watch(path.dirname(file), (_event, filename) => {
        if (filename?.toString() !== path.basename(file)) return;
        try {
          title?.nameChanged();
          render();
        } catch (error) {
          ctx.ui.notify(`Title sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      });
    }
    if (ctx.mode === "tui" && process.stdin.isTTY) {
      stopObservingFocus = observeTerminalFocus((visible) => {
        focused = visible;
        if (visible) unread = false;
        render();
      });
    }
    render();
  });

  pi.on("session_shutdown", close);

  pi.on("session_info_changed", async (event, ctx) => {
    title?.nameChanged();
    if (owner?.local === false && event.name) await owner.rename(event.name);
    ctxRef = ctx;
    render();
  });

  pi.on("session_tree", async (_event, ctx) => {
    ctxRef = ctx;
    render();
  });

  pi.on("input", async (event, ctx) => {
    ctxRef = ctx;
    if (event.source === "extension") return;
    if (event.source === "interactive") {
      focused = true;
      unread = false;
    }
    if (event.text && owner) await owner.initialize(event.text);
    render();
  });

  pi.on("agent_start", async (_event, ctx) => {
    ctxRef = ctx;
    state = "working";
    unread = false;
    render();
  });

  pi.on("model_select", async (_event, ctx) => { ctxRef = ctx; render(); });
  pi.on("tool_execution_start", async (_event, ctx) => { ctxRef = ctx; render(); });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    ctxRef = ctx;
    state = "needs-you";
    render();
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    ctxRef = ctx;
    state = ctx.isIdle() ? "resting" : "working";
    render();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    ctxRef = ctx;
    state = "resting";
    unread = !focused;
    render();
  });
}
