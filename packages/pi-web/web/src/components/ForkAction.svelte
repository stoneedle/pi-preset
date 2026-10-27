<script>
  import { onMount } from 'svelte';
  import { icon, GitFork, LoaderCircle } from '../shared/icons.js';
  import { request } from '../remote-api.js';

  let { sessionId, entryId = '', busy = $bindable(false), onfork, menu = true } = $props();
  let error = $state('');
  let pending = $state(false);
  let disposed = false;
  onMount(() => () => (disposed = true));

  async function fork() {
    if (busy) return;
    busy = true;
    pending = true;
    error = '';
    try {
      const result = await request('/api/session/fork?id=' + encodeURIComponent(sessionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId }),
      });
      if (!disposed) onfork(result.id);
    } catch (err) {
      if (!disposed)
        error = err.status
          ? err.message
          : '分叉结果尚未确认，请先查看会话列表；不会自动重试。' + err.message;
    } finally {
      pending = false;
      busy = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<button
  type="button"
  role={menu ? 'menuitem' : undefined}
  class:action={menu}
  aria-label={pending ? '正在分叉…' : entryId ? '从这里分叉' : '分叉为新会话'}
  title={entryId ? '从这里分叉' : '分叉为新会话'}
  disabled={busy}
  onclick={fork}
>
  {@html icon(pending ? LoaderCircle : GitFork, { size: 18 })}
  {#if menu}<span>{pending ? '正在分叉…' : entryId ? '从这里分叉' : '分叉为新会话'}</span>{/if}
</button>
{#if error}<p role="alert">{error}</p>{/if}

<style>
  p {
    flex-basis: 100%;
    margin: 4px 0;
    color: var(--danger);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
</style>
