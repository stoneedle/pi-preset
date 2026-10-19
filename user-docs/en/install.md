# Installation and usage

pi-web is a mobile session reader and remote control, not a second Pi workspace. It controls the native process holding a session; inactive history can be continued explicitly in a background worker.

## Requirements

- Pi 1.3.0+, Node.js 22.19+, Go 1.26+, Git, and GNU Make.
- Git Bash on Windows. Set `MAKE` to the GNU Make executable if it is outside `PATH`.
- Tailscale for remote HTTPS access.

## Install

```bash
pi install git:github.com/stoneedle/pi-title-glyphs
pi install git:github.com/stoneedle/pi-web
```

The source package builds its frontend and Go binary, installs the binary in `~/.pi/agent/bin/`, and configures login startup. The title extension owns native names and runtime heartbeats; pi-web displays those facts without renaming history or patching the Pi host.

For a local checkout:

```bash
git clone https://github.com/stoneedle/pi-web.git
cd pi-web
make build
pi install .
node scripts/run-lifecycle.mjs install
```

On Windows, the binary is `pi-web.exe`. Lifecycle installation also builds before installing. Already-open Pi instances need `/reload` after an extension update so the in-process control bridge is registered. Use `/web` to open the current session, `/remote` for the Tailscale URL/QR code, and `/pi-web` for explicit local service management.

## Remote access

The default address is `http://127.0.0.1:31415`. Set a stable token in `~/.config/pi-web/env`:

```text
PI_WEB_TOKEN=your-private-token
```

Restart the service, then use `/remote`. Keep the same token to preserve existing browser login. pi-web uses the node's existing Tailscale HTTPS address; it does not require a new identity, profile, or session store. On macOS, first open Tailscale interactively, approve its administrator prompt, and sign in. On Linux, your user may need `sudo tailscale set --operator=$USER`.

Explicit non-loopback binds require a token:

```bash
pi-web --host 127.0.0.1
PI_WEB_TOKEN=your-private-token pi-web --host 192.168.1.50
```

Without a token, startup stays loopback-only and does not enable Tailscale Serve. `--insecure` is only for deliberately unauthenticated local testing. Scripts can use `Authorization: Bearer <token>` or `X-Pi-Token`. The browser login/query flow sets the existing `pi_token` cookie and removes the token from the URL.

## Reading and replying

Open a session to clear its unread marker. Recent full text appears first; expand a tool/thinking block or image to retrieve it, or load earlier messages without losing your reading position. A disconnect, stale heartbeat, or unavailable measurement appears as unknown.

Use the Send button for text and the picture picker for camera/library attachments. Choose **Send / steer** or **Next turn** for Pi-native delivery. Skill suggestions only fill the draft. Model and thinking controls are in the session information section and affect subsequent requests. Accepted means handed to Pi, not proof that the model has processed it. Native dialogs still require the terminal.

Browsing never creates another executor. **Continue in background** is explicit and refuses to compete with a registered live terminal. There is no external-message refresh command or browser-managed queue.

## Login startup and uninstall

The installer configures launchd on macOS, a systemd user service on Linux, or an HKCU Run entry with a hidden launcher under `~/.config/pi-web/` on Windows. Windows has no automatic crash supervision; `/pi-web` can manage the service explicitly.

```bash
pi remove git:github.com/stoneedle/pi-web
```

Uninstall removes the package's binary and startup registration. Native JSONL history, saved appearance, memory databases, and `~/.config/pi-web/env` remain. Do not delete or replace those files to update the interface.

## Development

`make build`, `make check`, and `make e2e` are the verification entry points. E2E starts an isolated test server with temporary sessions and a deterministic native RPC fixture. `make dev` is an explicit developer action using port 31416 and a separate runtime lock; it is not a second product mode. Do not drive one session through two server instances.
