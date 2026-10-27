<script>
  import { icon, SquarePen, Archive, History, X } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import ActionMenu from './ActionMenu.svelte';
  import ForkAction from './ForkAction.svelte';
  import { sessionArchives } from '../remote-session-management.svelte.js';

  let { onchange, onarchive, onprojectarchive, ondisconnected, onfork } = $props();
  let menu;
  let renameDialog;
  let nameInput = $state(null);
  let anchor;
  let session = $state(null);
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  const batchDisabled = $derived(
    busy ||
      sessionArchives.batchPending ||
      sessionArchives.pending.size > 0 ||
      sessionArchives.pendingProjects.size > 0,
  );

  export function open(value, source) {
    if (busy || menu.isOpenFor(source)) return;
    anchor = source;
    session = value;
    name = value.name;
    error = '';
    menu.open(source, value.kind !== 'project');
  }
  function closeRename() {
    if (!busy) {
      renameDialog.close();
      anchor?.focus({ preventScroll: true });
    }
  }
  function rename() {
    menu.close();
    renameDialog.showModal();
    nameInput.focus();
    nameInput.select();
  }
  function archive() {
    menu.close();
    if (session.kind === 'project') onprojectarchive?.(session);
    else onarchive?.(session);
  }
  function archiveDisconnected() {
    menu.close();
    ondisconnected?.(session.kind === 'project' ? session : undefined);
  }
  async function save() {
    if (busy) return;
    busy = true;
    error = '';
    const target = session;
    let reply;
    try {
      reply = await request(`/api/session/name?id=${encodeURIComponent(target.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch (err) {
      error = err.message;
      return;
    } finally {
      busy = false;
    }
    renameDialog.close();
    anchor?.focus({ preventScroll: true });
    await onchange?.(target, { name: reply.name });
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<ActionMenu
  bind:this={menu}
  label={session?.kind === 'all'
    ? '归档操作'
    : session?.kind === 'project'
      ? '文件夹操作'
      : '会话操作'}
  dismissTargets="a.remote-session, button.remote-project-toggle, button.remote-archives"
>
  {#if session}
    {#if session.kind === 'session'}
      <button type="button" role="menuitem" class="action" disabled={busy} onclick={rename}>
        {@html icon(SquarePen, { size: 18 })}<span>重命名</span>
      </button>
      {#key session.id}
        <ForkAction
          sessionId={session.id}
          bind:busy
          onfork={(id) => {
            menu.close();
            onfork(id);
          }}
        />
      {/key}
    {/if}
    {#if session.kind !== 'session'}
      <button
        type="button"
        role="menuitem"
        class="action"
        disabled={batchDisabled}
        onclick={archiveDisconnected}
      >
        {@html icon(Archive, { size: 18 })}<span
          >{sessionArchives.batchPending
            ? '归档中…'
            : session.kind === 'all'
              ? '归档所有断开会话'
              : '归档断开会话'}</span
        >
      </button>
    {/if}
    {#if session.kind !== 'all'}
      <button
        type="button"
        role="menuitem"
        class="action"
        disabled={busy || sessionArchives.batchPending}
        onclick={archive}
      >
        {@html icon(session.archived ? History : Archive, { size: 18 })}<span
          >{session.archived
            ? '恢复会话'
            : session.kind === 'project'
              ? '归档整个文件夹'
              : '归档'}</span
        >
      </button>
    {/if}
  {/if}
</ActionMenu>

<dialog
  bind:this={renameDialog}
  class="session-rename"
  aria-label="重命名会话"
  oncancel={(event) => {
    event.preventDefault();
    closeRename();
  }}
  onkeydown={(event) => event.stopPropagation()}
>
  {#if session}
    <header>
      <strong>重命名会话</strong>
      <button type="button" aria-label="关闭会话操作" disabled={busy} onclick={closeRename}
        >{@html icon(X, { size: 18 })}</button
      >
    </header>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        bind:this={nameInput}
        aria-label="会话名称"
        bind:value={name}
        maxlength="1024"
        autocomplete="off"
        disabled={busy}
      />
      {#if error}<p role="alert">{error}</p>{/if}
      <footer>
        <button type="button" disabled={busy} onclick={closeRename}>取消</button>
        <button type="submit" class="primary" disabled={busy || !name.trim()}
          >{busy ? '保存中…' : '保存名称'}</button
        >
      </footer>
    </form>
  {/if}
</dialog>

<style>
  .session-rename {
    width: min(380px, calc(100vw - 32px));
    max-width: none;
    max-height: calc(var(--remote-height, 100dvh) - 32px);
    padding: 20px;
    overflow: auto;
    border: 1px solid var(--dim);
    border-radius: 20px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--popover-shadow);
  }
  .session-rename::backdrop {
    background: #0005;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }
  header strong {
    font-size: 16px;
  }
  header button {
    display: grid;
    place-items: center;
    padding: 6px;
    border: 0;
    background: transparent;
  }
  input {
    width: 100%;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--dim);
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 16px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  footer button {
    min-height: 44px;
  }
  p {
    margin: 8px;
    color: var(--danger);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
</style>
