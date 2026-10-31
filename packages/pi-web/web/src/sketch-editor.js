import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw,
  MainMenu,
  exportToBlob,
  hashElementsVersion,
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
        onChange: (elements, appState, files) =>
          onchange({ elements, appState, files }, sceneVersion(elements, appState)),
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
        const id = crypto.randomUUID();
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
      const elements = structuredClone(api.getSceneElements());
      const appState = { ...api.getAppState() };
      const files = { ...api.getFiles() };
      const version = sceneVersion(api.getSceneElementsIncludingDeleted(), appState);
      if (!elements.some((element) => !element.isDeleted))
        throw new Error('先画点什么，或添加一张图片。');
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
        maxWidthOrHeight: 1600,
        exportPadding: 24,
      });
      if (!blob) throw new Error('图片生成失败，请重试。');
      return { image: new File([blob], `草图-${Date.now()}.png`, { type: 'image/png' }), version };
    },
    destroy() {
      api = null;
      root.unmount();
    },
  };
}
