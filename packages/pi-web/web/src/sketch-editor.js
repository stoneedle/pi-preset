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
  mutateElement,
  newElementWith,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './sketch-editor.css';

const sceneVersion = (elements, appState) =>
  `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}`;

// React and the editor are a lazy island; Svelte owns the modal and draft lifecycle.
export function mountSketch(node, { scene, style, onchange, onready, oncontrols, onerror }) {
  node.classList.add('sketch-canvas');
  const root = createRoot(node);
  let api;
  let frame;
  let lastControls;
  const originalIds = new Set(scene?.elements.map((element) => element.id));
  // Excalidraw 0.18.1 multiplies freehand width by 4.25 before rendering.
  const strokeScale = (type) => (type === 'freedraw' ? 4.25 : 1);
  const strokeWidth = (type) => style.width / strokeScale(type);
  const itemStyle = (type) => ({
    currentItemStrokeWidth: strokeWidth(type),
    currentItemStrokeColor: style.color,
    currentItemRoughness: 0,
    currentItemRoundness: 'sharp',
    currentItemArrowType: 'sharp',
    currentItemStrokeStyle: 'solid',
    currentItemBackgroundColor: 'transparent',
    currentItemOpacity: 100,
    currentItemFontFamily: 2,
    currentItemFontSize: 16,
    currentItemStartArrowhead: null,
    currentItemEndArrowhead: 'arrow',
  });
  function uniformStrokes(elements) {
    for (const element of elements) {
      if (
        element.type === 'freedraw' &&
        !originalIds.has(element.id) &&
        (element.simulatePressure ||
          element.pressures.length !== element.points.length ||
          element.pressures.some((pressure) => pressure !== 0.5))
      ) {
        // Mutate through the engine so its gesture references, render cache and
        // native undo/redo remain authoritative. Existing drawings stay intact.
        mutateElement(element, {
          simulatePressure: false,
          pressures: element.points.map(() => 0.5),
        });
      }
    }
  }
  function syncControls() {
    if (!api) return;
    const state = api.getAppState();
    const selected = api
      .getSceneElements()
      .filter((element) => state.selectedElementIds[element.id] && element.type !== 'image');
    const common = (values, fallback) =>
      !values.length ? fallback : values.every((value) => value === values[0]) ? values[0] : null;
    const next = {
      tool: state.activeTool.type,
      color: common(
        selected.map((element) => element.strokeColor),
        style.color,
      ),
      width: common(
        selected
          .filter((element) => element.type !== 'text')
          .map((element) => element.strokeWidth * strokeScale(element.type)),
        style.width,
      ),
      canUndo: Boolean(node.querySelector('[data-testid="button-undo"]:not(:disabled)')),
      canRedo: Boolean(node.querySelector('[data-testid="button-redo"]:not(:disabled)')),
    };
    if (!lastControls || Object.keys(next).some((key) => next[key] !== lastControls[key])) {
      lastControls = next;
      oncontrols(next);
    }
  }
  // There is no imperative undo/redo API in 0.18.1. The hidden engine controls
  // are the single bridge to native history, including its actual availability.
  const controls = new MutationObserver(syncControls);
  controls.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });
  function commitText() {
    node.querySelector('textarea')?.blur();
  }
  function prepareTextPlacement(event) {
    // Blur before the engine's pointerdown, not after it, so one tap both
    // commits the previous label and starts the next one.
    if (event.target instanceof HTMLCanvasElement && api?.getAppState().activeTool.type === 'text')
      commitText();
  }
  function setTool(type) {
    commitText();
    api.updateScene({
      appState: { ...itemStyle(type), selectedElementIds: {}, selectedGroupIds: {} },
    });
    api.setActiveTool({ type, locked: true });
  }
  let observedVersion = scene ? sceneVersion(scene.elements, scene.appState) : null;
  function keepTextVisible() {
    const editor = document.activeElement;
    if (!api || editor?.tagName !== 'TEXTAREA' || !node.contains(editor)) return;
    const bounds = node.getBoundingClientRect();
    const top = bounds.top + 12;
    const bottom = bounds.bottom - 12;
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
  node.addEventListener('pointerdown', prepareTextPlacement, true);
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
        initialData: {
          ...scene,
          appState: {
            viewBackgroundColor: '#ffffff',
            ...scene?.appState,
            ...itemStyle('freedraw'),
            activeTool: { type: 'freedraw', locked: true },
            selectedElementIds: {},
            selectedGroupIds: {},
            openMenu: null,
            openSidebar: null,
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
        onPointerDown: () => uniformStrokes(api.getSceneElements()),
        onChange: (elements, appState, files) => {
          // Native keyboard shortcuts can change tools without going through our toolbar.
          const width = strokeWidth(appState.activeTool.type);
          if (api && appState.currentItemStrokeWidth !== width)
            api.updateScene({ appState: { currentItemStrokeWidth: width } });
          uniformStrokes(elements);
          syncControls();
          const version = sceneVersion(elements, appState);
          const previousVersion = observedVersion;
          observedVersion = version;
          onchange({ elements, appState, files }, version, previousVersion);
        },
      },
      createElement(MainMenu, null),
    ),
  );

  return {
    setTool,
    setStyle(patch) {
      commitText();
      style = { ...style, ...patch };
      const state = api.getAppState();
      api.updateScene({
        appState: itemStyle(state.activeTool.type),
        elements: api.getSceneElementsIncludingDeleted().map((element) =>
          state.selectedElementIds[element.id] && element.type !== 'image'
            ? newElementWith(element, {
                ...(patch.color ? { strokeColor: patch.color } : {}),
                ...(patch.width && element.type !== 'text'
                  ? { strokeWidth: strokeWidth(element.type) }
                  : {}),
              })
            : element,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    async history(action) {
      commitText();
      await new Promise(requestAnimationFrame);
      node.querySelector(`[data-testid="button-${action}"]`)?.click();
    },
    clear() {
      commitText();
      api.updateScene({
        elements: api
          .getSceneElementsIncludingDeleted()
          .map((element) =>
            element.isDeleted ? element : newElementWith(element, { isDeleted: true }),
          ),
        appState: { selectedElementIds: {}, selectedGroupIds: {} },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
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
        setTool('freedraw');
      } catch (error) {
        onerror(`无法添加图片：${error.message}`);
      }
    },
    async exportImage() {
      // Commit the native text editor before reading the scene for export.
      commitText();
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
      controls.disconnect();
      node.removeEventListener('focusin', scheduleTextVisibility);
      node.removeEventListener('input', scheduleTextVisibility);
      node.removeEventListener('pointerdown', prepareTextPlacement, true);
      window.visualViewport?.removeEventListener('resize', scheduleTextVisibility);
      root.unmount();
      node.classList.remove('sketch-canvas');
    },
  };
}
