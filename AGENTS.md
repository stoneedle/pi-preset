# Development Rules

- Only create an abstraction if it's actually needed
- Prefer clear function/variable names over inline comments
- Avoid helper functions when a simple inline expression would suffice
- Use knip to remove unused code if making large changes

## Docs

Read the relevant doc in `@docs/` before structural changes, and update the matching doc whenever your change makes it out of date.

### Localized docs

The root `README.md` and everything under `user-docs/en/` are the English source of truth. Translations are machine-drafted, never hand-written:

- Edit only the English source. Never edit `user-docs/readme/README.<lang>.md` or `user-docs/<lang>/*.md` by hand.
- Regenerate translations with the scripts (they translate via `pi`):
  - `python3 scripts/build_readmes.py` — root `README.md` → `user-docs/readme/README.<lang>.md`
  - `python3 scripts/build_userdocs.py` — `user-docs/en/*.md` → `user-docs/<lang>/*.md`
  - Pass language codes to rebuild a subset, e.g. `python3 scripts/build_userdocs.py es ja`.
- To add a language: write the English first, add the code + native name to the `LANGS` (and `TRANSLATE_TARGET`) lists in both scripts and the nav, then run the scripts for the new code.

## Testing

```bash
make test   # vitest + go test ./...
make check  # lint + format-check + test + build + vet (run before pushing)
make e2e    # Playwright E2E; needs `make e2e-setup` once. Not in test/check
```

- **Go:** table-driven tests in `*_test.go` alongside source.
- **Frontend:** tests next to source (`foo.js` → `foo.test.js`); DOM helpers take `{ documentImpl, windowImpl }` for DI.
- **Lint/format (frontend):** ESLint (`eslint-plugin-svelte`) + Prettier, config in `web/`. `make check` runs `frontend-lint` + `frontend-format-check`. Fix locally with `cd web && npm run format` (auto-format) and `npm run lint`. Style is 2-space indent, single quotes (enforced by Prettier).
- **E2E:** lives in `e2e/` (Playwright, built binary across desktop/mobile/iPad, stub `pi`). See `docs/dev/e2e-testing.md`.
- **Always `make build`, never `go build` alone** — `//go:embed` needs the current `web/dist` from the frontend build.

## Critical Rules

1. **One mobile interface.** `RemoteApp.svelte` renders the session list and conversation. The HTML shell contains no conversation data. Session windows, folded bodies, images, and runtime state have separate HTTP responsibilities; there is no workspace, export, or alternate interface mode.
2. **Native Pi owns execution and names.** `pi-title-glyphs` owns automatic naming; the browser displays native names. Active controls go to the authenticated in-process `pi-remote` owner. Only explicit continue/new-session actions may create a background RPC worker.
3. **One worker per session.** Reused; crashed = evicted + replaced; idle reaped after 10 min.
4. **Icons:** Lucide only, via `web/src/shared/icons.js` — no hand-drawn SVG or unicode glyphs.
5. **i18n:** user-facing strings go through `t()` from `web/src/shared/i18n.js`. Edit **only** `web/src/shared/locales/en.js` — it is the source of truth; add/change keys there. Never hand-write the other locale files (`de.js`, `es.js`, …); they are machine-drafted by translating `en.js` via `pi`, the same English-source-only approach as the localized docs (see [Localized docs](#localized-docs)). Session content is never translated.
6. **Default port `31415`.** State: `~/.pi/agent/pi-web/pi-web-state.json`. SSE topics: `__all__` for index-wide, session ID per-session.
7. **Never start pi-web yourself** (`make dev`, `./pi-web`, etc.). The user runs it. Build/test with `make build` / `make test` / `make check`, but leave running the server to the user.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## Agent skills

### Issue tracker

Issues, specs, maps, and implementation tickets live in this fork's GitHub Issues. Read `docs/agents/issue-tracker.md` before tracker operations.

### Triage labels

Use the five default triage roles. Read `docs/agents/triage-labels.md` before triaging or changing triage labels.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`, created only when needed. Read `docs/agents/domain.md` before domain exploration or modeling.
