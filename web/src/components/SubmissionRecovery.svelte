<script>
  import { icon, CircleAlert, ChevronDown, X } from '../shared/icons.js';
  import { restoreSubmission, discardRecovery } from '../remote-drafts.svelte.js';

  let { composer, item, onedit } = $props();
  let images = $state([]);
  let expanded = $state(false);
  const label = $derived(
    item.state === 'draft'
      ? '另一份草稿已暂存'
      : item.state === 'failed'
        ? item.delivery === 'followUp'
          ? '排队失败'
          : '发送失败'
        : item.delivery === 'followUp'
          ? '未确认是否排队成功'
          : '未确认是否发送成功',
  );
  $effect(() => {
    const loaded = item.images.map((file) => ({ file, url: URL.createObjectURL(file) }));
    images = loaded;
    return () => loaded.forEach(({ url }) => URL.revokeObjectURL(url));
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<div class="submission-recovery" data-recovery-message={item.id} data-state={item.state}>
  <button
    class="recovery-toggle"
    type="button"
    aria-label={label}
    title={item.error ? `${label}：${item.error}` : label}
    aria-expanded={expanded}
    aria-controls={`recovery-${item.id}`}
    onclick={() => (expanded = !expanded)}
  >
    {@html icon(CircleAlert, { size: 15 })}<span role="status">{label}</span>
    {@html icon(ChevronDown, { size: 13 })}
  </button>
  <button
    type="button"
    disabled={composer.sending}
    onclick={() => {
      if (restoreSubmission(composer, item.id)) onedit();
    }}>{item.state === 'draft' ? '继续编辑' : '重新编辑'}</button
  >
  <button
    class="recovery-dismiss"
    type="button"
    aria-label={item.state === 'draft' ? '丢弃这份草稿' : '忽略这条消息'}
    title={item.state === 'draft' ? '丢弃这份草稿' : '忽略这条消息'}
    onclick={() => discardRecovery(composer, item.id)}>{@html icon(X, { size: 15 })}</button
  >
  {#if expanded}
    <div class="recovery-preview" id={`recovery-${item.id}`}>
      {#if item.error}<p class="recovery-error">{item.error}</p>{/if}
      <div class="recovery-text">{item.text}</div>
      {#each images as image (image.file)}
        <a href={image.url} download={image.file.name}>保存图片：{image.file.name}</a>
      {/each}
      {#if item.state !== 'draft'}<p>重新编辑不会自动发送，当前草稿会另行暂存。</p>{/if}
      {#if item.delivery === 'followUp'}<p>需要排队时，请长按发送按钮选择“排队”。</p>{/if}
    </div>
  {/if}
</div>

<style>
  .submission-recovery {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 36px;
    align-items: start;
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .recovery-toggle {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 40px;
    padding-left: 0;
    color: var(--muted);
  }
  .recovery-toggle span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .recovery-toggle :global(svg) {
    flex: none;
  }
  .recovery-toggle[aria-expanded='true'] :global(svg:last-child) {
    transform: rotate(180deg);
  }
  button {
    min-height: 40px;
    padding: 0 5px;
    border: 0;
    background: transparent;
    color: var(--link);
    font-size: inherit;
    white-space: nowrap;
  }
  .recovery-dismiss {
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .recovery-preview {
    grid-column: 1 / -1;
    padding: 0 4px 8px;
    overflow-wrap: anywhere;
  }
  .recovery-text {
    white-space: pre-wrap;
    color: var(--text-soft);
    user-select: text;
  }
  .recovery-preview a {
    display: block;
    padding: 6px 0;
  }
  p {
    margin: 0 0 6px;
  }
  .recovery-error {
    color: var(--danger);
  }
</style>
