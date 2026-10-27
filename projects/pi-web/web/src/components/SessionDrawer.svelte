<script>
  import { flushSync, onMount, untrack } from 'svelte';
  import { icon, Search, SquarePen, X, Archive, ArrowLeft, Bell } from '../shared/icons.js';
  import SessionList from './SessionList.svelte';
  import { contextMenu } from '../shared/context-menu.js';

  let {
    surface,
    currentSessionId,
    canSwipe = () => true,
    onnew,
    onclose,
    isOpen = $bindable(false),
  } = $props();
  let dialog;
  let list;
  let archived = $state(false);
  let activeOnly = $state(false);
  let queries = $state({ active: '', archived: '' });
  const query = $derived(queries[archived ? 'archived' : 'active']);
  let searchOpen = $state(false);
  let searchInput = $state(null);
  let gesture;
  let finishTimer;
  let tracking = false;
  const duration = 200;

  function focusSearch() {
    // Keep focus in the trusted click so mobile browsers can open the keyboard.
    flushSync(() => (searchOpen = true));
    searchInput.focus({ preventScroll: true });
    searchInput.setSelectionRange(query.length, query.length);
  }

  $effect(() => {
    currentSessionId;
    untrack(() => {
      if (dialog?.open) finishClose();
    });
  });

  function stopSettling() {
    clearTimeout(finishTimer);
    finishTimer = undefined;
  }

  function position(offset) {
    const width = dialog.offsetWidth;
    const x = Math.max(-width, Math.min(0, offset));
    dialog.style.setProperty('--drawer-offset', `${x}px`);
    dialog.style.setProperty('--drawer-dim', String(0.5 * (1 + x / width)));
  }

  function show() {
    if (dialog.open) return;
    archived = false;
    dialog.classList.add('tracking');
    dialog.style.setProperty('--drawer-offset', '-100%');
    dialog.style.setProperty('--drawer-dim', '0');
    dialog.showModal();
    isOpen = true;
    position(-dialog.offsetWidth);
  }

  function settle(open) {
    stopSettling();
    tracking = false;
    // Flush the current drag position before enabling the settling transition.
    const from = dialog.getBoundingClientRect().left;
    dialog.classList.remove('tracking');
    position(open ? 0 : -dialog.offsetWidth);
    if (!open) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced || from <= -dialog.offsetWidth) finishClose();
      else finishTimer = setTimeout(finishClose, duration);
    }
  }

  export function open() {
    show();
    settle(true);
  }

  export function close() {
    if (!dialog.open) return;
    gesture = null;
    settle(false);
  }

  function finishClose() {
    dialog.close();
    // Reset list activation before another gesture can reopen the modal.
    closed();
  }

  function closed() {
    // Native close events are queued; a new gesture may already have reopened the dialog.
    if (dialog.open || !isOpen) return;
    stopSettling();
    gesture = null;
    tracking = false;
    isOpen = false;
    if (!query) searchOpen = false;
    onclose?.();
  }

  function keydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input, a[href]')].filter(
      (node) => node.getClientRects().length,
    );
    const index = controls.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (index - 1 + controls.length) % controls.length
      : (index + 1) % controls.length;
    event.preventDefault();
    controls[next]?.focus();
  }

  onMount(() => {
    const cancel = () => {
      if (tracking) settle(!gesture.opening);
      gesture = null;
    };
    const scrollsHorizontally = (target, dx) => {
      for (
        let node = target;
        node && node !== surface && node !== dialog;
        node = node.parentElement
      ) {
        if (node.scrollWidth <= node.clientWidth + 1) continue;
        const overflow = getComputedStyle(node).overflowX;
        if (overflow !== 'auto' && overflow !== 'scroll') continue;
        if (
          dx > 0 ? node.scrollLeft > 1 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1
        )
          return true;
      }
      return false;
    };
    const start = (event) => {
      cancel();
      const opening = !dialog.open;
      const target = event.target;
      if (
        event.touches.length !== 1 ||
        window.getSelection()?.isCollapsed === false ||
        (opening && (!surface?.contains(target) || !canSwipe())) ||
        (!opening &&
          target !== dialog &&
          (!dialog.contains(target) || target.closest('dialog') !== dialog)) ||
        document.querySelector('dialog[open]') !== (opening ? null : dialog) ||
        document.querySelector(':popover-open') ||
        target.closest('input, textarea, select, [contenteditable]')
      )
        return;
      const touch = event.touches[0];
      gesture = {
        id: touch.identifier,
        target,
        x: touch.clientX,
        y: touch.clientY,
        opening,
        lastX: touch.clientX,
        lastAt: performance.now(),
        velocity: 0,
      };
    };
    const move = (event) => {
      if (!gesture) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch.identifier !== gesture.id) return cancel();
      const dx = touch.clientX - gesture.x;
      const dy = Math.abs(touch.clientY - gesture.y);
      if (!tracking) {
        // Keep watching hesitant starts; a diagonal swipe need not be nearly horizontal.
        if (Math.abs(dx) < 12 || Math.abs(dx) < dy * 0.5) return;
        if (!event.cancelable || scrollsHorizontally(gesture.target, dx)) return cancel();
        // Reserve the swipe even if it starts backwards, so the browser cannot take it away.
        event.preventDefault();
        if (gesture.opening ? dx <= 0 : dx >= 0) return;
        stopSettling();
        if (gesture.opening) show();
        gesture.offset = dialog.getBoundingClientRect().left;
        dialog.classList.add('tracking');
        tracking = true;
      }
      const now = performance.now();
      if (now > gesture.lastAt)
        gesture.velocity = (touch.clientX - gesture.lastX) / (now - gesture.lastAt);
      gesture.lastX = touch.clientX;
      gesture.lastAt = now;
      position(gesture.offset + dx);
      if (event.cancelable) event.preventDefault();
    };
    const end = (event) => {
      if (!gesture) return;
      const touch = event.changedTouches[0];
      if (!tracking || touch?.identifier !== gesture.id || event.touches.length) return cancel();
      const distance = (touch.clientX - gesture.x) * (gesture.opening ? 1 : -1);
      const velocity =
        performance.now() - gesture.lastAt < 100
          ? gesture.velocity * (gesture.opening ? 1 : -1)
          : 0;
      const commit = distance >= 32 || (distance >= 16 && velocity > 0.35);
      const open = commit ? gesture.opening : !gesture.opening;
      gesture = null;
      if (event.cancelable) event.preventDefault();
      settle(open);
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end, { passive: false });
    window.addEventListener('touchcancel', cancel);
    return () => {
      stopSettling();
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', cancel);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  id="remote-sessions-drawer"
  class="remote-drawer"
  aria-label="会话"
  aria-modal={isOpen}
  bind:this={dialog}
  onkeydown={keydown}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  onclose={closed}
>
  <header>
    {#if archived}
      <button type="button" aria-label="返回会话列表" onclick={() => (archived = false)}
        >{@html icon(ArrowLeft)}</button
      >
    {/if}
    <button
      type="button"
      aria-label="搜索会话"
      aria-expanded={searchOpen}
      aria-controls="remote-drawer-search"
      onclick={focusSearch}>{@html icon(Search)}</button
    >
    {#if searchOpen}
      <input
        id="remote-drawer-search"
        bind:this={searchInput}
        type="search"
        aria-label="搜索会话"
        placeholder={archived ? '搜索已归档会话' : '搜索会话'}
        autocomplete="off"
        enterkeyhint="search"
        bind:value={queries[archived ? 'archived' : 'active']}
      />
    {:else}
      <span class="remote-drawer-space">{archived ? '已归档' : ''}</span>
    {/if}
    {#if !archived}
      <button
        type="button"
        aria-label="只看活跃会话"
        aria-pressed={activeOnly}
        title="活跃会话：未读、进行中或待你处理"
        onclick={() => (activeOnly = !activeOnly)}>{@html icon(Bell)}</button
      >
      <button
        type="button"
        class="remote-archives"
        aria-label="已归档"
        title="已归档，长按归档所有断开会话"
        aria-haspopup="menu"
        use:contextMenu={(anchor) => list.openArchiveMenu(anchor)}
        onclick={() => (archived = true)}>{@html icon(Archive)}</button
      >
    {/if}
    <button
      type="button"
      aria-label="新建会话"
      onclick={() => {
        close();
        onnew();
      }}>{@html icon(SquarePen)}</button
    >
    <button type="button" aria-label="关闭会话列表" onclick={close}>{@html icon(X)}</button>
  </header>
  <SessionList
    bind:this={list}
    bind:query={queries[archived ? 'archived' : 'active']}
    bind:archived
    {activeOnly}
    lazy
    showSearch={false}
    {currentSessionId}
    active={isOpen}
    onselect={close}
    onnew={(path) => {
      close();
      onnew(path);
    }}
  />
  <footer><a href="/">查看全部会话</a></footer>
</dialog>

<style>
  .remote-drawer {
    position: fixed;
    inset: 0 auto auto 0;
    width: 100vw;
    max-width: none;
    height: var(--remote-height, 100dvh);
    max-height: var(--remote-height, 100dvh);
    margin: 0;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    overflow: hidden;
    color: var(--text);
    background: var(--surface);
    border: 0;
    border-radius: 0;
    transform: translate3d(var(--drawer-offset, -100%), 0, 0);
    transition: transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .remote-drawer[open] {
    display: flex;
    flex-direction: column;
  }
  .remote-drawer::backdrop {
    background: rgb(0 0 0 / var(--drawer-dim, 0));
    transition: background-color 200ms ease-out;
  }
  .remote-drawer:global(.tracking),
  .remote-drawer:global(.tracking)::backdrop {
    transition: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 8px 12px;
    flex: none;
  }
  header button {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-soft);
  }
  header button:hover {
    background: var(--surface-2);
  }
  header button[aria-pressed='true'] {
    color: var(--accent);
    background: var(--surface-2);
  }
  header input,
  .remote-drawer-space {
    flex: 1;
    min-width: 0;
  }
  header input {
    width: 0;
    height: 44px;
    padding: 8px 10px;
    border: 0;
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 16px;
  }
  header input::placeholder {
    color: var(--muted);
  }
  footer {
    padding: 8px 12px max(8px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--dim);
    flex: none;
  }
  footer a {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    text-decoration: none;
    font-size: 13px;
  }
  @media (prefers-reduced-motion: reduce) {
    .remote-drawer,
    .remote-drawer::backdrop {
      transition: none;
    }
  }
</style>
