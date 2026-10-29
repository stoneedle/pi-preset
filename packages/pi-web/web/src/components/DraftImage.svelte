<script>
  import { icon, X } from '../shared/icons.js';

  let { file, onremove } = $props();
  let url = $state('');
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
    data-image-url={url}
    data-image-name={file.name}
    data-image-download={url}
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
</style>
