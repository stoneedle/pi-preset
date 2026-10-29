<script>
  import { onMount } from 'svelte';
  import PhotoSwipe from 'photoswipe';
  import 'photoswipe/style.css';
  import { icon, X, Download, ZoomIn, ZoomOut } from '../shared/icons.js';

  let dialog;
  let canvas;
  let header;
  let current = $state(null);
  let loading = $state(false);
  let error = $state('');
  let ready = $state(false);
  let zoomed = $state(false);
  let viewer;
  let pendingImage;
  let generation = 0;

  function clear() {
    generation++;
    if (pendingImage) {
      pendingImage.onload = pendingImage.onerror = null;
      pendingImage.src = '';
      pendingImage = null;
    }
    viewer?.destroy();
    viewer = null;
    current = null;
    loading = ready = zoomed = false;
    error = '';
  }

  function load() {
    const epoch = ++generation;
    loading = true;
    error = '';
    const image = new Image();
    pendingImage = image;
    image.alt = current.name;
    image.onerror = () => {
      if (epoch !== generation) return;
      pendingImage = null;
      loading = false;
      error = '图片加载失败，请重试。';
    };
    image.onload = () => {
      if (epoch !== generation) return;
      pendingImage = null;
      image.onload = image.onerror = null;
      viewer = new PhotoSwipe({
        dataSource: [
          {
            src: current.url,
            width: image.naturalWidth,
            height: image.naturalHeight,
            alt: current.name,
          },
        ],
        appendToEl: canvas,
        getViewportSizeFn: () => ({ x: dialog.clientWidth, y: dialog.clientHeight }),
        paddingFn: () => ({ top: header.offsetHeight, bottom: 0, left: 0, right: 0 }),
        bgOpacity: 1,
        close: false,
        zoom: false,
        counter: false,
        arrowPrev: false,
        arrowNext: false,
        preloader: false,
        escKey: false,
        trapFocus: false,
        returnFocus: false,
        pinchToClose: false,
        closeOnVerticalDrag: false,
        wheelToZoom: true,
        imageClickAction: 'zoom',
        tapAction: false,
        bgClickAction: false,
        showHideAnimationType: 'none',
        zoomAnimationDuration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200,
      });
      // Reuse the original already loaded for its dimensions; do not download it twice.
      viewer.on('contentLoad', (event) => {
        event.preventDefault();
        image.className = 'pswp__img';
        event.content.element = image;
      });
      viewer.on('contentLoadImage', (event) => {
        event.preventDefault();
        event.content.onLoaded();
      });
      viewer.on('afterInit', () => viewer.element.removeAttribute('role'));
      viewer.on('zoomPanUpdate', () => {
        const slide = viewer.currSlide;
        zoomed = slide.currZoomLevel > slide.zoomLevels.initial + 0.001;
      });
      viewer.init();
      loading = false;
      ready = true;
    };
    image.src = current.url;
  }

  onMount(() => {
    const open = (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const trigger = event.target.closest?.('[data-image-url]');
      if (!trigger) return;
      event.preventDefault();
      clear();
      current = {
        url: trigger.dataset.imageUrl,
        name: trigger.dataset.imageName || '图片',
        download: trigger.dataset.imageDownload || trigger.dataset.imageUrl,
        source: trigger.dataset.imageSource,
      };
      dialog.showModal();
      load();
    };
    const observer = new ResizeObserver(() => viewer?.updateSize(true));
    observer.observe(dialog);
    window.addEventListener('click', open);
    return () => {
      observer.disconnect();
      window.removeEventListener('click', open);
      clear();
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  class="image-viewer"
  aria-label={'图片预览：' + (current?.name || '图片')}
  bind:this={dialog}
  onclose={clear}
>
  <div class="image-viewer-canvas" bind:this={canvas}></div>
  <header bind:this={header}>
    <span title={current?.name}>{current?.name}</span>
    {#if current?.source}<a href={current.source} target="_blank" rel="noreferrer">原文</a>{/if}
    <button
      type="button"
      aria-label={zoomed ? '适应屏幕' : '放大图片'}
      title={zoomed ? '适应屏幕' : '放大图片'}
      disabled={!ready}
      onclick={() => viewer.toggleZoom()}
    >
      {@html icon(zoomed ? ZoomOut : ZoomIn)}
    </button>
    <a
      href={current?.download}
      download={current?.name}
      aria-label="下载原图"
      title="下载原图"
      target="_blank"
      rel="noreferrer">{@html icon(Download)}</a
    >
    <button type="button" aria-label="关闭图片预览" title="关闭" onclick={() => dialog.close()}
      >{@html icon(X)}</button
    >
  </header>
  {#if loading}<div class="image-viewer-status" role="status">加载中…</div>{/if}
  {#if error}<div class="image-viewer-status">
      <p role="alert">{error}</p>
      <button type="button" onclick={load}>重试</button>
    </div>{/if}
</dialog>

<style>
  .image-viewer {
    position: fixed;
    inset: 0;
    width: 100vw;
    max-width: none;
    height: var(--remote-height, 100dvh);
    max-height: var(--remote-height, 100dvh);
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: 0;
    background: var(--surface-2);
    color: var(--text);
  }
  .image-viewer::backdrop {
    background: var(--surface-2);
  }
  .image-viewer-canvas {
    position: absolute;
    inset: 0;
  }
  .image-viewer-canvas :global(.pswp) {
    --pswp-root-z-index: 0;
    --pswp-bg: var(--surface-2);
    position: absolute;
  }
  header {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 8px
      max(12px, env(safe-area-inset-left));
    background: var(--surface);
  }
  header span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  header button,
  header a {
    display: grid;
    place-items: center;
    flex: none;
    min-width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    text-decoration: none;
  }
  .image-viewer-status {
    position: absolute;
    inset: 64px 16px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 14px;
  }
  .image-viewer-status button {
    border: 0;
    background: transparent;
    color: var(--link);
  }
</style>
