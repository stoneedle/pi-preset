<script>
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteURL, SvelteURLSearchParams } from 'svelte/reactivity';
  import { icon, ChevronDown, X } from '../shared/icons.js';

  let { title, subtitle = '' } = $props();
  const origin = window.location.origin;
  const hostname = window.location.host;
  const storageKey = 'pi-web:hosts';
  const maxHosts = 32;
  let dialog = $state(null);
  let hosts = $state([]);
  let address = $state('');
  let name = $state('');
  let error = $state('');

  function normalizeHost(entry) {
    if (
      typeof entry?.url !== 'string' ||
      entry.url.length > 2048 ||
      String(entry.name || '').length > 200
    )
      throw new Error('请输入 HTTP 或 HTTPS 主机地址，不含会话路径、令牌、查询参数或片段。');
    const url = new SvelteURL(entry.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('请输入 HTTP 或 HTTPS 主机地址，不含会话路径、令牌、查询参数或片段。');
    return { url: url.origin, name: String(entry.name || '').trim() || url.host };
  }

  function mergeHosts(entries) {
    const result = new SvelteMap([[origin, { url: origin, name: hostname }]]);
    let namedCurrent = false;
    for (const entry of entries.slice(0, maxHosts * 2)) {
      try {
        const host = normalizeHost(entry);
        if (host.url === origin && !namedCurrent) {
          result.set(origin, host);
          namedCurrent = true;
        } else if (!result.has(host.url) && result.size < maxHosts) result.set(host.url, host);
      } catch {
        continue;
      }
    }
    return [...result.values()].sort((a, b) => (a.url === origin ? -1 : b.url === origin ? 1 : 0));
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(hosts));
    } catch {
      error = '浏览器存储不可用，主机仅在当前标签页可用。';
    }
  }

  function add(event) {
    event.preventDefault();
    error = '';
    try {
      const host = normalizeHost({ url: address.trim(), name });
      if (hosts.length >= maxHosts && !hosts.some((item) => item.url === host.url)) {
        error = `最多可保存 ${maxHosts} 台主机。`;
        return;
      }
      hosts = mergeHosts([host, ...hosts.filter((item) => item.url !== host.url)]);
      save();
      address = '';
      name = '';
    } catch {
      error = '请输入 HTTP 或 HTTPS 主机地址，不含会话路径、令牌、查询参数或片段。';
    }
  }

  function visit(url) {
    if (url === origin) {
      dialog.close();
      return;
    }
    const target = new SvelteURL('/', url);
    target.hash = new SvelteURLSearchParams({ 'pi-web-hosts': JSON.stringify(hosts) }).toString();
    window.location.assign(target.href);
  }

  onMount(() => {
    let saved = [];
    try {
      const raw = localStorage.getItem(storageKey) || '[]';
      const stored = raw.length <= 128 * 1024 ? JSON.parse(raw) : [];
      if (Array.isArray(stored)) saved = stored;
    } catch {
      saved = [];
    }
    const fragment = new SvelteURLSearchParams(window.location.hash.slice(1));
    if (fragment.has('pi-web-hosts')) {
      try {
        const raw = fragment.get('pi-web-hosts');
        const incoming = raw.length <= 128 * 1024 ? JSON.parse(raw) : [];
        if (Array.isArray(incoming)) saved = [...incoming, ...saved];
      } catch {
        // Invalid bookmark metadata cannot change the selected host or authentication.
      }
      fragment.delete('pi-web-hosts');
      const url = new SvelteURL(window.location.href);
      url.hash = fragment.toString();
      window.history.replaceState(null, '', url.href);
    }
    hosts = mergeHosts(saved);
    save();
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<button
  type="button"
  class="host-heading"
  aria-label="切换主机"
  aria-describedby="remote-current-host"
  aria-haspopup="dialog"
  onclick={() => {
    error = '';
    dialog.showModal();
  }}
>
  <strong>{title}</strong>
  <small
    ><span id="remote-current-host" title={hostname}
      >{subtitle ? subtitle + ' · ' : ''}{hostname}</span
    >{@html icon(ChevronDown, {
      size: 14,
    })}</small
  >
</button>

<dialog class="host-dialog" aria-label="主机" bind:this={dialog}>
  <header>
    <h2>主机</h2>
    <button type="button" aria-label="关闭" onclick={() => dialog.close()}>{@html icon(X)}</button>
  </header>
  <div class="host-list">
    {#each hosts as host (host.url)}
      <div class="host-row">
        <button type="button" class="host-destination" onclick={() => visit(host.url)}>
          <strong>{host.name}</strong><small>{host.url}</small>
          {#if host.url === origin}<small>当前主机</small>{/if}
        </button>
        {#if host.url !== origin}
          <button
            type="button"
            aria-label={`移除 ${host.name}`}
            onclick={() => {
              hosts = hosts.filter((item) => item.url !== host.url);
              save();
            }}>{@html icon(X, { size: 16 })}</button
          >
        {/if}
      </div>
    {/each}
  </div>
  <form onsubmit={add}>
    <label
      >主机地址<input
        type="url"
        required
        maxlength="2048"
        placeholder="https://computer.tailnet.ts.net"
        bind:value={address}
      /></label
    >
    <label>名称（可选）<input maxlength="200" bind:value={name} /></label>
    <p>切换时仅携带地址和名称。各主机的登录状态和会话相互独立。</p>
    {#if error}<p role="alert">{error}</p>{/if}
    <button type="submit">保存主机</button>
  </form>
</dialog>

<style>
  .host-heading {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    padding: 0;
    border: 0;
    text-align: left;
    background: transparent;
  }
  .host-heading strong,
  .host-heading small > span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .host-heading small {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .host-dialog {
    width: min(480px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    overflow: auto;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 24px;
    padding: 20px;
  }
  .host-dialog::backdrop {
    background: #0009;
  }
  .host-dialog header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .host-dialog h2 {
    margin: 0;
    font-size: 16px;
  }
  .host-row {
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--dim);
  }
  .host-destination {
    flex: 1;
    min-width: 0;
    padding: 12px 0;
    text-align: left;
    background: transparent;
    border: 0;
    overflow-wrap: anywhere;
  }
  .host-destination strong,
  .host-destination small {
    display: block;
  }
  .host-destination small,
  .host-dialog p {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .host-dialog label {
    display: block;
    margin-top: 12px;
  }
  .host-dialog input {
    display: block;
    width: 100%;
    margin-top: 4px;
    font-size: 16px;
  }
  .host-dialog [role='alert'] {
    color: var(--danger);
  }
</style>
