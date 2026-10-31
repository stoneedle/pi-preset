<script>
  import { onMount } from 'svelte';
  import {
    icon,
    X,
    ImagePlus,
    Check,
    LoaderCircle,
    Undo2,
    Redo2,
    Pencil,
    ArrowUpRight,
    Square,
    Type,
    Eraser,
    Palette,
    MousePointer2,
    Trash2,
  } from '../shared/icons.js';
  import { saveSketchScene, finishSketch } from '../remote-drafts.svelte.js';
  import ActionMenu from './ActionMenu.svelte';

  let { composer, onclose } = $props();
  const tools = [
    { type: 'freedraw', name: '画笔', icon: Pencil },
    { type: 'arrow', name: '箭头', icon: ArrowUpRight },
    { type: 'rectangle', name: '方框', icon: Square },
    { type: 'text', name: '文字', icon: Type },
    { type: 'eraser', name: '橡皮', icon: Eraser },
  ];
  const colors = [
    { value: '#1b1b1f', name: '黑色' },
    { value: '#dc2626', name: '红色' },
  ];
  const widths = [
    { value: 1, name: '细线' },
    { value: 2, name: '中等' },
  ];
  const initialStyle = { color: colors[0].value, width: widths[0].value };
  let controls = $state({ ...initialStyle, tool: 'freedraw', canUndo: false, canRedo: false });
  let dialog;
  let host;
  let imageInput;
  let settings;
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
        style: initialStyle,
        onchange: (scene, version, previousVersion) => {
          if (!disposed) saveSketchScene(composer, scene, version, previousVersion);
        },
        onready: () => (ready = true),
        oncontrols: (value) => {
          if (!disposed) controls = value;
        },
        onerror: (message) => (error = message),
      });
    } catch (err) {
      if (!disposed) error = `画布加载失败：${err.message}`;
    }
  }
  function chooseTool(type) {
    settings.close();
    controller.setTool(type);
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
    settings.close();
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
      title="关闭并保留草图"
      disabled={busy}
      onclick={() => dialog.close()}>{@html icon(X)}</button
    >
    <button
      type="button"
      aria-label="撤销"
      title="撤销"
      disabled={!ready || busy || !controls.canUndo}
      onclick={() => controller.history('undo')}>{@html icon(Undo2)}</button
    >
    <button
      type="button"
      aria-label="重做"
      title="重做"
      disabled={!ready || busy || !controls.canRedo}
      onclick={() => controller.history('redo')}>{@html icon(Redo2)}</button
    >
    <button
      class="add-image"
      type="button"
      aria-label="添加图片到画布"
      title="添加图片"
      disabled={!ready || busy}
      onclick={() => imageInput.click()}>{@html icon(ImagePlus)}</button
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
  <div class="sketch-tools" role="group" aria-label="绘图工具">
    {#each tools as tool (tool.type)}
      <button
        type="button"
        class:active={controls.tool === tool.type}
        aria-pressed={controls.tool === tool.type}
        disabled={!ready || busy}
        onclick={() => chooseTool(tool.type)}
        >{@html icon(tool.icon)}<span>{tool.name}</span></button
      >
    {/each}
    <button
      type="button"
      class="settings-trigger"
      class:active={controls.tool === 'selection'}
      aria-label="画图设置"
      aria-haspopup="menu"
      disabled={!ready || busy}
      onclick={(event) => {
        if (settings.isOpenFor(event.currentTarget)) settings.close();
        else settings.open(event.currentTarget);
      }}
      >{@html icon(controls.tool === 'selection' ? MousePointer2 : Palette)}
      <span>{controls.tool === 'selection' ? '移动' : '样式'}</span></button
    >
  </div>
  <ActionMenu bind:this={settings} label="画图设置" dismissOnAnchor={false}>
    <div class="style-options" role="group" aria-label="颜色">
      {#each colors as color (color.value)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={controls.color === color.value}
          onclick={() => controller.setStyle({ color: color.value })}
        >
          <span class="swatch" style:background={color.value}></span>{color.name}
        </button>
      {/each}
    </div>
    <div class="style-options" role="group" aria-label="线宽">
      {#each widths as width (width.value)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={controls.width === width.value}
          onclick={() => controller.setStyle({ width: width.value })}
        >
          <span class="stroke-preview" style:height={width.value + 'px'}></span>{width.name}
        </button>
      {/each}
    </div>
    <button class="action" type="button" role="menuitem" onclick={() => chooseTool('selection')}
      >{@html icon(MousePointer2)}选择／移动</button
    >
    <button
      class="action"
      type="button"
      role="menuitem"
      onclick={() => {
        settings.close();
        controller.clear();
      }}
    >
      {@html icon(Trash2)}清空画布
    </button>
  </ActionMenu>
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
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--dim);
  }
  button {
    color: inherit;
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
    border-radius: 10px;
    background: transparent;
    font-size: 14px;
  }
  button:disabled {
    opacity: 0.4;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  button:hover:not(:disabled) {
    background: var(--surface-2);
  }
  header .add-image {
    margin-left: auto;
  }
  header .done,
  header .done:hover:not(:disabled) {
    background: var(--accent);
    color: #171717;
    font-weight: 600;
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
  .sketch-tools {
    display: grid;
    grid-template-columns: repeat(6, minmax(44px, 1fr));
    align-self: center;
    width: 100%;
    max-width: 420px;
    flex: none;
    gap: 2px;
    padding: 5px 8px;
    border-top: 1px solid var(--dim);
  }
  .sketch-tools button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 52px;
    padding: 5px 0;
    border: 0;
    border-radius: 8px;
    color: var(--text-soft);
    background: transparent;
    font-size: 12px;
    line-height: 16px;
  }
  .sketch-tools button.active {
    color: var(--text);
    background: var(--surface-2);
    font-weight: 600;
  }
  .sketch-tools .settings-trigger {
    border-left: 1px solid var(--dim);
    border-radius: 0;
  }
  .style-options {
    display: flex;
    gap: 4px;
    padding: 2px 4px 4px;
  }
  .style-options button {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 8px;
    min-width: 0;
    min-height: 44px;
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    font-size: 14px;
  }
  .style-options button[aria-checked='true'] {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .swatch {
    width: 12px;
    height: 12px;
    border: 1px solid var(--muted);
    border-radius: 50%;
  }
  .stroke-preview {
    width: 18px;
    background: currentColor;
  }
  .sketch-loading {
    position: absolute;
    inset: 64px 16px;
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
