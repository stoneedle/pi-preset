# pi-web user guide

pi-web lets you read and reply to your native Pi sessions from a phone. Your machine keeps executing the work; Tailscale provides the existing private HTTPS connection.

[Install and connect](install.md) for setup, authentication, extension updates, and service management.

## Daily use

1. Open the session list and choose a conversation. Clicking clears its unread reply marker.
2. Read recent messages. Expand tools, thinking, or images only when needed; load older history without losing your place.
3. Reply with text or a picture. Choose native steer/follow-up delivery; selecting a skill suggestion only fills the draft.
4. Inspect compact session information or change the next request's model/thinking. Stop the main agent explicitly if needed.

Runtime state comes from native Pi. Running, background activity, terminal attention, and idle are distinct. Missing/stale evidence and network loss show unknown. Accepted messages are not automatically reported as processed. Native terminal dialogs remain on the computer.

Opening history does not create an executor. Explicit background continuation is available only when it will not compete with a registered live terminal. Existing sessions, saved appearance, cookies, and Tailscale addresses stay in place.

The interface intentionally has no workspace sidebars, schedules, scratchpads, reviews, share/export, notification setup, or browser-managed message queue.
