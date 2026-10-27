<script>
  import { onDestroy, untrack } from 'svelte';
  import { icon, X, LoaderCircle } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import CopyAction from './CopyAction.svelte';
  import Markdown from './Markdown.svelte';

  let { sessionId, status = {}, known = false } = $props();
  let dialog = $state(null);
  let opened = $state(false);
  let mode = $state('details');
  let details = $state(null);
  let loading = $state(false);
  let error = $state('');
  let submitError = $state('');
  let instructions = $state('');
  let submitting = $state(false);
  let controller;
  const leaf = $derived(status.leafId);
  const compacting = $derived(known && status.compaction?.running === true);
  const canCompact = $derived(known && status.canCompact === true && !submitting);
  const fields = $derived([
    { label: 'Session ID', value: details?.sessionId || status.sessionId },
    { label: '会话文件', value: details?.sessionFile },
    { label: '工作目录', value: details?.cwd || status.cwd },
  ]);
  const endpoint = (path) => `${path}?id=${encodeURIComponent(sessionId)}`;

  export function open(action = 'details') {
    mode = action;
    opened = true;
    dialog.showModal();
  }

  function close() {
    opened = false;
    controller?.abort();
    dialog?.close();
  }

  async function read() {
    controller?.abort();
    const active = new AbortController();
    controller = active;
    loading = true;
    error = '';
    try {
      const data = await request(endpoint('/api/session/details'), { signal: active.signal });
      if (!active.signal.aborted) details = data;
    } catch (err) {
      if (!active.signal.aborted) error = err.message;
    } finally {
      if (!active.signal.aborted) loading = false;
    }
  }

  $effect(() => {
    if (!opened) return;
    leaf;
    if (!compacting) untrack(read);
  });

  async function compact(event) {
    event.preventDefault();
    if (!canCompact) return;
    submitting = true;
    submitError = '';
    try {
      await request(endpoint('/api/session/compact'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructions: instructions }),
      });
    } catch (err) {
      submitError = err.message;
    } finally {
      submitting = false;
    }
  }

  onDestroy(() => controller?.abort());
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  class="session-tools"
  bind:this={dialog}
  aria-label={mode === 'details' ? '会话详情' : '压缩上下文'}
  onclose={close}
>
  <header>
    <h2>{mode === 'details' ? '会话详情' : '压缩上下文'}</h2>
    <button type="button" aria-label="关闭会话工具" onclick={close}
      >{@html icon(X, { size: 20 })}</button
    >
  </header>
  <div class="session-tools-body">
    {#if mode === 'details'}
      <dl>
        {#each fields as field (field.label)}
          <div class="session-field">
            <div>
              <dt>{field.label}</dt>
              <dd>{field.value || '暂不可用'}</dd>
            </div>
            {#if field.value}<div role="group" aria-label={'复制' + field.label}>
                <CopyAction text={field.value} />
              </div>{/if}
          </div>
        {/each}
      </dl>
      {#if known && status.model}<p class="session-model">
          {status.provider} / {status.model}
        </p>{/if}
      {#if details?.createdAt}<p class="session-created">
          创建于 {new Date(details.createdAt).toLocaleString('zh-CN')}
        </p>{/if}
      <button class="compact-entry" type="button" onclick={() => (mode = 'compact')}
        >压缩上下文</button
      >
    {:else}
      <form onsubmit={compact}>
        <label for="compact-instructions">重点保留什么（可选）</label>
        <textarea
          id="compact-instructions"
          rows="3"
          bind:value={instructions}
          disabled={compacting || submitting}
          placeholder="例如：保留已确定的方案和未完成事项"
        ></textarea>
        <p class="compact-note">只缩减发送给模型的上下文，原始会话记录仍保留。</p>
        <button
          type="submit"
          class="compact-submit"
          disabled={!canCompact}
          aria-busy={compacting || submitting}
        >
          {#if compacting || submitting}<span class="compact-spinner"
              >{@html icon(LoaderCircle, { size: 17 })}</span
            >{/if}
          {compacting ? '正在压缩…' : submitting ? '提交中…' : '压缩上下文'}
        </button>
        {#if !known}<p class="compact-note">
            连接 Pi 后可压缩上下文。
          </p>{:else if !canCompact && !compacting && !submitting}<p class="compact-note">
            等待 Pi 空闲，且当前实例支持压缩控制后可用。
          </p>{/if}
        {#if submitError || (known && status.compaction?.error)}<p
            class="session-error"
            role="alert"
          >
            {submitError || status.compaction.error}
          </p>{/if}
      </form>
      {#if details?.compaction}
        <section aria-label="上次压缩摘要">
          <h3>上次压缩摘要</h3>
          <p class="compact-note">
            压缩前 {details.compaction.tokensBefore.toLocaleString('zh-CN')} token{#if details.compaction.estimatedTokensAfter !== null}
              → 估计 {details.compaction.estimatedTokensAfter.toLocaleString('zh-CN')} token{/if}
          </p>
          <Markdown text={details.compaction.summary} {sessionId} />
        </section>
      {/if}
    {/if}
    {#if loading && !details}<p role="status">加载中…</p>{/if}
    {#if error}<div class="session-error" role="alert">
        {error}<button type="button" onclick={read}>重试</button>
      </div>{/if}
  </div>
</dialog>

<style>
  .session-tools {
    position: fixed;
    inset: auto 12px calc(100dvh - var(--remote-height, 100dvh) + 12px);
    margin: 0 auto;
    width: min(560px, calc(100vw - 24px));
    max-width: none;
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    padding: 0;
    border: 1px solid var(--dim);
    border-radius: 20px;
    background: var(--body-bg);
    color: var(--text);
  }
  .session-tools::backdrop {
    background: #0009;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px 8px 20px;
    background: var(--body-bg);
  }
  h2 {
    margin: 0;
    font-size: 17px;
  }
  header button {
    display: grid;
    place-items: center;
    width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
  }
  .session-tools-body {
    padding: 0 20px 20px;
  }
  dl {
    margin: 0;
  }
  .session-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
  }
  .session-field > div:first-child {
    flex: 1;
    min-width: 0;
  }
  .session-field > div:last-child {
    flex-shrink: 0;
  }
  .session-field :global(button) {
    min-width: 44px;
    min-height: 44px;
  }
  dt {
    margin-bottom: 6px;
    color: var(--text-soft);
    font-size: 12px;
  }
  dd {
    margin: 0;
    font-size: 14px;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .session-created,
  .session-model,
  .compact-note {
    color: var(--text-soft);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .compact-entry,
  .compact-submit {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    margin-top: 16px;
  }
  .compact-submit {
    color: var(--body-bg);
    background: var(--text);
    border-color: transparent;
  }
  label {
    display: block;
    margin: 8px 0;
    font-size: 14px;
  }
  textarea {
    width: 100%;
    min-height: 88px;
    max-height: calc(var(--remote-height, 100dvh) * 0.3);
    resize: vertical;
    font-size: 16px;
  }
  section {
    margin-top: 28px;
  }
  h3 {
    margin: 0;
    font-size: 15px;
  }
  .session-error {
    color: var(--danger);
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .session-error > button {
    display: block;
    min-height: 44px;
    margin-top: 8px;
  }
  .compact-spinner {
    display: inline-flex;
    animation: compact-spin 1s linear infinite;
  }
  @keyframes compact-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .compact-spinner {
      animation: none;
    }
  }
</style>
