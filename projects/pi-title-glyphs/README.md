# pi-title-glyphs

This [t0mj/pi-title-glyphs](https://github.com/t0mj/pi-title-glyphs) fork gives a Pi session a stable name from its **first non-empty user input**, then displays that name with live terminal status.

```text
⏳ · Fix subtitle import     working
❗ · Fix subtitle import     waiting for input
🔵 · Fix subtitle import     finished in the background, unread
✓ · Fix subtitle import      finished and viewed
```

Later questions, tools and dialogs leave the name unchanged. Manual `/name` or browser renaming is persistent and takes precedence over an unfinished automatic summary. Existing named sessions keep their names on reload and resume.

## Install

Requires Node.js 22.19+ and Pi 1.0.4.

```bash
pi install git:github.com/stoneedle/pi-title-glyphs
```

Keep one installed copy. For development, install this checkout with `pi install .`.

Pi 1.0.4 needs its native title owner repaired so default host updates preserve the extension's status prefix. From this checkout, run:

```bash
node scripts/patch-pi-title.mjs "$(npm root -g)/@earendil-works/pi-coding-agent"
```

The script accepts only Pi 1.0.4 and fails if its source differs from the supported seam. Restart Pi after applying it. Reinstalling the host replaces this repair; apply it again for that host installation. Ordinary extension changes can use `/reload`.

## Naming

[`src/session-title.ts`](src/session-title.ts) saves the initial opening-text excerpt with Pi's native `setSessionName`. By default this is the final automatic name. To request one background model summary, create `<agent-dir>/extension-data/pi-title-glyphs/config.json`:

```json
{ "model": "openai-codex/gpt-6-luna" }
```

An empty object disables model summarization. Configuration takes effect on session load. The selected model uses Pi's existing model registry and authentication; the main task proceeds while the summary is generated. Only the opening-task excerpt is sent. Failed requests report an error and preserve the initial name.

The latest native `session_info` revision decides whether a result can commit. Manual renaming, including renaming to the same text, invalidates a pending result. On reopen, an existing saved name completes automatic naming for that session.

## pi-web integration

Use [stoneedle/pi-web](https://github.com/stoneedle/pi-web). The title plugin owns automatic naming in terminal and RPC sessions; pi-web reads the native saved name and supplies the manual rename UI.

[`src/owner.ts`](src/owner.ts) publishes one authenticated loopback owner per active session. Its private registration is `<agent-dir>/extension-data/pi-title-glyphs/owners/<session-file-name>.json`. Other Pi views and pi-web route active renames to that instance. Inactive web renames append native `session_info` entries with IDs and parent links. A live-owner failure is reported, leaving the saved name intact.

## Display

Status follows agent activity, actual dialog completion state and terminal focus. Focus-in or interactive input acknowledges unread completion. RPC and print sessions participate in naming; TUI sessions render titles through `ctx.ui.setTitle`. Grapheme-aware truncation preserves emoji, flags and combining characters.

| Variable | Effect |
|---|---|
| `PI_TITLE_GLYPHS_CWD=1` | Include the project directory name |
| `PI_TITLE_GLYPHS_STATUS_FILE` | External badge file; default `<agent-dir>/extension-data/pi-title-glyphs/status-<pid>.json` |

External badges add a glyph to the prefix:

```json
{ "emoji": "🔓", "expiresAt": 1789200000000 }
```

Glyphs are capped at eight graphemes. `expiresAt` is optional epoch milliseconds; malformed, unavailable or expired badges are ignored.

## Verify

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

The tests use real Pi persistence, the native extension loader, actual owner HTTP requests and host title methods. See [CONTRIBUTING.md](CONTRIBUTING.md) for the shared pi-web integration entrance.

## License

MIT. Original extension by t0mj; fork customizations by stoneedle.
