<script>
  import { sessionPresentation } from '../../../shared/session-presentation.js';
  import {
    icon,
    Circle,
    CircleHelp,
    CircleX,
    CircleAlert,
    Check,
    Square,
    Unplug,
    LoaderCircle,
    Layers,
    WifiOff,
  } from '../shared/icons.js';

  let { snapshot = {}, connected = true } = $props();
  const glyphs = {
    Circle,
    CircleHelp,
    CircleX,
    CircleAlert,
    Check,
    Square,
    Unplug,
    LoaderCircle,
    Layers,
    WifiOff,
  };
  const visual = $derived(sessionPresentation(snapshot, connected));
  const label = $derived([visual.label, visual.unread?.label].filter(Boolean).join('，'));
</script>

<span
  class="remote-state"
  data-state={connected ? snapshot.state : 'unknown'}
  data-visual={visual.kind}
  data-tone={visual.tone}
  role="img"
  aria-label={label}
  title={label}
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
  {@html icon(glyphs[visual.icon], { size: 18 })}
  {#if visual.unread}<span class="remote-unread" aria-hidden="true"></span>{/if}
</span>

<style>
  .remote-state {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 20px;
    height: 20px;
    color: var(--muted);
  }
  .remote-state[data-tone='accent'] {
    color: var(--accent);
  }
  .remote-state[data-tone='warning'] {
    color: var(--warning);
  }
  .remote-state[data-tone='error'] {
    color: var(--danger);
  }
  .remote-state[data-tone='success'] {
    color: var(--text-soft);
  }
  .remote-unread {
    position: absolute;
    top: -1px;
    right: -1px;
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
  }
  .remote-state[data-visual='running'] :global(svg) {
    animation: status-spin 1.2s linear infinite;
  }
  @keyframes status-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .remote-state[data-visual='running'] :global(svg) {
      animation: none;
    }
  }
</style>
