# Frontend

## One interface

`web/src/main.js` loads the selected locale and mounts `App.svelte`, which renders `routes/RemoteApp.svelte`. `/` shows the session list and `/session?id=...` shows a conversation. Both use the same responsive layout; there are no workspace sidebars, settings routes, export renderer, or alternate desktop mode.

Go emits `internal/ui/embedded/app.html` with links from the Vite manifest. Conversation data is never embedded in HTML. JavaScript and CSS use content-hashed `/static/` URLs and correct MIME types. Only the selected language is loaded. English strings live in `shared/locales/en.js`; generate translations with `python scripts/build_locales.py <language>`.

## Conversation and transport

`RemoteApp.svelte` owns the selected conversation and viewport. `remote-api.js` owns HTTP errors, single-flight refresh coordination, stable-ID message merging, and browser-local unread persistence.

- The initial API response is a recent message window. Ordinary user/assistant text stays complete, including long replies.
- `RemoteBlock.svelte` fetches a tool/thinking body when expanded. Images use their own authenticated endpoint and are not automatically loaded with history.
- Older messages prepend using a `before` cursor. The viewport retains its existing message anchor.
- Live updates use an `after` cursor. Changed tool cards replace their existing stable-ID message rather than duplicating it.
- Repeated invalidations coalesce behind one active refresh. Failed requests leave the current conversation available with a retry action.

Markdown escapes raw HTML, allows only explicit web/mail/local links, and renders Markdown images as links instead of fetching them. Tool output remains escaped preformatted text.

## Runtime state and controls

EventSource subscribes to a session ID or `__all__`. Named `status-snapshot` events contain an ID-to-state map; `status-delta` contains `{id,state}`. `reload` and `new-session` trigger coordinated API refreshes. Disconnects display unknown on both the list and conversation rather than retaining a trustworthy-looking idle state.

Controls use the selected session's existing owner. An unattached history session offers explicit background continuation; browsing does not attach a new worker. The composer sends text/images and Pi-native `steer` or `followUp` delivery. Skill suggestions insert into the draft and never execute on selection. A transport receipt means accepted, not confirmed processed.

Session information exposes project, branch, cache-hit ratio, context, Fast availability, model, and thinking. Unavailable runtime measurements remain unknown. Model/thinking changes affect subsequent requests. Native terminal dialogs remain in the terminal.

Clicking a list entry clears its unread marker immediately. This does not depend on scrolling to the last message or observing a particular message on screen. Saved theme/font/language preferences remain readable without a settings workspace. The viewport tracks the mobile visual viewport so the composer stays usable with the software keyboard.

The service worker does not cache session data or implement notifications. Device-emulated E2E tests exercise the actual production bundle at its configured viewport; see [E2E testing](../dev/e2e-testing.md).
