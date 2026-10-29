<script>
  import { onMount, onDestroy, flushSync } from 'svelte';
  import { icon, Plus, ArrowUp, Square, LoaderCircle, Layers } from '../shared/icons.js';
  import ModelPicker from './ModelPicker.svelte';
  import ComposerCommands from './ComposerCommands.svelte';
  import SubmissionRecovery from './SubmissionRecovery.svelte';
  import QueuedMessages from './QueuedMessages.svelte';
  import DraftImage from './DraftImage.svelte';
  import { editDraft } from '../remote-drafts.svelte.js';

  let {
    composer,
    canSend = true,
    running = false,
    onsend,
    onstop,
    canQueue = false,
    onqueue,
    sessionId = '',
    commandsURL = '',
    catalogKey = '',
    onsessioninfo,
    oncompact,
    canCompact = false,
    onreload,
    canReload = false,
    reloading = false,
    queueStatus = {},
    queueAvailable = false,
    oninput,
    onfocus,
    onblur,
    onmodelopen,
    onmodel,
    onthinking,
    onspeed,
    models = [],
    status = {},
    modelsLoading = false,
    modelsError = '',
    textarea = $bindable(null),
    draftMode = false,
  } = $props();
  let sendButton;
  let queueMenu = $state(null);
  let press;
  let pressTimer;
  let suppressSend = false;
  let menuPress = false;
  let preserveEditor = false;
  function cancelPress() {
    clearTimeout(pressTimer);
    press = null;
  }
  function closeMenu() {
    queueMenu?.hidePopover();
  }
  function positionMenu() {
    if (!queueMenu?.matches(':popover-open')) return;
    const button = sendButton.getBoundingClientRect();
    const menu = queueMenu.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 12;
    const top = (viewport?.offsetTop || 0) + 12;
    const right = left + (viewport?.width || innerWidth) - 24;
    queueMenu.style.left = `${Math.max(left, Math.min(button.right - menu.width, right - menu.width))}px`;
    queueMenu.style.top = `${Math.max(top, button.top - menu.height - 8)}px`;
  }
  function openMenu(keyboard = false) {
    cancelPress();
    if (!canQueue || !queueMenu) return;
    suppressSend = true;
    menuPress = false;
    preserveEditor = !keyboard && document.activeElement === textarea;
    queueMenu.showPopover();
    positionMenu();
    if (!preserveEditor) queueMenu.querySelector('button')?.focus({ preventScroll: true });
  }
  function startPress(event) {
    cancelPress();
    suppressSend = false;
    if (document.activeElement === textarea) event.preventDefault();
    if (!canQueue || event.button !== 0 || !event.isPrimary) return;
    press = { x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => openMenu(), 500);
  }
  $effect(() => {
    if (!canQueue) closeMenu();
  });
  onMount(() => {
    if (!onqueue) return;
    const outside = (event) => {
      if (!queueMenu?.contains(event.target)) closeMenu();
    };
    const escape = (event) => {
      if (event.key === 'Escape' && queueMenu?.matches(':popover-open')) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        (preserveEditor ? textarea : sendButton)?.focus({ preventScroll: true });
      }
    };
    const scroll = (event) => {
      if (event.target instanceof Node && event.target.contains(sendButton)) closeMenu();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', positionMenu);
    window.visualViewport?.addEventListener('resize', positionMenu);
    window.visualViewport?.addEventListener('scroll', positionMenu);
    return () => {
      cancelPress();
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', positionMenu);
      window.visualViewport?.removeEventListener('resize', positionMenu);
      window.visualViewport?.removeEventListener('scroll', positionMenu);
    };
  });

  onDestroy(() => {
    composer.composing = false;
    composer.picking = false;
  });

  function grow(node) {
    const resize = () => {
      const scrollTop = node.scrollTop;
      const atEnd = node.selectionEnd === node.value.length;
      node.style.height = 'auto';
      node.style.height = node.scrollHeight + node.offsetHeight - node.clientHeight + 'px';
      node.scrollTop = atEnd ? node.scrollHeight : scrollTop;
    };
    let width;
    let frame;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(node);
    resize();
    return {
      update: resize,
      destroy() {
        cancelAnimationFrame(frame);
        observer.disconnect();
      },
    };
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<ComposerCommands
  {composer}
  url={commandsURL}
  {catalogKey}
  {onsessioninfo}
  {oncompact}
  {canCompact}
  {onreload}
  {canReload}
  {reloading}
  onselect={(position) => {
    flushSync();
    textarea?.focus({ preventScroll: true });
    textarea?.setSelectionRange(position, position);
  }}
/>
<div class="composer-region" class:recovering={composer.recoveries.length > 0}>
  <div class="composer-recoveries" aria-label="待处理的发送内容">
    {#if sessionId}
      <QueuedMessages
        {sessionId}
        {composer}
        status={queueStatus}
        available={queueAvailable}
        onedit={() => {
          flushSync();
          textarea?.focus({ preventScroll: true });
        }}
      />
    {/if}
    {#if composer.recoveries.length}
      {#each composer.recoveries as item (item.id)}
        <SubmissionRecovery
          {composer}
          {item}
          onedit={() => {
            flushSync();
            textarea?.focus({ preventScroll: true });
          }}
        />
      {/each}
    {/if}
  </div>
  <form class="composer-shell" onsubmit={onsend}>
    {#if composer.images.length}<div class="remote-images">
        {#each composer.images as image (image)}
          <DraftImage
            file={image}
            onremove={() => (composer.images = composer.images.filter((item) => item !== image))}
          />
        {/each}
      </div>{/if}
    <textarea
      bind:this={textarea}
      aria-label="给 Pi 发消息…"
      placeholder="给 Pi 发消息…"
      rows="1"
      bind:value={() => composer.text, (value) => editDraft(composer, value)}
      oncompositionstart={() => (composer.composing = true)}
      oncompositionend={() => (composer.composing = false)}
      use:grow={composer.text}
      {oninput}
      {onfocus}
      {onblur}
    ></textarea>
    <div class="remote-actions">
      <label class="remote-attach" aria-label="拍照或选择图片" title="添加图片">
        {@html icon(Plus, { size: 26 })}<input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          onclick={() => (composer.picking = true)}
          oncancel={() => (composer.picking = false)}
          onchange={(event) => {
            composer.images = [...composer.images, ...event.currentTarget.files];
            composer.picking = false;
            event.currentTarget.value = '';
          }}
        />
      </label>
      <div class="composer-model">
        <ModelPicker
          model={status.model}
          name={status.modelName}
          allowDefaultSpeed={draftMode || status.deferSettings}
          provider={status.provider}
          thinking={status.thinking}
          fast={status.fast ?? null}
          {models}
          loading={modelsLoading}
          error={modelsError}
          disabled={status.disabled || composer.sending}
          onopen={onmodelopen}
          {onmodel}
          {onthinking}
          {onspeed}
        />
      </div>
      {#if running}<button
          class="composer-stop"
          type="button"
          aria-label="停止主代理"
          onclick={onstop}>{@html icon(Square, { size: 17 })}</button
        >{/if}
      <button
        class="composer-send"
        bind:this={sendButton}
        type="submit"
        disabled={!canSend ||
          composer.sending ||
          (!composer.text.trim() && !composer.images.length)}
        aria-label="发送"
        aria-busy={composer.sending}
        aria-haspopup={canQueue ? 'menu' : undefined}
        onpointerdown={startPress}
        onpointermove={(event) => {
          if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8)
            cancelPress();
        }}
        onpointerup={cancelPress}
        onpointercancel={cancelPress}
        onkeydown={(event) => {
          if (
            canQueue &&
            (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
          ) {
            event.preventDefault();
            openMenu(true);
          }
        }}
        oncontextmenu={(event) => {
          if (canQueue) {
            event.preventDefault();
            openMenu();
          }
        }}
        onclick={(event) => {
          if (suppressSend) {
            event.preventDefault();
            suppressSend = false;
          }
        }}
        title={composer.sending ? '发送中…' : canQueue ? '发送，长按排队' : '发送'}
      >
        <span class:composer-loading={composer.sending}>
          {@html icon(composer.sending ? LoaderCircle : ArrowUp, { size: 23 })}
        </span>
      </button>
    </div>
  </form>
</div>

{#if onqueue}
  <div
    class="send-menu"
    popover="manual"
    role="menu"
    aria-label="发送选项"
    tabindex="-1"
    bind:this={queueMenu}
    onkeydown={(event) => event.stopPropagation()}
    onpointerdowncapture={(event) => {
      menuPress = true;
      if (document.activeElement === textarea) event.preventDefault();
    }}
    onclickcapture={(event) => {
      if (event.detail && !menuPress) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      menuPress = false;
    }}
  >
    <button
      type="button"
      role="menuitem"
      disabled={!canQueue}
      onclick={() => {
        closeMenu();
        onqueue();
      }}>{@html icon(Layers, { size: 17 })}排队</button
    >
  </div>
{/if}

<style>
  .composer-region {
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-height: 0;
    min-width: 0;
    max-height: max(110px, calc(var(--remote-height, 100dvh) * 0.5));
  }
  .composer-recoveries {
    flex: none;
    min-height: 0;
    max-height: min(128px, max(40px, calc(var(--remote-height, 100dvh) * 0.5 - 140px)));
    overflow-y: auto;
    padding: 0 6px;
  }
  .composer-recoveries:empty {
    display: none;
  }
  .composer-shell {
    max-height: calc(var(--remote-height, 100dvh) * 0.5);
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-width: 0;
    min-height: 0;
    padding: 12px 12px 8px;
    border: 1px solid color-mix(in srgb, var(--dim) 65%, transparent);
    border-radius: 28px;
    background: var(--composer-bg);
    box-shadow: var(--floating-shadow);
  }
  .recovering .composer-shell {
    padding-top: 8px;
    padding-bottom: 6px;
  }
  textarea {
    display: block;
    resize: none;
    width: 100%;
    flex: 1 1 auto;
    min-height: 40px;
    border: 0;
    border-radius: 0;
    outline: none;
    background: transparent;
    padding: 3px 8px 10px;
    font-size: 16px;
    line-height: 1.5;
    overflow-y: auto;
  }
  textarea::placeholder {
    color: var(--muted);
  }
  .remote-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: none;
    min-width: 0;
  }
  .remote-attach {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    min-height: 40px;
    cursor: pointer;
    border-radius: 50%;
  }
  .remote-attach:focus-within {
    outline: 2px solid var(--accent);
  }
  .remote-attach input {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
    padding: 0;
    min-height: 0;
    opacity: 0;
  }
  .composer-model {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .remote-actions > button {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    min-height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
  }
  .composer-send {
    color: white;
    background: var(--accent);
  }
  .composer-send {
    -webkit-touch-callout: none;
    user-select: none;
  }
  .send-menu {
    position: fixed;
    inset: auto;
    width: min(156px, calc(100vw - 24px));
    margin: 0;
    padding: 6px;
    border: 1px solid var(--dim);
    border-radius: 14px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--popover-shadow);
  }
  .send-menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    text-align: left;
    font-size: 14px;
  }
  .send-menu button:hover {
    background: var(--surface-2);
  }
  .composer-send > span {
    display: inline-flex;
  }
  .composer-loading {
    animation: composer-spin 900ms linear infinite;
  }
  @keyframes composer-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .composer-loading {
      animation: none;
    }
  }
  .composer-send[aria-busy='true'] {
    opacity: 0.7;
  }
  .composer-send:disabled {
    color: var(--body-bg);
    background: var(--muted);
    opacity: 0.32;
  }
  .composer-stop {
    color: var(--body-bg);
    background: var(--text);
  }
  .composer-stop :global(svg) {
    fill: currentColor;
  }
  .remote-images {
    display: flex;
    gap: 6px;
    flex: 0 1 auto;
    min-height: 44px;
    padding: 0 4px;
    overflow-x: auto;
    max-height: 64px;
  }
  @media (max-width: 350px) {
    .composer-shell {
      padding: 10px 8px 6px;
    }
    .remote-actions {
      gap: 4px;
    }
    .remote-attach {
      width: 30px;
    }
  }
</style>
