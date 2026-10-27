<script>
  import { onDestroy } from 'svelte';
  import { icon, Copy, Check } from '../shared/icons.js';

  let { text, menu = false, inline = false, oncopy } = $props();
  let copied = $state(false);
  let error = $state('');
  let timer;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
    clearTimeout(timer);
  });

  async function copy() {
    error = '';
    try {
      await navigator.clipboard.writeText(text);
      if (disposed) return;
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1600);
      oncopy?.();
    } catch {
      if (disposed) return;
      error = '复制失败，请检查浏览器的剪贴板权限。';
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<button
  type="button"
  role={menu ? 'menuitem' : undefined}
  class:action={menu}
  class:copy-inline={inline}
  aria-label={copied ? '已复制' : '复制'}
  title={copied ? '已复制' : '复制'}
  onclick={copy}
>
  {@html icon(copied ? Check : Copy, { size: 18 })}
  {#if menu}<span>{copied ? '已复制' : '复制'}</span>{/if}
</button>
{#if error}<span class="copy-error" role="alert">{error}</span>{/if}

<style>
  .copy-inline {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--muted);
    vertical-align: middle;
  }
  .copy-inline:hover,
  .copy-inline:focus-visible {
    background: var(--surface-2);
    color: var(--text);
  }
  .copy-error {
    display: block;
    flex-basis: 100%;
    margin: 4px 0;
    color: var(--danger);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
</style>
