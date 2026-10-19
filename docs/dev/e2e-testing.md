# End-to-end testing

Playwright drives the built pi-web binary with its production frontend. The suite covers reading, native-owner boundaries, background continuation, text/images, skills, runtime state, history, and narrow layouts. It is separate from `make test` / `make check` because it needs browser binaries.

```bash
make e2e-setup
make e2e

# Rebuild first when running Playwright directly:
make build e2e-stub
cd e2e
npx playwright test --project="Mobile Chrome" --workers=1
npx playwright test --workers=2
npx playwright test --headed --project="Desktop Chrome" --workers=1
```

## Isolation and protocol

`global-setup.ts` creates a temporary `PI_CODING_AGENT_DIR`, copies sanitized session fixtures, and starts the built server on a free loopback port with auth disabled and an explicit host (no Tailscale changes). Tests never attach to the user's server, browser profile, or sessions.

The fixture `pi` is first in PATH. Windows uses the launcher built by `make e2e-stub`; it forwards the actual CLI arguments to the shared Node fixture. The fixture starts with `--session <path>` and writes canonical JSONL user/assistant entries plus runtime heartbeat files. It implements prompt, native delivery, abort, commands, model/thinking, and state. Busy state ends at `agent_settled`, not an intermediate `agent_end`.

The fixture emits heartbeats while a model request is deliberately quiet. That verifies that a session can remain running beyond the ten-second status TTL without another conversation write. Teardown stops the owned server/process tree before removing temporary files, including on Windows.

## Browser/device matrix

Every case runs in all seven projects:

| Project | Engine | Width |
|---|---|---|
| Desktop Chrome | Chromium | 1280 |
| Desktop Firefox | Firefox | 1280 |
| Desktop Safari | WebKit | 1280 |
| Mobile Chrome / Pixel 5 | Chromium | 393 |
| Mobile Safari / iPhone 13 | WebKit | 390 |
| iPad portrait | WebKit | 810 |
| iPad landscape | WebKit | approximately 1080 |

These are device-emulated desktop engines, not physical-phone or Safari.app tests. The same compact interface adapts to every width; there is no separate desktop layout mode.

## Current specs

`mobile.spec.ts` checks removed routes, bounded layout, multi-megabyte folded bodies absent before clicks, deferred images, whole long replies, history anchors, distinct attention/background states, expiry, and single-flight incremental updates under bursty writes.

`control.spec.ts` checks passive browsing, explicit continuation with exactly one worker, persisted text/image replies, non-executing skill suggestions, thinking changes, long silent runs, stopping, new-session replies, and click-to-clear unread behavior. New-session coverage includes a newly created project directory, not only already-watched fixture directories.

Mutating tests create unique native sessions and existing temporary working directories through `lib/sessions.ts` and `lib/test.ts`. Do not mutate committed fixtures. Keep the configured narrow viewport; do not widen it or relax content assertions to hide overflow/truncation. Native in-process bridge authorization/session identity also has extension and Go integration coverage; the RPC fixture does not prove a real provider or physical camera works.

Sanitized real fixtures can be regenerated with `scripts/sanitize-session.mjs` inside `e2e/`; inspect output for private data before committing. CI installs Chromium/Firefox/WebKit, builds, and runs this matrix, uploading traces/reports on failure.
