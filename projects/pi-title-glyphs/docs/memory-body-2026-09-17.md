<!-- Moved out of the pi memory store 2026-09-17 (defrag item 13). Not in package.json `files` (src/README/CHANGELOG/LICENSE/package.json only) - never published.
     Pre-defrag store copy: git -C ~/.pi/agent/memory show 70c07a9:pi-title-glyphs.md -->

# pi-title-glyphs — live session status in the terminal/tab title

**state + procedural** — was `pi-glance` (local, unpublished). Renamed, generalized and
released as a package 2026-09-11; this file replaces `pi-glance.md`.

## What / where

- **Home of record: `~/dev/pi-title-glyphs`** (git, one commit, tagged `v0.1.0`).
  Installed via `pi install` → settings `packages: ["../../dev/pi-title-glyphs"]`.
  `src/index.ts` (pi event wiring, 154 lines) + `src/format.ts` (formatting, provider map,
  badge reader — imports nothing from pi, 182 lines) + `test/format.test.ts` (11 tests,
  zero dependencies: `npm test`).
- **The old `~/.pi/agent/extensions/pi-glance/` is retired** to
  `~/.pi/agent/backups/retired/pi-glance-retired-20260911-153351`. Do not resurrect it;
  anything reading that path is stale.
- Renders a compact, always-current **window/tab title** so many pi tabs can be scanned:
  `🫎 ⏳ · <live tool intent>` (working), `🐶 ❗ NEEDS YOU · confirm: …` (blocked),
  `🦉 ✓ · <your last prompt>` (resting). The `🫎`/`🔓`-prefixed titles on moose sessions
  are this extension — the "own window hazard" in the mac-desktop playbook is its output.
- Sets the title through **`ctx.ui.setTitle`**, not OSC escapes — pi owns that surface, so
  the extension has no terminal or OS coupling at all. (`setTitle` is not in pi's published
  type surface; it is called defensively.)

## States (event-driven, no heuristics)

- working (`agent_start` → tool executions → `ui_prompt_end`), needs-you
  (`ui_prompt_start` confirm/select/input dialogs), resting (`agent_settled`).
- needs-you outranks any badge — a blocked human is the most urgent thing.
- Tool verbiage: prefers `args.displaySummary` (pi-tool-display-intent or any extension
  using that field), then per-tool fallbacks (bash command, path, query, subagent name).
  Pure string truncation — **no LLM calls, ever**.

## Config (env, optional)

- `PI_TITLE_GLYPHS_EMOJI_<PROVIDER>` — glyph override. Uppercase the provider,non-alphanumerics
  become `_` (`llama-swap` → `..._LLAMA_SWAP`). **The five fleet glyphs live in `~/.zshrc`**
  (moose 🫎 · woof 🐶 · bear 🐻 · owl 🦉 · flashnext ⚡) because the published map only
  covers public providers — new shells only; a pi tab started from an older shell shows 🤖.
- `PI_TITLE_GLYPHS_CWD=1` — include the project (cwd) name.
- `PI_TITLE_GLYPHS_STATUS_FILE` — override the badge path.
- Built-in map: public providers only (anthropic, openai, google/gemini, xai/grok,
  deepseek, mistral, groq, openrouter, ollama, llamacpp/llama-swap, lmstudio, vllm, local);
  anything else 🤖.

## The external badge contract (replaces the old nodegate reader)

The old `queueState()` read nodegate's private on-disk queue layout (slot files, the queue
array, `busy-<pid>.json` field names). **Gone.** This extension now reads one file:

```
<agent-dir>/extension-data/pi-title-glyphs/status-<pid>.json
{ "emoji": "🔓", "label": "HOLDING", "expiresAt": <epoch ms> }
```

- **Per-pid on purpose** — badge state ("you are #2 in line") belongs to one session; a
  shared file would show one tab's queue position in every other tab. That bug was caught
  pre-publish.
- Absent / unreadable / malformed / expired ⇒ no badge. Glyph ≤8 chars, label ≤60, newlines
  flattened, so a writer cannot eat the title. This extension never creates or writes it.
- **nodegate is the writer** (`8f5d11f`): `writeBadge`/`clearBadge` via `atomicWriteJson`
  from `renderStatus`, the stolen one-shot, and `clearUi`; 10-min TTL. Contract test:
  `nodegate/test/10-badge.mjs`.
- **Both halves are needed:** nodegate must still set the title *directly* while waiting or
  holding, because a queued session gets no pi events to trigger a render. The badge is what
  keeps the glyph alive across this extension's own later renders.
- Anything can write it — a CI watcher, a long job, a "needs a human" signaller. The
  extension knows nothing about who does.

## Cross-plugin notes

- **pi-tool-display-intent**: writes `args.displaySummary`, this one's preferred verbiage
  source. Designed to pair.
- **pi-panes**: ownership split — **this extension owns the window/tab title (external),
  pi-panes owns in-TUI bars.** pi-panes' goal-in-title idea should feed the badge contract,
  not become a second title writer.
- **Registers no tools and no commands**, so it can never fail to load over a tool-name
  conflict (unlike renderer-class extensions).
- `emojiFor` in nodegate also reads `PI_TITLE_GLYPHS_EMOJI_<PROVIDER>` — one source of
  truth for glyphs across both.

## Public status

**PUBLISHED 2026-09-11 (Crow go).** `github.com/t0mj/pi-title-glyphs` is public: one
commit `8a668c9` (AI-trace-free message, noreply identity), tag `v0.1.0`, GitHub release
created, description + topics set. Verified from the public side: fresh shallow clone of
the tag is leak-battery-clean (0 AI traces, 0 private vocab, 0 real paths/emails) and
`pi install git:github.com/t0mj/pi-title-glyphs@v0.1.0` works in a throwaway
`PI_CODING_AGENT_DIR` (load check = only the model-not-found line).

**npm: PUBLISHED 2026-09-12 (00:34 local) — `pi-title-glyphs@0.1.0`, maintainer t0mj.**
Crow ran the publish in his own terminal after enabling 2FA (path (a) below). Verified
from the public side: the published tarball is **byte-identical to committed
`8a668c9`** (all 6 files diffed after `npm pack` — the guardrail below paid off: a
stray prettier reformat of `src/index.ts` had sat in the tree earlier, disclosed +
restored before the publish window), stranger
`PI_CODING_AGENT_DIR=$(mktemp -d) pi install npm:pi-title-glyphs` + load check
(only the deliberately fake model name errors), `pi-package` keyword present.
**The gallery listing did NOT follow** — root cause + fix below.

**The 2FA lesson (persistent, any future npm publish from this Mac):** with 2FA on,
`npm publish` emits a browser EOTP URL with a ~5-min expiry — a non-interactive
shell (agent bash, PTY tricks) always loses that race (hit the expiry twice this
session). Winning paths: (a) the user runs `npm publish` in a real terminal
(browser opens itself); (b) the user sets a granular access token with **Bypass
2FA** checked (Read+write, package-scoped, short expiry) via `npm config set
//registry.npmjs.org/:_authToken <token>` (token never enters agent context) —
then the agent may run the publish. Always verify the working tree matches the
tagged commit first: the npm tarball packs the working tree.

**Gallery listing — root cause + fix (2026-09-13, 0.1.1 shipped):** 0.1.0 (published
2026-09-12) never appeared at https://pi.dev/packages. Not a metadata problem — the exact
`pi-package` keyword, the `pi` manifest, stranger install, and the direct page
(`pi.dev/packages/pi-title-glyphs`, 200, README renders) were all verified good. Root cause:
the gallery's membership list is built from npm's **search-index feed** (`keywords:pi-package`);
our package fell into an npm indexing gap — `searchScore: 0` (findable by maintainer query,
absent from the keyword feed; verified by scanning the feed's full ~9,780 results). Known
failure mode: pi tracker #6991 / #7849 / #7987 / #8830 (all auto-closed, no maintainer
answer). **Fix = publish a new version**: a fresh publish forces re-indexing (pi-wecom-notify
controlled experiment: ~2.5 h to appear, after 2 days invisible; every previously-affected
package in those issues is now listed, and each had republished — ours was the only one that
hadn't). **0.1.1 published 2026-09-13 17:24 PDT (Crow's terminal)** — metadata touch only;
`src/` byte-identical to v0.1.0; tarball (6 files) byte-verified against commit `faf5a0f`.
README gained a headers screenshot: `img/headers.png` in the repo, referenced by **absolute
GitHub raw URL** (npm/pi.dev renderers don't serve relative README assets; image deliberately
not in the `files` tarball). **Open:** confirm the listing — `curl "https://pi.dev/packages?name=pi-title-glyphs"`
→ `packages-count\">1-1 / 1` (the in-page filter is client-side over 50 cards; the count line
is the truth). If still `0 /` after ~24 h, that is a new signal, not the known gap.

**Publish 404 signature (persistent):** `npm publish` → **404 on the PUT of an existing
package** + `npm whoami` → **401** = no valid credentials (the publish-window token is
dead) — npm hides the package from non-maintainers rather than saying "wrong user". It is
not a package or registry problem; re-auth (`npm login` browser 2FA, or fresh token) and
retry. Hit 2026-09-13: the 0.1.0-window token was dead (404 at 17:19), Crow re-authed,
0.1.1 landed 17:24.

Provenance: leak-reviewed via the allowlist prompt (the leak was `RELEASE.md`
itself — sanitized in place; also fixed a dead `pi-tool-display-intent` link → real
package `@zhcsyncer/pi-tool-display-intent` on npm, and one stale `status.json`
comment); history reset to one scrubbed commit; the Claude `Co-Authored-By` trailer was
removed from the commit per Crow 2026-09-11 (he distrusts unsigned-for-him AI trailers).
Release record: `~/dev/pi-title-glyphs/RELEASE.md`; method: skill `pi-package-publish`.
Owl provider mapping (folded from owlpi on-box notes, 2026-09-12): `owl` provider → 🦉 in PROVIDER_EMOJI (`pi-ext/pi-title-glyphs/src/format.ts`); env override `PI_TITLE_GLYPHS_EMOJI_OWL=🦉` works without restart. On-box pi on owl shows 🦉 titles per session.

Vocabulary validation (mechanism study 2026-09-12, `~/dev/pi-panes/research/mechanism-study-2026-09-12.md`): the working/needs-you/resting triad got independent convergence from three copyleft/MIT managers — cmux's derived fold `running/needsInput/idle` (error folded into needs-input), vibe-kanban's derived `idle|running|pending_approval|failed` ladder, and Claude Code agent-teams *verified docs* `working/failed/idle` (idle collapses after 30 s, failed rows never). No competitor shows per-tool timestamps in transcripts (CC's Ctrl+O verbose view is the closest) — pi-panes P3 stub timing is ahead of every studied surface. One-glyph-per-state with subtype in tooltip, not three needs-you glyphs (ccmux's 4 waiting subtypes converge to one badge + color).
