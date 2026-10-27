<script>
  import { icon, X } from '../shared/icons.js';

  let { file, onremove } = $props();
  let url = $state('');
  let preview;
  let expanded = $state(false);
  $effect(() => {
    const next = URL.createObjectURL(file);
    url = next;
    return () => URL.revokeObjectURL(next);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<div class="draft-image">
  <button
    class="draft-image-preview"
    type="button"
    aria-label={'查看图片：' + file.name}
    aria-haspopup="dialog"
    title={file.name}
    onclick={() => {
      expanded = true;
      preview.showModal();
    }}
  >
    <img class="draft-image-thumbnail" src={url} alt={file.name} width="56" height="56" />
  </button>
  <button
    class="draft-image-remove"
    type="button"
    aria-label={'移除 ' + file.name}
    onclick={onremove}
  >
    {@html icon(X, { size: 16 })}
  </button>
  <dialog
    aria-label={'图片预览：' + file.name}
    bind:this={preview}
    onclose={() => (expanded = false)}
  >
    <header>
      <span title={file.name}>{file.name}</span>
      <a href={url} download={file.name}>下载</a>
      <button
        class="draft-image-close"
        type="button"
        aria-label="关闭图片预览"
        onclick={() => preview.close()}
      >
        {@html icon(X, { size: 20 })}
      </button>
    </header>
    {#if expanded}<div class="draft-image-body"><img src={url} alt={file.name} /></div>{/if}
  </dialog>
</div>

<style>
  .draft-image {
    position: relative;
    flex: none;
    padding: 4px;
  }
  button {
    border: 0;
    background: transparent;
  }
  .draft-image-preview {
    display: block;
    padding: 0;
    overflow: hidden;
    border-radius: 10px;
  }
  .draft-image-thumbnail {
    display: block;
    flex: none;
    object-fit: contain;
    background: var(--surface-2);
  }
  span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .draft-image-remove {
    position: absolute;
    top: 0;
    right: 0;
    display: grid;
    place-items: center;
    width: 28px;
    min-height: 28px;
    padding: 0;
    border: 2px solid var(--composer-bg);
    border-radius: 50%;
    background: #000b;
    color: white;
  }
  .draft-image-close {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    min-height: 44px;
    padding: 0;
    color: var(--muted);
  }
  dialog {
    position: fixed;
    inset: 0;
    width: 100vw;
    max-width: none;
    height: var(--remote-height, 100dvh);
    max-height: var(--remote-height, 100dvh);
    margin: 0;
    padding: 12px;
    border: 0;
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--popover-shadow);
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
  }
  dialog::backdrop {
    background: #0009;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 14px;
  }
  .draft-image-close {
    width: 44px;
  }
  header span {
    flex: 1;
  }
  header a {
    display: inline-flex;
    align-items: center;
    flex: none;
    min-height: 44px;
  }
  .draft-image-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .draft-image-body img {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
