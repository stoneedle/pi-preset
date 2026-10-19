# Backend

## HTTP responsibilities

`internal/app` configures auth, native session storage, the worker manager, embedded assets, and server lifetime. `server.Register` exposes the following core routes; removed workspace URLs return 404.

| Route | Responsibility |
|---|---|
| `/`, `/session` | HTML shell without conversation data |
| `/api/sessions` | Session summaries, search, bounded `limit`/`offset` |
| `/api/session` | Recent window or `before`/`after` cursor projection |
| `/api/session/block` | One selected tool/thinking body |
| `/api/session/image` | One selected native image |
| `/api/status` | Validated runtime state and connected owner's capabilities |
| `/api/chat`, `/api/chat/cancel` | Send with native delivery or abort the main agent |
| `/api/session/continue` | Explicitly attach an inactive session to a background worker |
| `/api/new-session`, `/api/recent-locations` | Create in an existing directory; list known directories |
| `/api/models`, `/api/commands` | Owner models and skill-only suggestions |
| `/api/set-model`, `/api/set-thinking-level` | Change subsequent-request configuration |
| `/api/git/info` | Read the current branch |
| `/events` | SSE invalidation and status |

PWA assets and content-hashed frontend assets are embedded in the built binary. JSON and HTML can use gzip; SSE remains uncompressed. SQLite only supplies saved appearance settings. There are no web schedules, server chat queues, notifications, review comments, file browsers, share/export, or self-update handlers.

## Native message projection

`internal/sessions/window.go` follows native `parentId` links to select the active branch. Initial/history windows target 30 messages and approximately 64 KiB of text. The budget is soft: one ordinary long message remains whole. Tool results update their corresponding tool call instead of becoming unrelated assistant messages.

Initial descriptors omit tool arguments/results, thinking bodies, and image bytes. Those remain on disk until a body/image request. Cursors include branch identity; an invalid cursor produces a reset rather than silently joining unrelated branches. `after` requests carry new messages and changed tool cards, not the whole conversation.

File watchers own content invalidation, not execution state. They debounce repeated writes, discover existing JSONL files when adding a new project directory, and broadcast on the first observed version too. Polling supplies content invalidation when fsnotify cannot start. Parsed sessions are cached, and SSE subscribers receive lightweight reload hints.

## Runtime truth

`status.go` validates `session-status/<filename>.jsonl.<pid>.json`, written by the native runtime's title extension. A status must identify the session, have an accepted native state, and be within a ten-second heartbeat window. Multiple live owners, expired evidence, missing evidence, and disconnected controls are unknown. File mtime never implies running, idle, or complete.

Trusted native states are `running`, `background`, `needs-you`, and `idle`. An in-process worker may supply explicit running/error evidence when no heartbeat file exists; an old heartbeat is not overridden with an optimistic idle guess. The status watcher and one-second sweeper broadcast expiry even without another conversation write.

SSE snapshots are `id -> state`; deltas are `{id,state}`. `__all__` receives index-wide changes. Session subscribers receive their own state and content invalidations. Duplicate pending reload hints coalesce per client; slow clients cannot block producers.

## Same-instance control

`.pi/extensions/pi-remote.ts` starts an ephemeral loopback listener inside native Pi. A per-session owner file contains PID, port, native UUID, and a random bearer token. The listener rejects browser Origins, bounds bodies, checks the current session identity, and revokes its registration on session changes/shutdown. Go validates registration and forwards controls through `remote_owner.go`.

No control/status/read request implicitly creates a worker. Explicit continuation checks owner and terminal registrations first. `workers.Manager` single-flights creation and reuses one `pi --mode rpc --session <path>` process. Crashed workers are evicted; idle reaping after ten minutes requires positive native idle evidence. RPC busy state follows `agent_start`/`agent_settled`, not short silence or intermediate `agent_end` events.

Public native APIs accept a remote message; that receipt is not proof of provider execution. Native Pi owns its queues, tools, persistence, and dialogs. pi-web neither starts a competing terminal instance nor writes fabricated conversation entries.

## Auth and lifetime

Auth supports the existing token cookie/query/header flow. Unsafe browser requests require a matching Origin even on tokenless localhost; tokenless Host validation prevents DNS rebinding. Explicit non-loopback binds require a token unless the user chooses insecure mode. Tailscale Serve is configured only with a token.

JSON mutation requests are bounded; multipart images retain separate per-image and total limits. Owner credentials never enter browser responses. Server shutdown stops watchers/sweepers, waits for their goroutines, and closes SQLite; the app owns worker shutdown. Tests use temporary agent directories and never the user's running service.
