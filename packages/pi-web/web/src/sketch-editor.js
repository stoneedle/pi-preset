import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw,
  MainMenu,
  exportToBlob,
  hashElementsVersion,
  isInvisiblySmallElement,
  convertToExcalidrawElements,
  CaptureUpdateAction,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const sceneVersion = (elements, appState) =>
  `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}`;

// React and the editor are a lazy island; Svelte owns the modal and draft lifecycle.
export function mountSketch(node, { scene, onchange, onready, onerror }) {
  const root = createRoot(node);
  let api;
  let frame;
  let observedVersion = scene ? sceneVersion(scene.elements, scene.appState) : null;
  function keepTextVisible() {
    const editor = document.activeElement;
    if (!api || editor?.tagName !== 'TEXTAREA' || !node.contains(editor)) return;
    const bounds = node.getBoundingClientRect();
    const toolbar = node.querySelector('.App-toolbar-container')?.getBoundingClientRect();
    const footer = node.querySelector('footer')?.getBoundingClientRect();
    const top = Math.max(bounds.top + 12, toolbar?.bottom ? toolbar.bottom + 8 : bounds.top + 12);
    const bottom = Math.min(
      bounds.bottom - 12,
      footer?.height ? footer.top - 8 : bounds.bottom - 12,
    );
    const text = editor.getBoundingClientRect();
    const delta = text.bottom > bottom ? bottom - text.bottom : text.top < top ? top - text.top : 0;
    if (Math.abs(delta) < 1) return;
    const state = api.getAppState();
    api.updateScene({ appState: { scrollY: state.scrollY + delta / state.zoom.value } });
  }
  function scheduleTextVisibility() {
    cancelAnimationFrame(frame);
    // Let the editor's own resize observer commit its new canvas dimensions first.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(keepTextVisible);
    });
  }
  const resize = new ResizeObserver(scheduleTextVisibility);
  resize.observe(node);
  node.addEventListener('focusin', scheduleTextVisibility);
  node.addEventListener('input', scheduleTextVisibility);
  window.visualViewport?.addEventListener('resize', scheduleTextVisibility);
  root.render(
    createElement(
      Excalidraw,
      {
        langCode: 'zh-CN',
        theme: 'light',
        autoFocus: true,
        handleKeyboardGlobally: false,
        aiEnabled: false,
        validateEmbeddable: false,
        initialData: scene || {
          appState: {
            viewBackgroundColor: '#ffffff',
            currentItemFontFamily: 2,
            activeTool: { type: 'freedraw', locked: true },
          },
        },
        UIOptions: {
          tools: { image: false },
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            toggleTheme: false,
          },
        },
        excalidrawAPI: (value) => {
          api = value;
          onready();
        },
        onChange: (elements, appState, files) => {
          const version = sceneVersion(elements, appState);
          const previousVersion = observedVersion;
          observedVersion = version;
          onchange({ elements, appState, files }, version, previousVersion);
        },
      },
      createElement(MainMenu, null, createElement(MainMenu.DefaultItems.ClearCanvas)),
    ),
  );

  return {
    async addImage(file) {
      try {
        let dataURL = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const image = new Image();
        image.src = dataURL;
        await image.decode();
        if (!api) return;
        let mimeType = file.type;
        const resize = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        if (resize < 1) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(image.naturalWidth * resize);
          canvas.height = Math.round(image.naturalHeight * resize);
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          dataURL = canvas.toDataURL(mimeType, 0.9);
        }
        const state = api.getAppState();
        const scale = Math.min(
          1,
          (state.width - 48) / image.naturalWidth,
          (state.height - 48) / image.naturalHeight,
        );
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        const [element] = convertToExcalidrawElements([
          {
            type: 'image',
            fileId: id,
            status: 'saved',
            x: -state.scrollX + (state.width / state.zoom.value - width) / 2,
            y: -state.scrollY + (state.height / state.zoom.value - height) / 2,
            width,
            height,
          },
        ]);
        api.addFiles([{ id, dataURL, mimeType, created: Date.now() }]);
        api.updateScene({
          elements: [...api.getSceneElements(), element],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.setActiveTool({ type: 'freedraw' });
      } catch (error) {
        onerror(`无法添加图片：${error.message}`);
      }
    },
    async exportImage() {
      // Commit the native text editor before reading the scene for export.
      node.querySelector('textarea')?.blur();
      await new Promise(requestAnimationFrame);
      // Export owns a fixed snapshot, not mutable scene objects that can change
      // while fonts or canvas.toBlob are completing asynchronously.
      const allElements = structuredClone(api.getSceneElementsIncludingDeleted());
      const elements = allElements.filter(
        (element) => !element.isDeleted && !isInvisiblySmallElement(element),
      );
      const appState = { ...api.getAppState() };
      const files = { ...api.getFiles() };
      const version = sceneVersion(allElements, appState);
      if (appState.pendingImageElementId) throw new Error('先放置图片，再完成草图。');
      if (!elements.length) throw new Error('先画点什么，或添加一张图片。');
      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportBackground: true,
          exportWithDarkMode: false,
          exportEmbedScene: false,
        },
        files,
        mimeType: 'image/png',
        getDimensions: (width, height) => {
          // Draw in comfortable screen-sized coordinates, but rasterize from
          // the source image at a useful output resolution.
          const scale = 1600 / Math.max(width, height);
          return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
        },
        exportPadding: 24,
      });
      if (!blob) throw new Error('图片生成失败，请重试。');
      return {
        image: new File([blob], `草图-${Date.now()}.png`, { type: 'image/png' }),
        version,
        scene: { elements: allElements, appState, files },
      };
    },
    destroy() {
      api = null;
      cancelAnimationFrame(frame);
      resize.disconnect();
      node.removeEventListener('focusin', scheduleTextVisibility);
      node.removeEventListener('input', scheduleTextVisibility);
      window.visualViewport?.removeEventListener('resize', scheduleTextVisibility);
      root.unmount();
    },
  };
}
