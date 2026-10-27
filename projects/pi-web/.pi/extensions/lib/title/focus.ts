import { isKeyRelease, parseKey, StdinBuffer } from "@earendil-works/pi-tui";

/**
 * Observe the focus reporting already enabled by Pi's fullscreen TUI.
 * Its viewport consumes focus events before extension onTerminalInput handlers,
 * so observe stdin without consuming, changing raw mode, or writing escapes.
 * StdinBuffer keeps split sequences and pasted text separate, just as Pi does.
 */
export function observeTerminalFocus(onFocus: (focused: boolean) => void): () => void {
  const buffer = new StdinBuffer();

  buffer.on("data", (sequence) => {
    if (sequence === "\x1b[O") {
      onFocus(false);
    } else if (sequence === "\x1b[I") {
      onFocus(true);
    } else if (!isKeyRelease(sequence) && (
      parseKey(sequence) !== undefined ||
      (sequence.length > 0 && !sequence.startsWith("\x1b"))
    )) {
      // Typing is also an acknowledgement; terminal replies are not.
      onFocus(true);
    }
  });
  buffer.on("paste", () => onFocus(true));

  const onData = (data: string | Buffer) => buffer.process(data);
  process.stdin.prependListener("data", onData);

  return () => {
    process.stdin.off("data", onData);
    buffer.destroy();
  };
}
