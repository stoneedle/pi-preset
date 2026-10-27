# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — stoneedle fork

### Changed

- Save one initial first-input name instead of retitling on later questions.
- Use native saved names consistently in terminal and browser views.
- Preserve complete Unicode graphemes in names and status badges.
- Restore resting state when an idle dialog closes.

### Added

- Optional direct background model summary, including GPT-6 Luna.
- Persistent manual rename priority and stale-result rejection using native metadata revisions.
- Authenticated per-session loopback naming ownership shared with pi-web.
- Exact Pi 1.0.4 host repair so extension titles survive default host updates.
- Native persistence, host lifecycle and cross-fork HTTP integration regressions.

## Earlier stoneedle fork changes

### Changed

- Title text stays on the latest user request throughout tools, dialogs and completion.
- Provider icons are omitted; the project directory name is opt-in.
- External badges add only a glyph, keeping the request visible.
- The fork uses Pi 1.0.4's typed title and terminal input APIs.

### Added

- Background-completion unread glyph, cleared by terminal focus or user input.
- Prompt restoration from the active branch on reload, resume and tree navigation.
- Terminal focus observation with listener cleanup on shutdown.

## 0.2.0 — 2026-09-23

### Changed

- The project (cwd) name is now shown in the title **by default** — after the state
  glyph, before the content segment — so a row of tabs is readable at a glance.
  `PI_TITLE_GLYPHS_CWD=0` (or `off`/`no`/`false`) restores the old no-cwd title.
  Legacy opt-in values (`1`/`on`/`true`) are accepted unchanged.
- The title now re-asserts itself after the moments pi core rewrites it with its own
  `Pi - <session> - <cwd>` — the session bind at startup/resume, `/reload`, and session
  naming (which lands right after the first settle). Previously the core title stuck
  until the next agent event, so idle tabs appeared to run without the extension.

### Added

- `session_info_changed` and `session_shutdown` handlers: the former triggers the
  re-assertion after a rename; the latter clears a pending re-assertion timer so a
  reloaded session never renders with stale state. The timer is unref'd and one-shot.

Verified on pi 0.87.1: extension loads with zero errors (SDK probe) and
`tool_execution_start` events arrive with full args (print-mode probe run).

## 0.1.1 — 2026-09-13

No code changes. Republish to force an npm search-index re-entry: 0.1.0 was
published during an npm search index gap (`searchScore: 0` — findable by
maintainer query, absent from the `keywords:pi-package` feed), which left it
out of the pi.dev/packages gallery. A fresh publish event triggers reindexing;
equivalent reports: earendil-works/pi issues #6991, #7849, #7987, #8830.

## 0.1.0 — 2026-09-11

Initial public release. Verified on pi 0.85.1, macOS + Ghostty, node 26.

### Added

- Event-driven terminal/tab title: provider glyph + `⏳` working / `❗ NEEDS YOU` /
  `✓` resting, plus the live tool intent or your last prompt.
- Provider emoji map for common providers, with `PI_TITLE_GLYPHS_EMOJI_<PROVIDER>`
  overrides for self-hosted and custom endpoints.
- Optional project (cwd) name in the title via `PI_TITLE_GLYPHS_CWD=1`.
- **External status badge**: any other extension can push one glyph + label into the
  title by writing `{ emoji, label, expiresAt }` to a per-session JSON file
  (`status-<pid>.json`, so one session's badge never appears in another's title).
  See the README.
