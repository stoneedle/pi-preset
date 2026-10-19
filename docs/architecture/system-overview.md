# System Overview

pi-web is a small mobile remote for native Pi sessions. The browser lists sessions, reads results, and sends messages to the Pi instance that owns the selected session. It has one interface, not a desktop workspace or a second rendering mode.

## Responsibilities

| Component | Owns |
|---|---|
| `web/src/routes/RemoteApp.svelte` | Session list, conversation, composer, and compact session information |
| `internal/server` | Authenticated HTTP/SSE boundary and routing to the session owner |
| `internal/sessions` | Native JSONL parsing, active-branch projection, recent windows, and history cursors |
| `.pi/extensions/pi-remote.ts` | Authenticated loopback controls inside the existing Pi process |
| `pi-title-glyphs` | Native names and runtime status heartbeats |
| `internal/workers` / `internal/rpc` | Explicit background continuation, one worker per session |
| `internal/ui` / `internal/frontend` | Small HTML shell and embedded, content-hashed Vite assets |

The Go server does not own the conversation ledger. Native Pi writes messages. Opening a page or asking for status never starts an executor. Creating a session or explicitly continuing an inactive session may start `pi --mode rpc --session <path>`; an existing owner or live terminal registration prevents competing execution.

## Data flow

```text
Native Pi JSONL ──> message windows ──> browser
       │                                 │
       └── fsnotify ──> SSE reload hints ─┘

Runtime heartbeat ──> validated state ──> SSE / status API

Browser action ──> Go auth ──> authenticated loopback owner ──> same Pi instance
                            └─> existing explicit background worker
```

The shell carries no conversation bootstrap. Initial JSON contains recent full user/assistant text and folded descriptors. Tool arguments/results, thinking bodies, and images have separate on-demand endpoints. History and subsequent changes use cursors. SSE is an invalidation/state channel, not another conversation transport.

## Storage and deployment

```text
~/.pi/agent/
  sessions/<encoded-project>/<native-session>.jsonl
  session-status/<native-session>.jsonl.<pid>.json
  pi-web.sqlite                         # saved appearance settings
  pi-web/
    pi-web-state.json                    # server discovery and lock
    owners/<native-session>.jsonl.json   # loopback owner credentials
    custom-themes.css                   # optional saved theme
```

Existing history, login cookies, saved appearance, and Tailscale addresses are preserved. Removed workspace features have no routes, renderers, schedulers, or compatibility mode. Their historical private files are not read or deleted.

The default listener is `127.0.0.1:31415`. Non-loopback access requires a token unless explicitly launched insecurely. With a token, Tailscale Serve can proxy the loopback listener over HTTPS without changing the node's existing address. `PI_CODING_AGENT_DIR` selects an isolated agent directory, including in E2E tests.

See [backend](backend.md), [frontend](frontend.md), and [E2E testing](../dev/e2e-testing.md).
