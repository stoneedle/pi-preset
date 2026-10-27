import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  let unsubscribeInput: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    unsubscribeInput?.();
    if (ctx.mode !== "tui" || process.platform !== "win32" || process.env.TERM_PROGRAM !== "Tabby") return;

    // Tabby sends Alt+Shift+F as ESC F; normalize it to CSI-u.
    unsubscribeInput = ctx.ui.onTerminalInput((data) =>
      data === "\x1bF" ? { data: "\x1b[102;4u" } : undefined,
    );
  });

  pi.on("session_shutdown", () => unsubscribeInput?.());

  pi.registerShortcut("alt+shift+f", {
    description: "Toggle Codex Fast mode",
    handler: (ctx) => {
      if (!pi.getCommands().some((command) => command.name === "codex-fast" && command.source === "extension")) {
        ctx.ui.notify("pi-codex-fast is not loaded.", "warning");
        return;
      }

      pi.sendUserMessage("/codex-fast", { expandPromptTemplates: true });
    },
  });
}
