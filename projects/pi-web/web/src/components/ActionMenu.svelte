<script>
  import { onMount, tick } from 'svelte';

  let { label, children, dismissTargets = '' } = $props();
  let panel;
  let anchor;
  let expandAnchor = true;
  let menuPress = false;

  function position() {
    if (!anchor?.isConnected || !panel.matches(':popover-open')) return;
    const row = anchor.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 12;
    const top = (viewport?.offsetTop || 0) + 12;
    const right = left + (viewport?.width || window.innerWidth) - 24;
    const bottom = top + (viewport?.height || window.innerHeight) - 24;
    const below = row.bottom + 6;
    const above = below + box.height > bottom;
    panel.style.left = `${Math.max(left, Math.min(row.left, right - box.width))}px`;
    panel.style.top = `${Math.max(top, Math.min(above ? row.top - box.height - 6 : below, bottom - box.height))}px`;
    panel.style.transformOrigin = above ? 'bottom left' : 'top left';
  }
  function unhighlight() {
    anchor?.classList.remove('remote-menu-active');
    if (expandAnchor) anchor?.removeAttribute('aria-expanded');
  }
  export function isOpenFor(source) {
    return anchor === source && panel.matches(':popover-open');
  }
  export async function open(source, expand = true) {
    panel.hidePopover();
    unhighlight();
    anchor = source;
    expandAnchor = expand;
    menuPress = false;
    await tick();
    if (!anchor?.isConnected) return;
    panel.showPopover();
    position();
    anchor.classList.add('remote-menu-active');
    if (expandAnchor) anchor.setAttribute('aria-expanded', 'true');
    panel.querySelector('button')?.focus({ preventScroll: true });
  }
  export function close(restoreFocus = false) {
    panel.hidePopover();
    if (restoreFocus) anchor?.focus({ preventScroll: true });
  }
  function keydown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(true);
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...panel.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }
  }
  onMount(() => {
    const dismiss = (event) => {
      // Scrolling an input inside a row is not scrolling the containing list.
      if (event.target instanceof Node && event.target.contains(anchor)) close();
    };
    let dismissingRow = false;
    const outside = (event) => {
      dismissingRow = false;
      if (panel.matches(':popover-open') && !panel.contains(event.target)) {
        dismissingRow = Boolean(dismissTargets && event.target.closest(dismissTargets));
        close();
        if (dismissingRow) event.stopPropagation();
      }
    };
    const consumeDismissal = (event) => {
      if (!dismissingRow) return;
      dismissingRow = false;
      if (event.detail) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const escape = (event) => {
      if (event.key === 'Escape' && panel.matches(':popover-open')) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('click', consumeDismissal, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      unhighlight();
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('click', consumeDismissal, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  });
</script>

<div
  bind:this={panel}
  class="session-actions"
  popover="manual"
  role="menu"
  aria-label={label}
  tabindex="-1"
  onkeydown={keydown}
  onbeforetoggle={(event) => {
    if (event.newState === 'closed') unhighlight();
  }}
  onpointerdowncapture={() => {
    menuPress = true;
  }}
  onclickcapture={(event) => {
    // Releasing a long press must not activate a newly opened menu.
    if (event.detail && !menuPress) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    menuPress = false;
  }}
>
  {@render children()}
</div>

<style>
  .session-actions {
    position: fixed;
    inset: auto;
    width: min(224px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    margin: 0;
    padding: 6px;
    overflow: auto;
    border: 1px solid var(--dim);
    border-radius: 16px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--popover-shadow);
  }
  .session-actions:popover-open {
    animation: menu-in 140ms var(--ease-out);
  }
  .session-actions :global(.action) {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    text-align: left;
    white-space: nowrap;
    border: 0;
    border-radius: 10px;
    background: transparent;
    font-size: 14px;
  }
  .session-actions :global(.action:hover),
  .session-actions :global(.action:focus-visible) {
    background: var(--surface-2);
  }
  .session-actions :global(p) {
    margin: 8px;
    color: var(--danger);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .session-actions:popover-open {
      animation: none;
    }
  }
</style>
