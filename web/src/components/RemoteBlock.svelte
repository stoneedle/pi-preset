<script>
  import { untrack } from 'svelte';
  import { t } from '../shared/i18n.js';
  import { request } from '../remote-api.js';
  let { sessionId, entryId, block } = $props();
  let open = $state(false);
  let loading = $state(false);
  let body = $state(null);
  let error = $state('');
  let bodyState = $state(null);

  $effect(() => {
    if (open && body && bodyState !== block.state) untrack(load);
  });

  const imageURL = (entry, index) =>
    `/api/session/image?id=${encodeURIComponent(sessionId)}&entry=${encodeURIComponent(entry)}&index=${index}`;

  function toggle() {
    open = !open;
    if (open) load();
  }

  async function load() {
    if (loading || block.type === 'image' || (body && bodyState === block.state)) return;
    const requestedState = block.state;
    loading = true;
    error = '';
    try {
      body = await request(
        `/api/session/block?id=${encodeURIComponent(sessionId)}&entry=${encodeURIComponent(entryId)}&index=${block.index}`,
      );
      bodyState = requestedState;
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="remote-block" class:remote-block-error={block.state === 'error'}>
  <button type="button" class="remote-block-toggle" aria-expanded={open} onclick={toggle}>
    <span>{block.type === 'tool' ? block.name : t(`remote.${block.type}`)}</span>
    {#if block.summary}<span class="remote-block-summary">{block.summary}</span>{/if}
    {#if block.state}<span>{t(`remote.tool.${block.state}`)}</span>{/if}
  </button>
  {#if open}
    {#if block.type === 'image'}
      <a href={imageURL(entryId, block.index)} target="_blank" rel="noreferrer">
        <img src={imageURL(entryId, block.index)} alt={t('remote.image')} />
      </a>
    {:else if loading}
      <p>{t('remote.loading')}</p>
    {:else if error}
      <p role="alert">{error}</p>
    {:else if body}
      {#if body.input}<pre>{JSON.stringify(body.input, null, 2)}</pre>{/if}
      {#if body.text}<pre>{body.text}</pre>{/if}
      {#if body.details}<pre>{JSON.stringify(body.details, null, 2)}</pre>{/if}
      {#each body.images || [] as image (image.entry + ':' + image.index)}
        <a href={imageURL(image.entry, image.index)} target="_blank" rel="noreferrer"
          >{t('remote.image')}</a
        >
      {/each}
    {/if}
  {/if}
</div>
