<script>
  import { untrack } from 'svelte';
  import { sessionQueue } from '../remote-queue.svelte.js';
  import { icon, Layers, SquarePen, X, ChevronDown } from '../shared/icons.js';
  import CopyAction from './CopyAction.svelte';

  let { sessionId, composer, status, available, onedit } = $props();
  const queue = untrack(() => sessionQueue(sessionId, composer));
  let expanded = $state('');
  const waiting = $derived(
    available && status.queueCount > 0 && status.queueRevision > queue.state.revision,
  );
  $effect(() => {
    const { instanceId, queueRevision, queueCount } = status;
    untrack(() => queue.observe(instanceId, queueRevision, queueCount, available));
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
{#if queue.state.items.length || queue.state.error || waiting}
  <section class="queued-messages" aria-label="排队消息">
    {#if waiting && !queue.state.items.length && !queue.state.error}
      <p class="queue-loading" role="status">排队 {status.queueCount} 条，正在读取…</p>
    {/if}
    {#each queue.state.items as item (item.id)}
      <div class="queued-message" data-queue-id={item.id}>
        <button
          class="queue-summary"
          type="button"
          aria-expanded={expanded === item.id}
          onclick={() => (expanded = expanded === item.id ? '' : item.id)}
        >
          {@html icon(Layers, { size: 15 })}
          <span
            >{item.state === 'failed'
              ? '投递失败'
              : item.state === 'delivering'
                ? '投递中'
                : '排队'}：{item.message || '图片'}{item.imageCount
              ? ` · ${item.imageCount} 张图片`
              : ''}</span
          >
          {@html icon(ChevronDown, { size: 13 })}
        </button>
        <button
          type="button"
          aria-label="取回编辑"
          title="取回编辑"
          disabled={!available ||
            composer.sending ||
            !!queue.state.busy ||
            item.state === 'delivering'}
          onclick={async () => {
            if (await queue.remove(item.id, true)) onedit();
          }}>{@html icon(SquarePen, { size: 16 })}</button
        >
        <button
          type="button"
          aria-label="取消排队"
          title="取消排队"
          disabled={!available || !!queue.state.busy || item.state === 'delivering'}
          onclick={() => queue.remove(item.id, false)}>{@html icon(X, { size: 16 })}</button
        >
        {#if expanded === item.id}
          <div class="queue-content">
            {#if !available}<p>连接恢复后可取回编辑或取消。</p>{/if}
            {#if item.error}<p>{item.error}</p>{/if}
            <div class="queue-text">{item.message}</div>
            {#if item.imageCount}<p>{item.imageCount} 张图片，取回编辑后可查看。</p>{/if}
            <CopyAction text={item.message} />
          </div>
        {/if}
      </div>
    {/each}
    {#if queue.state.error}
      <p class="queue-error" role="status">
        {queue.state.error}<button type="button" onclick={queue.refresh}>重试</button>
      </p>
    {/if}
  </section>
{/if}

<style>
  .queued-messages {
    min-width: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .queued-message {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 40px 40px;
    align-items: start;
  }
  button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 0 5px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: inherit;
  }
  button:disabled {
    opacity: 0.4;
  }
  .queue-summary {
    min-width: 0;
    gap: 5px;
    padding-left: 0;
    text-align: left;
  }
  .queue-summary span {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .queue-summary :global(svg) {
    flex: none;
  }
  .queue-summary[aria-expanded='true'] :global(svg:last-child) {
    transform: rotate(180deg);
  }
  .queue-content {
    grid-column: 1 / -1;
    min-width: 0;
    padding: 0 4px 8px;
    overflow-wrap: anywhere;
  }
  .queue-text {
    white-space: pre-wrap;
    color: var(--text-soft);
    user-select: text;
  }
  p {
    margin: 0 0 6px;
  }
  .queue-loading {
    display: flex;
    align-items: center;
    min-height: 40px;
    margin: 0;
  }
  .queue-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .queue-error button {
    display: inline-flex;
    color: var(--link);
  }
</style>
