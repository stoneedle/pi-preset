<script>
  import { onMount } from 'svelte';
  import { icon, X, ImagePlus, Check, LoaderCircle } from '../shared/icons.js';
  import { saveSketchScene, finishSketch } from '../remote-drafts.svelte.js';

  let { composer, onclose } = $props();
  let dialog;
  let host;
  let imageInput;
  let controller;
  let ready = $state(false);
  let busy = $state(false);
  let error = $state('');
  let disposed = false;

  async function load() {
    error = '';
    try {
      const { mountSketch } = await import('../sketch-editor.js');
      if (disposed) return;
      controller = mountSketch(host, {
        scene: composer.sketch?.scene,
        onchange: (scene, version) => {
          if (!disposed) saveSketchScene(composer, scene, version);
        },
        onready: () => (ready = true),
        onerror: (message) => (error = message),
      });
    } catch (err) {
      if (!disposed) error = `画布加载失败：${err.message}`;
    }
  }
  async function addImage(event) {
    const file = event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!file || !ready || busy) return;
    busy = true;
    error = '';
    try {
      await controller.addImage(file);
    } finally {
      busy = false;
    }
  }
  async function done() {
    if (!ready || busy) return;
    busy = true;
    error = '';
    try {
      const exported = await controller.exportImage();
      if (disposed) return;
      finishSketch(composer, exported);
      dialog.close();
    } catch (err) {
      if (!disposed) error = err.message;
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    composer.picking = true;
    dialog.showModal();
    load();
    return () => {
      disposed = true;
      controller?.destroy();
      dialog.close();
      composer.picking = false;
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  class="sketch-editor"
  aria-label="画图"
  bind:this={dialog}
  onclose={(event) => {
    event.stopPropagation();
    onclose();
  }}
  oncancel={(event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) dialog.close();
  }}
>
  <header>
    <button
      type="button"
      aria-label="关闭画图并保留草图"
      disabled={busy}
      onclick={() => dialog.close()}>{@html icon(X)}</button
    >
    <strong>画图</strong>
    <button
      class="add-image"
      type="button"
      aria-label="添加图片到画布"
      disabled={!ready || busy}
      onclick={() => imageInput.click()}>{@html icon(ImagePlus)}<span>图片</span></button
    >
    <button class="done" type="button" disabled={!ready || busy} onclick={done} aria-busy={busy}
      >{@html icon(busy ? LoaderCircle : Check, { size: 18 })}完成</button
    >
  </header>
  {#if error}
    <div class="sketch-error" role="alert">
      {error}{#if !ready}<button type="button" onclick={load}>重试</button>{/if}
    </div>
  {/if}
  <div class="sketch-host" inert={busy} bind:this={host}></div>
  {#if !ready && !error}<div class="sketch-loading" role="status">正在准备画布…</div>{/if}
  <input
    bind:this={imageInput}
    type="file"
    accept="image/png,image/jpeg,image/gif,image/webp"
    aria-label="选择画布图片"
    onchange={addImage}
  />
</dialog>

<style>
  .sketch-editor {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    width: 100vw;
    max-width: none;
    height: var(--remote-height, 100dvh);
    max-height: var(--remote-height, 100dvh);
    margin: 0;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
      env(safe-area-inset-left);
    border: 0;
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
    overflow: hidden;
  }
  .sketch-editor::backdrop {
    background: var(--surface);
  }
  header {
    display: flex;
    align-items: center;
    flex: none;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--dim);
  }
  header strong {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    font-weight: 550;
  }
  header button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    flex: none;
    min-width: 44px;
    min-height: 44px;
    padding: 0 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    font-size: 14px;
  }
  header button:disabled {
    opacity: 0.4;
  }
  header .done {
    background: var(--accent);
    color: white;
  }
  .sketch-host {
    flex: 1;
    position: relative;
    min-height: 0;
    min-width: 0;
    background: white;
    color: #1b1b1f;
    color-scheme: light;
    isolation: isolate;
  }
  .sketch-host :global(.default-sidebar-trigger),
  .sketch-host :global(.HintViewer) {
    display: none;
  }
  .sketch-loading {
    position: absolute;
    inset: 64px 16px 0;
    display: grid;
    place-items: center;
    color: var(--muted);
    pointer-events: none;
    font-size: 14px;
  }
  .sketch-error {
    flex: none;
    max-height: 80px;
    overflow: auto;
    padding: 6px 16px;
    color: var(--danger);
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .sketch-error button {
    min-height: 44px;
    margin-left: 8px;
    border: 0;
    background: transparent;
    color: var(--link);
  }
  input {
    display: none;
  }
</style>
