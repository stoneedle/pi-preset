<script>
  import { untrack } from 'svelte';
  import {
    icon,
    Brain,
    Terminal,
    Code,
    Wrench,
    Check,
    CircleDashed,
    CircleAlert,
    ChevronRight,
  } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import { fileLinksHTML, linkedFiles } from '../remote-files.js';
  import RemoteImage from './RemoteImage.svelte';
  let { sessionId, entryId, block } = $props();
  let open = $state(false);
  let loading = $state(false);
  let body = $state(null);
  let error = $state('');
  let bodyState = $state(null);
  const name = $derived(block.type === 'tool' ? block.name : '思考');
  const stateLabel = $derived(
    block.state === 'done' ? '已完成' : block.state === 'error' ? '失败' : '暂无结果',
  );
  const kindIcon = $derived(
    block.type === 'thinking'
      ? Brain
      : block.name === 'bash'
        ? Terminal
        : block.name === 'codemode'
          ? Code
          : Wrench,
  );

  $effect(() => {
    if (open && body && bodyState !== block.state) untrack(load);
  });

  function toggle() {
    open = !open;
    if (open) load();
  }

  async function load() {
    if (loading || (body && bodyState === block.state)) return;
    const requestedState = block.state;
    loading = true;
    error = '';
    try {
      body = await request(
        `/api/session/block?id=${encodeURIComponent(sessionId)}&entry=${encodeURIComponent(entryId)}&index=${block.index}`,
      );
      bodyState = requestedState;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

{#if block.type === 'image'}
  <RemoteImage {sessionId} entry={entryId} index={block.index} />
{:else}
  <div class="remote-block">
    <button type="button" class="remote-block-toggle" aria-expanded={open} onclick={toggle}>
      <span class="remote-block-kind">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
        {@html icon(kindIcon, { size: 14 })}
      </span>
      <span class="remote-block-name" title={name}>{name}</span>
      <span class="remote-block-summary">{block.summary || ''}</span>
      {#if block.state}
        <span
          class="remote-block-state"
          data-state={block.state}
          role="img"
          aria-label={stateLabel}
          title={stateLabel}
        >
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
          {@html icon(
            block.state === 'done' ? Check : block.state === 'error' ? CircleAlert : CircleDashed,
            { size: 14 },
          )}
        </span>
      {/if}
      <span class="remote-block-chevron" class:remote-block-expanded={open}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
        {@html icon(ChevronRight, { size: 14 })}
      </span>
    </button>
    {#each block.files || [] as path (path)}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped file metadata and trusted controls -->
      {@html fileLinksHTML(sessionId, path)}
    {/each}
    {#each block.images || [] as image (image.entry + ':' + image.index)}
      <RemoteImage {sessionId} {...image} />
    {/each}
    {#if open}
      <div class="remote-block-body">
        {#if loading}
          <p>加载中…</p>
        {:else if error}
          <p role="alert">{error}</p>
        {:else if body}
          {#if body.input}<pre>{JSON.stringify(body.input, null, 2)}</pre>{/if}
          {#if body.text}<pre
              class:remote-thinking={block.type === 'thinking'}>{body.text}</pre>{/if}
          {#each linkedFiles(body.text).filter((path) => !block.files?.includes(path)) as path (path)}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped file metadata and trusted controls -->
            {@html fileLinksHTML(sessionId, path)}
          {/each}
          {#if body.details}<pre>{JSON.stringify(body.details, null, 2)}</pre>{/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .remote-block-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    min-height: 28px;
    padding: 4px 0;
    text-align: left;
    border: 0;
    border-radius: 0;
    font-size: 12px;
    line-height: 20px;
    color: var(--muted);
    background: transparent;
    white-space: nowrap;
    overflow-wrap: normal;
  }
  .remote-block-toggle:hover .remote-block-name {
    color: var(--accent);
  }
  .remote-block-kind,
  .remote-block-state,
  .remote-block-chevron {
    display: inline-flex;
    flex: none;
    align-items: center;
    color: var(--muted);
  }
  .remote-block-name {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .remote-block-summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
  }
  .remote-block-state {
    margin-left: auto;
  }
  .remote-block-state[data-state='done'] {
    color: var(--muted);
  }
  .remote-block-state[data-state='error'] {
    color: var(--danger);
  }
  .remote-block-chevron.remote-block-expanded {
    transform: rotate(90deg);
  }
  .remote-block-body {
    padding: 2px 0 6px 20px;
  }
  .remote-thinking {
    margin: 0 0 8px;
    padding: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-soft);
    background: transparent;
    font: var(--font-content-size)/1.6 var(--font-content);
  }
</style>
