<script>
  import { fileDownloadURL, fileName, isWebFile } from '../remote-files.js';

  let { sessionId, entry, index, path = '', name = '' } = $props();
  let failed = $state(false);
  let attempt = $state(0);
  const url = $derived(
    path
      ? `${fileDownloadURL(sessionId, path)}&inline=1`
      : `/api/session/image?${new URLSearchParams({ id: sessionId, entry, index })}`,
  );
  const downloadURL = $derived(path ? fileDownloadURL(sessionId, path) : `${url}&download=1`);
  const previewName = $derived(name || (path ? fileName(path) : '图片'));
</script>

<span class="remote-block remote-image">
  <a
    class="remote-image-preview"
    href={url}
    data-image-url={url}
    data-image-name={previewName}
    data-image-download={downloadURL}
    data-image-source={isWebFile(path) ? path : undefined}
    aria-haspopup="dialog"
    target="_blank"
    rel="noreferrer"
    aria-label="打开图片"
    title="查看原图"
  >
    {#if failed}
      <span>打开图片</span>
    {:else}
      <img
        src={`${url}&thumbnail=1&attempt=${attempt}`}
        alt="图片缩略图"
        width="96"
        height="96"
        loading="lazy"
        decoding="async"
        onerror={() => (failed = true)}
      />
    {/if}
  </a>
  {#if failed}
    <span class="remote-image-actions">
      <span role="status">缩略图不可用</span>
      <button
        type="button"
        onclick={() => {
          attempt++;
          failed = false;
        }}>重试</button
      >
    </span>
  {/if}
</span>

<style>
  .remote-image {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    margin: 4px 8px 4px 0;
    vertical-align: top;
    font-size: 12px;
  }
  .remote-image-preview {
    display: grid;
    place-items: center;
    flex: none;
    width: 96px;
    height: 96px;
    overflow: hidden;
    border-radius: 12px;
    background: var(--surface-2);
  }
  img {
    display: block;
    width: 96px;
    height: 96px;
    object-fit: contain;
  }
  .remote-image-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    color: var(--muted);
  }
  button {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 4px;
  }
  button {
    border: 0;
    background: transparent;
    color: var(--link);
    font-size: inherit;
  }
</style>
