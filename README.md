# pi-web

A small mobile remote for your [Pi](https://pi.dev) coding agent. Open a session, read the result, and reply to the same Pi instance from your phone over your existing Tailscale connection.

## What it does

- Lists recent sessions, searches history, and clears unread replies when you open a session.
- Shows native runtime state. Missing, stale, conflicting, or disconnected evidence is unknown—not idle or finished.
- Loads recent messages first. Ordinary replies remain whole; tools, thinking, images, and older history load on demand.
- Sends text or pictures with Pi-native steer/follow-up delivery, and stops the main agent explicitly.
- Shows compact project/runtime information, model and thinking controls, and skill suggestions.

There is one responsive interface. No workspace sidebars, scratchpads, schedules, reviews, worktrees, web-managed queues, share/export, or notification machinery remain.

## Install and connect

```bash
pi install git:github.com/stoneedle/pi-web
```

This source fork needs Pi 1.3.0+, Go, Node.js, GNU Make, and Git. On Windows, use Git Bash; set `MAKE` to the GNU Make executable if it is outside `PATH`. Installation builds the frontend and binary and installs the native extensions. The server defaults to `http://127.0.0.1:31415`.

| Native command | Purpose |
|---|---|
| `/web` | Open the current session |
| `/remote` | Show the existing Tailscale HTTPS address and QR code |
| `/pi-web` | Inspect or explicitly manage the local service |

Set `PI_WEB_TOKEN` in `~/.config/pi-web/env` before remote access. Non-loopback binds require authentication; Tailscale Serve proxies the loopback listener without replacing your node's address. Existing history, cookies, and saved appearance remain in place.

Install [pi-title-glyphs](https://github.com/stoneedle/pi-title-glyphs) for native names and runtime heartbeats. The `pi-remote` extension controls the process holding the session; already-open Pi instances need to reload extensions after an update. Reading a session never starts another executor. **Continue in background** is an explicit action for an inactive session, and cannot compete with a registered live terminal.

A received message is accepted, not necessarily processed. Native dialogs still require the terminal. Unavailable context/cache/Fast measurements remain unknown.

## Development

```bash
make build       # frontend first, then the embedded Go binary
make test        # frontend, extensions, memory, Go, installer
make check       # lint, format, knip, tests, frontend build, vet
make e2e-setup   # one-time Playwright installation
make e2e         # isolated built-server tests across seven device/browser projects
```

Do not build with `go build` alone: the binary embeds the Vite output. E2E uses its own temporary agent directory and RPC fixture, not your service or sessions.

[Architecture](docs/architecture/system-overview.md) · [Installation](user-docs/en/install.md) · [Browser testing](docs/dev/e2e-testing.md)
