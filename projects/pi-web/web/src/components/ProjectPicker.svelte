<script>
  import { onDestroy } from 'svelte';
  import { icon, Folder, ArrowLeft, X, ChevronRight } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  let { onselect } = $props();
  let dialog = $state(null);
  let path = $state('');
  let current = $state('');
  let parent = $state('');
  let directories = $state([]);
  let roots = $state([]);
  let recent = $state([]);
  let recentLoading = $state(false);
  let recentError = $state('');
  let systemPathsOpen = $state(false);
  let loading = $state(false);
  let error = $state('');
  let epoch = 0;
  let controller;
  let recentController;
  function cancel() {
    epoch++;
    controller?.abort();
    recentController?.abort();
    loading = false;
    recentLoading = false;
  }
  onDestroy(cancel);
  export function open(selected = '') {
    cancel();
    path = selected;
    current = '';
    parent = '';
    directories = [];
    roots = [];
    error = '';
    systemPathsOpen = false;
    dialog.showModal();
    loadRecent();
  }
  async function loadRecent() {
    recentController?.abort();
    const active = new AbortController();
    recentController = active;
    recentLoading = true;
    recentError = '';
    try {
      const data = await request('/api/recent-locations', { signal: active.signal });
      if (!active.signal.aborted) recent = data.locations || [];
    } catch (err) {
      if (!active.signal.aborted) recentError = err.message;
    } finally {
      if (!active.signal.aborted) recentLoading = false;
    }
  }
  function select(location) {
    onselect(location);
    dialog.close();
  }
  async function browse(target) {
    path = target;
    controller?.abort();
    controller = new AbortController();
    const generation = ++epoch;
    loading = true;
    error = '';
    try {
      const data = await request('/api/directories?path=' + encodeURIComponent(target), {
        signal: controller.signal,
      });
      if (generation !== epoch) return;
      current = data.path;
      if (target && path === target) path = data.path;
      parent = data.parent;
      directories = data.directories;
      roots = data.roots;
    } catch (err) {
      if (generation === epoch && err.name !== 'AbortError') error = err.message;
    } finally {
      if (generation === epoch) loading = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog class="project-picker" aria-label="选择项目" bind:this={dialog} onclose={cancel}>
  <header>
    <h2>选择项目</h2>
    <button type="button" aria-label="关闭项目选择" onclick={() => dialog.close()}
      >{@html icon(X)}</button
    >
  </header>
  <div class="picker-content">
    <section class="recent-projects" aria-label="已有项目" aria-busy={recentLoading}>
      <h3>已有项目</h3>
      {#if recentLoading && !recent.length}<p role="status">正在读取已有项目…</p>{/if}
      {#if recentError}<p class="picker-error" role="alert">
          {recentError}<button type="button" onclick={loadRecent}>重试</button>
        </p>{/if}
      {#each recent as location (location)}
        <button type="button" title={location} onclick={() => select(location)}
          >{@html icon(Folder, { size: 19 })}<span
            >{location.split(/[\\/]/).filter(Boolean).at(-1) || location}</span
          ></button
        >
      {/each}
      {#if !recentLoading && !recentError && !recent.length}<p>
          暂无已有项目，请展开系统路径选择文件夹。
        </p>{/if}
    </section>
    <details
      bind:open={systemPathsOpen}
      ontoggle={(event) => {
        if (dialog.open && event.currentTarget.open && !current && !loading) browse(path);
      }}
    >
      <summary>系统路径</summary>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          browse(path);
        }}
      >
        <input
          aria-label="文件夹路径"
          placeholder="输入电脑上的文件夹路径"
          bind:value={path}
          spellcheck="false"
        />
        <button type="submit">前往</button>
      </form>
      <div class="directory-shortcuts">
        {#each roots as root (root)}<button type="button" onclick={() => browse(root)}
            >{root.replace(/[\\/]+$/, '') || '/'}</button
          >{/each}
      </div>
      {#if error}<p class="picker-error" role="alert">{error}</p>{/if}
      <div class="directory-list" aria-busy={loading}>
        {#if loading}<p role="status">正在读取文件夹…</p>{/if}
        {#if current && parent !== current}<button
            type="button"
            onclick={() => browse(parent)}
            disabled={loading}>{@html icon(ArrowLeft, { size: 18 })}<span>上一级</span></button
          >{/if}
        {#each directories as directory (directory.path)}
          <button type="button" disabled={loading} onclick={() => browse(directory.path)}
            >{@html icon(Folder, { size: 19 })}<span>{directory.name}</span>{@html icon(
              ChevronRight,
              {
                size: 15,
              },
            )}</button
          >
        {/each}
        {#if !loading && current && !directories.length}<p>此文件夹中没有子文件夹</p>{/if}
      </div>
    </details>
  </div>
  {#if systemPathsOpen}
    <footer>
      <span title={current}>{current.split(/[\\/]/).filter(Boolean).at(-1) || current}</span><button
        type="button"
        disabled={loading || !current || Boolean(error)}
        onclick={() => select(current)}>使用此文件夹</button
      >
    </footer>
  {/if}
</dialog>

<style>
  .project-picker {
    position: fixed;
    inset: 0;
    display: none;
    flex-direction: column;
    width: min(520px, 100vw);
    height: min(720px, calc(var(--remote-height, 100dvh) - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    max-width: 100vw;
    margin: auto;
    padding: 20px;
    border: 1px solid var(--dim);
    border-radius: 28px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--popover-shadow);
    overflow: hidden;
  }
  .project-picker[open] {
    display: flex;
    animation: picker-in 220ms var(--ease-out);
  }
  .project-picker::backdrop {
    background: #0005;
    backdrop-filter: blur(3px);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    flex: none;
  }
  h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }
  header button {
    display: grid;
    place-items: center;
    width: 36px;
    min-height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--surface-2);
  }
  form {
    display: flex;
    gap: 8px;
    flex: none;
  }
  form input {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    padding: 10px 12px;
    border: 0;
    border-radius: 12px;
    background: var(--surface-2);
  }
  form button {
    border: 0;
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 14px;
  }
  .directory-shortcuts {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 12px 0;
    flex: none;
  }
  .directory-shortcuts button {
    flex: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-height: 32px;
    padding: 5px 12px;
    border: 0;
    border-radius: 20px;
    background: var(--surface-2);
    font-size: 12px;
  }
  .picker-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-soft);
  }
  details {
    margin-top: 12px;
  }
  summary {
    padding: 12px 0;
    font-size: 14px;
    color: var(--text-soft);
    cursor: pointer;
  }
  .recent-projects > button,
  .directory-list button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    text-align: left;
    min-height: 48px;
    padding: 10px 6px;
    border: 0;
    border-radius: 12px;
    background: transparent;
  }
  button:hover {
    background: var(--surface-2);
  }
  .directory-list :global(svg),
  .recent-projects :global(svg) {
    flex: none;
    color: var(--muted);
  }
  button span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  p {
    font-size: 13px;
    color: var(--muted);
  }
  .picker-error {
    color: var(--danger);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 12px;
    flex: none;
  }
  footer span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 13px;
  }
  footer button {
    flex: none;
    border: 0;
    border-radius: 22px;
    padding: 10px 16px;
    color: var(--body-bg);
    background: var(--text);
    font-size: 14px;
  }
  @keyframes picker-in {
    from {
      opacity: 0;
      transform: translateY(14px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (max-width: 540px) {
    .project-picker {
      width: 100vw;
      height: var(--remote-height, 100dvh);
      max-height: var(--remote-height, 100dvh);
      border: 0;
      border-radius: 0;
      padding: 16px 20px max(16px, env(safe-area-inset-bottom));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .project-picker[open] {
      animation: none;
    }
  }
</style>
