<script>
  import { onMount, tick, untrack } from 'svelte';
  import { icon, Brain, Terminal, SquarePen, ChevronDown, X } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import { editDraft } from '../remote-drafts.svelte.js';

  let {
    composer,
    url = '',
    catalogKey = '',
    onselect,
    onsessioninfo,
    oncompact,
    canCompact = false,
  } = $props();
  const categories = [
    { source: 'skill', label: '技能', glyph: Brain },
    { source: 'extension', label: '命令', glyph: Terminal },
    { source: 'prompt', label: 'Prompt', glyph: SquarePen },
  ];
  const resource = $derived({ url, catalogKey });
  const slashQuery = $derived(composer.text.match(/^\/(\S*)$/)?.[1]?.toLowerCase());
  let category = $state('');
  let search = $state('');
  let commands = $state([]);
  let loading = $state(false);
  let error = $state('');
  let dismissed = $state(null);
  let panel = $state(null);
  let bar = $state(null);
  let loaded;
  let previousURL = '';
  let currentCatalog = $state(false);
  let controller;
  const query = $derived(category ? search.toLowerCase().trim() : slashQuery || '');
  const options = $derived(
    [
      ...(category === 'extension' && onsessioninfo
        ? [
            { name: 'session', label: '会话详情', action: onsessioninfo },
            { name: 'compact', label: '压缩上下文', action: oncompact, disabled: !canCompact },
          ]
        : []),
      ...commands.filter((command) => command.source === (category || 'skill')),
    ].filter((command) => `${command.name} ${command.label || ''}`.toLowerCase().includes(query)),
  );
  const visible = $derived(
    Boolean(category) ||
      (slashQuery !== undefined && dismissed !== composer.revision && options.length > 0),
  );

  $effect(() => {
    const source = resource;
    const active = new AbortController();
    controller = active;
    loaded = null;
    if (previousURL !== source.url) commands = [];
    previousURL = source.url;
    currentCatalog = false;
    error = '';
    loading = false;
    return () => active.abort();
  });
  $effect(() => {
    const source = resource;
    if ((!category && slashQuery === undefined) || !source.url) return;
    untrack(() => load(source));
  });
  $effect(() => {
    if (!panel) return;
    if (visible) {
      panel.showPopover();
      tick().then(position);
    } else panel.hidePopover();
  });
  $effect(() => {
    options;
    loading;
    error;
    tick().then(position);
  });

  async function load(source, retry = false) {
    if (!retry && loaded === source) return;
    loaded = source;
    const signal = controller.signal;
    const requestedQuery = query;
    const requestedCategory = category;
    loading = true;
    error = '';
    try {
      const data = await request(source.url, { signal });
      if (!signal.aborted) {
        commands = data.commands;
        currentCatalog = true;
      }
    } catch (err) {
      if (!signal.aborted) {
        loaded = null;
        error = err.message;
        if (query !== requestedQuery || category !== requestedCategory) await load(source);
      }
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  function position() {
    if (!panel?.matches(':popover-open') || !bar) return;
    const anchor = bar.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const height = viewport?.height || innerHeight;
    panel.style.width = `${Math.min(anchor.width, (viewport?.width || innerWidth) - 24)}px`;
    panel.style.maxHeight = `${Math.max(44, Math.min(320, height * 0.5, anchor.top - top - 12))}px`;
    panel.style.left = `${Math.max(left + 12, anchor.left)}px`;
    panel.style.top = `${Math.max(top + 8, anchor.top - panel.getBoundingClientRect().height - 4)}px`;
  }

  function close() {
    dismissed = composer.revision;
    category = '';
    panel?.hidePopover();
  }

  function select(command) {
    close();
    if (command.action) {
      command.action();
      return;
    }
    const prefix = `/${command.name} `;
    const existing = composer.text.match(/^\/(\S+)/)?.[1];
    const completing = slashQuery !== undefined || commands.some((item) => item.name === existing);
    const body = completing ? composer.text.replace(/^\/\S*\s?/, '') : composer.text;
    editDraft(composer, prefix + body);
    onselect?.(prefix.length);
  }

  onMount(() => {
    const outside = (event) => {
      if (
        !panel?.matches(':popover-open') ||
        panel.contains(event.target) ||
        bar.contains(event.target)
      )
        return;
      if (event.target instanceof HTMLTextAreaElement && bar.parentElement.contains(event.target))
        return;
      close();
    };
    const escape = (event) => {
      if (event.key !== 'Escape' || !panel?.matches(':popover-open')) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<div class="command-bar" bind:this={bar} role="group" aria-label="输入快捷操作">
  {#each categories as item (item.source)}
    <button
      type="button"
      disabled={!url && !onsessioninfo}
      aria-expanded={visible && category === item.source}
      aria-haspopup="dialog"
      onpointerdown={(event) => event.preventDefault()}
      onclick={() => {
        if (category === item.source) close();
        else {
          category = item.source;
          search = '';
        }
      }}
      >{@html icon(item.glyph, { size: 15 })}{item.label}{@html icon(ChevronDown, {
        size: 12,
      })}</button
    >
  {/each}
</div>
<div
  class="command-panel"
  class:remote-skills={!category}
  popover="manual"
  role="dialog"
  aria-label={category ? categories.find((item) => item.source === category)?.label : '技能补全'}
  bind:this={panel}
>
  {#if visible}
    {#if category}
      <div class="command-search">
        <input aria-label="搜索快捷操作" placeholder="搜索" bind:value={search} />
        <button type="button" aria-label="收起快捷操作" onclick={close}
          >{@html icon(X, { size: 18 })}</button
        >
      </div>
    {/if}
    {#each options as command (command.name)}
      <button
        class="command-option"
        type="button"
        disabled={command.disabled || (!command.action && !currentCatalog)}
        title={command.name}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => select(command)}
        ><span>{command.label || command.name}</span>{#if command.label}<small
            >/{command.name}</small
          >{/if}</button
      >
    {/each}
    {#if category && loading}<p role="status">加载中…</p>{/if}
    {#if category && error}<div class="command-error" role="alert">
        {error}<button type="button" onclick={() => load(resource, true)}>重试</button>
      </div>{/if}
    {#if category && !loading && !error && !options.length}<p>
        {search
          ? '没有匹配项'
          : category === 'extension'
            ? '连接 Pi 后显示扩展命令'
            : category === 'prompt'
              ? '当前项目没有 Prompt 模板'
              : '当前项目没有技能'}
      </p>{/if}
  {/if}
</div>

<style>
  .command-bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 0 8px;
  }
  .command-bar button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--text-soft);
    font-size: 13px;
    white-space: nowrap;
  }
  .command-bar button[aria-expanded='true'] {
    color: var(--text);
    background: var(--surface-2);
  }
  .command-panel {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--dim);
    border-radius: 16px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--popover-shadow);
  }
  .command-search {
    position: sticky;
    top: -4px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    background: var(--surface);
  }
  .command-search input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    font-size: 16px;
  }
  .command-search input::placeholder {
    color: var(--text-soft);
  }
  .command-search button {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
  }
  .command-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    text-align: left;
  }
  .command-option > span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .command-option small {
    flex: none;
    color: var(--text-soft);
  }
  .command-option:hover {
    background: var(--surface-2);
  }
  p,
  .command-error {
    margin: 0;
    padding: 12px;
    font-size: 13px;
    color: var(--text-soft);
    overflow-wrap: anywhere;
  }
  .command-error {
    color: var(--danger);
  }
  .command-error button {
    display: block;
    min-height: 44px;
    margin-top: 4px;
  }
</style>
