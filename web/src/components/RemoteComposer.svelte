<script>
  import { icon, Plus, ArrowUp, Square, X } from '../shared/icons.js';
  import ModelPicker from './ModelPicker.svelte';

  let {
    composer,
    canSend = true,
    running = false,
    onsend,
    onstop,
    oninput,
    onfocus,
    onmodelopen,
    onmodel,
    onthinking,
    onspeed,
    models = [],
    status = {},
    modelsLoading = false,
    modelsError = '',
    textarea = $bindable(null),
    draftMode = false,
  } = $props();
  function grow(node) {
    const resize = () => {
      const scrollTop = node.scrollTop;
      const atEnd = node.selectionEnd === node.value.length;
      node.style.height = 'auto';
      node.style.height = node.scrollHeight + node.offsetHeight - node.clientHeight + 'px';
      node.scrollTop = atEnd ? node.scrollHeight : scrollTop;
    };
    let width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    observer.observe(node);
    resize();
    return { update: resize, destroy: () => observer.disconnect() };
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<form class="composer-shell" onsubmit={onsend}>
  {#if composer.images.length}<div class="remote-images">
      {#each composer.images as image (image)}
        <button
          type="button"
          title={image.name}
          aria-label={'移除 ' + image.name}
          onclick={() => (composer.images = composer.images.filter((item) => item !== image))}
        >
          <span>{image.name}</span>{@html icon(X, { size: 14 })}
        </button>
      {/each}
    </div>{/if}
  <textarea
    bind:this={textarea}
    aria-label="给 Pi 发消息…"
    placeholder="给 Pi 发消息…"
    rows="1"
    bind:value={composer.text}
    use:grow={composer.text}
    {oninput}
    {onfocus}
  ></textarea>
  <div class="remote-actions">
    <label class="remote-attach" aria-label="拍照或选择图片" title="添加图片">
      {@html icon(Plus, { size: 26 })}<input
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        onchange={(event) => {
          composer.images = [...composer.images, ...event.currentTarget.files];
          event.currentTarget.value = '';
        }}
      />
    </label>
    <div class="composer-model">
      <ModelPicker
        model={status.model}
        name={status.modelName}
        allowDefaultSpeed={draftMode}
        provider={status.provider}
        thinking={status.thinking}
        fast={status.fast ?? null}
        {models}
        loading={modelsLoading}
        error={modelsError}
        disabled={status.disabled || composer.sending}
        onopen={onmodelopen}
        {onmodel}
        {onthinking}
        {onspeed}
      />
    </div>
    {#if running}<button
        class="composer-stop"
        type="button"
        aria-label="停止主代理"
        onclick={onstop}>{@html icon(Square, { size: 17 })}</button
      >{/if}
    <button
      class="composer-send"
      type="submit"
      disabled={!canSend || composer.sending || (!composer.text.trim() && !composer.images.length)}
      aria-label="发送"
    >
      {@html icon(ArrowUp, { size: 23 })}
    </button>
  </div>
</form>

<style>
  .composer-shell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 12px 12px 8px;
    border: 1px solid color-mix(in srgb, var(--dim) 65%, transparent);
    border-radius: 28px;
    background: var(--composer-bg);
    box-shadow: var(--floating-shadow);
  }
  textarea {
    display: block;
    resize: none;
    width: 100%;
    min-height: 40px;
    max-height: max(40px, min(240px, calc(var(--remote-height, 100dvh) * 0.24)));
    border: 0;
    border-radius: 0;
    outline: none;
    background: transparent;
    padding: 3px 8px 10px;
    font-size: 16px;
    line-height: 1.5;
    overflow-y: auto;
  }
  textarea::placeholder {
    color: var(--muted);
  }
  .remote-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: none;
    min-width: 0;
  }
  .remote-attach {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    min-height: 40px;
    cursor: pointer;
    border-radius: 50%;
  }
  .remote-attach:focus-within {
    outline: 2px solid var(--accent);
  }
  .remote-attach input {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
    padding: 0;
    min-height: 0;
    opacity: 0;
  }
  .composer-model {
    flex: 1;
    min-width: 0;
    display: flex;
    justify-content: flex-end;
  }
  .remote-actions > button {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    min-height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
  }
  .composer-send {
    color: white;
    background: var(--accent);
  }
  .composer-send:disabled {
    color: var(--body-bg);
    background: var(--muted);
    opacity: 0.32;
  }
  .composer-stop {
    color: var(--body-bg);
    background: var(--text);
  }
  .composer-stop :global(svg) {
    fill: currentColor;
  }
  .remote-images {
    display: flex;
    gap: 6px;
    flex: none;
    padding: 0 4px 8px;
    overflow-x: auto;
    max-height: 74px;
  }
  .remote-images button {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    max-width: 240px;
    flex: none;
    padding: 6px 10px;
    border: 1px solid var(--dim);
    border-radius: 12px;
    background: var(--surface);
    font-size: 12px;
  }
  .remote-images span {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .remote-images :global(svg) {
    flex: none;
  }
  @media (max-width: 350px) {
    .composer-shell {
      padding: 10px 8px 6px;
    }
    .remote-actions {
      gap: 4px;
    }
    .remote-attach {
      width: 30px;
    }
  }
</style>
