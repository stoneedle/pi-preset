# Core data flow

## Open a conversation

1. Go serves the embedded HTML shell and hashed JavaScript/CSS, without JSONL bootstrap data.
2. The browser requests a recent `/api/session` window plus runtime status. The session cache resolves the native file; `MessageWindow` follows the active parent chain.
3. The response includes whole ordinary text and folded descriptors. Expanding a descriptor requests only that tool/thinking body; opening an image requests only that image.
4. A `before` cursor prepends history while retaining the existing viewport anchor. Native reply IDs own unread identity; clicking a session clears its marker independently of scroll position.

## Receive changes

Native Pi remains the conversation writer. The content watcher debounces writes and discovers files in new project directories, including files created before the directory watch was attached. Its first observed version can invalidate an already-open page.

SSE carries reload hints and validated status, not complete conversation data. The browser's single-flight coordinator coalesces bursts and requests changes after its last cursor. Stable-ID merging updates existing tool cards. A changed branch produces a reset rather than mixing histories.

Runtime state comes separately from the native heartbeat publisher. Status expiry is checked even without file writes. Lost browser connections display unknown immediately. Native owner credentials and heartbeat reads must not obstruct publisher cleanup on Windows; native publication retries transient sharing conflicts rather than terminating Pi.

## Send a message

1. Auth checks the browser request and bounds text/image input.
2. Go resolves the native session and checks its authenticated in-process owner.
3. The owner verifies bearer token and native session identity, then calls Pi's public message API with native `steer`/`followUp` delivery. The browser receives an accepted receipt, not a processing claim.
4. Native Pi executes and persists its own entries. Normal content invalidation brings the result back to the browser.

Without a connected owner, browsing stays passive. Only new-session or explicit inactive-session continuation may create a background RPC worker; live terminal/owner registration prevents a second executor. There is no server-owned message queue, fabricated transcript, or external-message refresh path.

The API route inventory and execution boundaries live in [backend](backend.md); browser ownership lives in [frontend](frontend.md).
