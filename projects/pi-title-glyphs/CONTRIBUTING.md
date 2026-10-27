# Contributing

The saved Pi session name gives terminal and browser views one identity. Status is a separate display concern.

| Owner | Responsibility |
|---|---|
| `src/session-title.ts` | Initial name, optional model request, persisted revision eligibility |
| `src/owner.ts` | Active naming ownership and authenticated loopback transport |
| `src/index.ts` | Session lifecycle, name observation and status events |
| `src/format.ts` | Grapheme-safe title and badge rendering |
| `src/focus.ts` | Observe Pi's existing focus reports and release listeners |
| `scripts/patch-pi-title.mjs` | Pi 1.0.4 host title override and reset seam |

## Verification

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

Tests use isolated native session files. Controlled model completions verify late-result rejection without making subscription requests. The host test repairs only the development dependency and captures actual native title writes.

The companion web fork provides a cross-repository E2E entrance:

```bash
# In the pi-web checkout, with this checkout's dependencies installed:
PI_TITLE_GLYPHS_ROOT=/path/to/pi-title-glyphs make title-e2e
```

It sends a real web HTTP rename to a real title owner, releases a late model response, closes the owner, renames offline, and reopens through Pi. Final saved names must agree across both views. `test/owner-fixture.mjs` owns that isolated actor's lifetime.

For a live terminal check, load the extension, submit an opening request, and then a short follow-up. The same name should survive tools and dialogs. Rename while a summary is pending and resume the saved session. With terminal focus reporting, verify that background completion's `🔵` clears on focus.

## Design

Automatic naming has one owner. Pi owns persistence; the web consumes the same native name. Model requests are direct, optional and background-only. Commit eligibility is checked against persisted metadata, including updates from another Pi view. Live-owner errors propagate so failed transport cannot create a competing file writer.
