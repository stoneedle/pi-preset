<script>
  let { sessionId, entry, index } = $props();
  let open = $state(false);
  let failed = $state(false);
  let attempt = $state(0);
  const url = $derived(
    `/api/session/image?${new URLSearchParams({ id: sessionId, entry, index })}`,
  );
</script>

<div class="remote-block">
  <div class="remote-image-actions">
    <button type="button" aria-expanded={open} onclick={() => (open = !open)}>打开图片</button>
    <a href={`${url}&download=1`} download target="_blank" rel="noreferrer">下载</a>
  </div>
  {#if open}
    {#if failed}
      <p role="alert">
        图片不可用。<button
          type="button"
          onclick={() => {
            attempt++;
            failed = false;
          }}>重试</button
        >
      </p>
    {:else}
      <a href={url} target="_blank" rel="noreferrer">
        <img src={`${url}&attempt=${attempt}`} alt="打开图片" onerror={() => (failed = true)} />
      </a>
    {/if}
  {/if}
</div>
