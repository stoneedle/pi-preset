<script>
  import { contextMenu } from '../shared/context-menu.js';
  import SessionStatus from './SessionStatus.svelte';

  let {
    session,
    currentSessionId = '',
    connected = false,
    history = false,
    onselect,
    onmenu,
  } = $props();
</script>

<div class="remote-session-row" class:remote-history-row={history} data-session-id={session.id}>
  <a
    class="remote-session"
    class:remote-current={session.id === currentSessionId}
    href={`/session?id=${encodeURIComponent(session.id)}`}
    aria-current={session.id === currentSessionId ? 'page' : undefined}
    aria-haspopup="menu"
    use:contextMenu={(anchor) => onmenu?.(session, anchor)}
    onclick={(event) => onselect?.(event, session)}
  >
    <div>
      <strong title={session.name}>{session.name}</strong>
    </div>
    <SessionStatus snapshot={session} {connected} />
  </a>
</div>

<style>
  .remote-session-row {
    display: flex;
    align-items: center;
    min-width: 0;
    border-radius: 12px;
  }
  .remote-session {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 10px;
    border: 0;
    border-radius: 12px;
    color: inherit;
    text-decoration: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  .remote-session:hover,
  .remote-current,
  .remote-session:global(.remote-menu-active) {
    background: var(--surface-2);
  }
  .remote-session > div {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
  }
  strong {
    display: block;
    min-width: 0;
    font-size: 14px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remote-history-row .remote-session {
    color: var(--text-soft);
  }
  .remote-history-row strong {
    font-size: 13px;
  }
</style>
