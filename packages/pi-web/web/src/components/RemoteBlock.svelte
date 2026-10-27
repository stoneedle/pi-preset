<script>
  import { onDestroy, untrack } from 'svelte';
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
  import { readBlock, rememberBlock } from '../remote-cache.js';
  import { fileLinksHTML, toolFiles, isImageFile, fileName } from '../remote-files.js';
  import RemoteImage from './RemoteImage.svelte';
  import Markdown from './Markdown.svelte';
  let { sessionId, entryId, block } = $props();
  let open = $state(false);
  let loading = $state(false);
  let body = $state(untrack(() => readBlock(sessionId, entryId, block.index)));
  let error = $state('');
  let attemptedVersion = $state(null);
  let controller;
  let disposed = false;
  const name = $derived(block.name || '');
  const attachments = $derived(body && block.type === 'tool' ? toolFiles(body, name) : []);
  const imagePath = $derived(
    name === 'read' &&
      block.files?.length === 1 &&
      block.images?.length === 1 &&
      isImageFile(block.files[0])
      ? block.files[0]
      : '',
  );
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
    if (body?.version === block.version && attemptedVersion !== block.version) {
      untrack(() => {
        controller?.abort();
        controller = null;
        loading = false;
        error = '';
      });
      attemptedVersion = block.version;
    } else if (open && body?.version !== block.version && attemptedVersion !== block.version) {
      untrack(load);
    }
  });

  onDestroy(() => {
    disposed = true;
    controller?.abort();
  });

  export function loadedBody() {
    return block.type === 'tool' ? body : null;
  }

  export function reveal() {
    if (!open) {
      open = true;
      load();
    }
  }

  function toggle() {
    open = !open;
    if (open) load();
  }

  async function load() {
    const version = block.version;
    if (body?.version === version || (loading && attemptedVersion === version)) return;
    controller?.abort();
    const current = (controller = new AbortController());
    attemptedVersion = version;
    loading = true;
    error = '';
    try {
      const next = await request(
        `/api/session/block?id=${encodeURIComponent(sessionId)}&entry=${encodeURIComponent(entryId)}&index=${block.index}`,
        { signal: current.signal },
      );
      if (disposed || current !== controller || version !== block.version) return;
      if (next.version !== version) throw new Error('内容版本已变化，请等待会话同步后重试。');
      body = next;
      rememberBlock(sessionId, entryId, block.index, next);
    } catch (err) {
      if (!disposed && current === controller && !current.signal.aborted) error = err.message;
    } finally {
      if (current === controller) loading = false;
    }
  }
</script>

{#if block.type === 'image'}
  <RemoteImage {sessionId} entry={entryId} index={block.index} />
{:else}
  <div
    class="remote-block"
    data-reading-block={block.index}
    class:remote-block-thinking={block.type === 'thinking'}
  >
    <button
      type="button"
      class="remote-block-toggle"
      aria-expanded={open}
      onclick={toggle}
      aria-label={block.type === 'thinking' ? `${open ? '收起' : '展开'}推理内容` : undefined}
    >
      <span class="remote-block-kind">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
        {@html icon(kindIcon, { size: 14 })}
      </span>
      {#if block.type === 'tool'}<span class="remote-block-name" title={name}>{name}</span>{/if}
      <span class="remote-block-summary">
        {#if block.type === 'thinking'}<Markdown text={block.summary || ''} {sessionId} inline />
        {:else}{block.summary || ''}{/if}
      </span>
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
    {#each (block.files || []).filter((path) => path !== imagePath) as path (path)}
      {#if isImageFile(path)}<RemoteImage {sessionId} {path} />
      {:else}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped file metadata and trusted controls -->
        {@html fileLinksHTML(sessionId, path)}
      {/if}
    {/each}
    {#each block.images || [] as image (image.entry + ':' + image.index)}
      <RemoteImage {sessionId} {...image} name={imagePath ? fileName(imagePath) : ''} />
    {/each}
    {#if open}
      <div class="remote-block-body">
        {#if loading}<p role="status">{body ? '正在更新，保留已加载内容…' : '加载中…'}</p>{/if}
        {#if error}<p role="alert">
            {body ? '更新失败，以下保留已加载内容。' : ''}{error}
            <button type="button" onclick={load}>重试</button>
          </p>{/if}
        {#if body}
          {#if body.input}<pre>{JSON.stringify(body.input, null, 2)}</pre>{/if}
          {#if body.text}
            {#if block.type === 'thinking'}<Markdown text={body.text} {sessionId} muted compact />
            {:else}<pre>{body.text}</pre>{/if}
          {/if}
          {#each attachments.filter(({ path }) => !block.files?.includes(path)) as { path, image } (path)}
            {#if image}<RemoteImage {sessionId} {path} />
            {:else}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped file metadata and trusted controls -->
              {@html fileLinksHTML(sessionId, path)}
            {/if}
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
  .remote-block-body > pre {
    padding: 12px;
    overflow: auto;
    max-width: 100%;
    background: var(--surface-2);
    border-radius: 6px;
    font: var(--font-content-size)/1.5 var(--font-code);
  }
</style>
