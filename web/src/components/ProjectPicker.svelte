<script>
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
  let loading = $state(false);
  let error = $state('');
  let epoch = 0;
  let controller;
  export function open(selected = '') {
    path = selected;
    dialog.showModal();
    browse(selected);
    request('/api/recent-locations')
      .then((data) => (recent = data.locations || []))
      .catch(() => {});
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
<dialog
  class="project-picker"
  aria-label="选择项目"
  bind:this={dialog}
  onclose={() => {
    epoch++;
    controller?.abort();
    loading = false;
  }}
>
  <header>
    <h2>选择项目</h2>
    <button type="button" aria-label="关闭项目选择" onclick={() => dialog.close()}
      >{@html icon(X)}</button
    >
  </header>
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
  {#if recent.length}<details>
      <summary>已有项目</summary>
      <div class="recent-projects">
        {#each recent as location (location)}<button type="button" onclick={() => browse(location)}
            >{@html icon(Folder, { size: 17 })}<span
              >{location.split(/[\\/]/).filter(Boolean).at(-1) || location}</span
            ></button
          >{/each}
      </div>
    </details>{/if}
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
        >{@html icon(Folder, { size: 19 })}<span>{directory.name}</span>{@html icon(ChevronRight, {
          size: 15,
        })}</button
      >
    {/each}
    {#if !loading && current && !directories.length}<p>此文件夹中没有子文件夹</p>{/if}
  </div>
  <footer>
    <span>{current.split(/[\\/]/).filter(Boolean).at(-1) || current}</span><button
      type="button"
      disabled={loading || !current || Boolean(error)}
      onclick={() => {
        onselect(current);
        dialog.close();
      }}>使用此文件夹</button
    >
  </footer>
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
    min-height: 32px;
    padding: 5px 12px;
    border: 0;
    border-radius: 20px;
    background: var(--surface-2);
    font-size: 12px;
  }
  details {
    flex: none;
    max-height: 120px;
    overflow: auto;
    margin-bottom: 8px;
  }
  summary {
    font-size: 13px;
    color: var(--text-soft);
    cursor: pointer;
  }
  .recent-projects button,
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
  .directory-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    margin: 0 -6px;
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
