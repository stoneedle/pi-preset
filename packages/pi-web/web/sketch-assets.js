import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Excalidraw resolves font strings at runtime. Turn them into ordinary Vite
// assets so every font has a same-origin, content-hashed URL (and no CDN fallback).
export function sketchFonts() {
  return {
    name: 'sketch-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (
        !id.replaceAll('\\', '/').includes('/@excalidraw/excalidraw/dist/prod/') ||
        !id.endsWith('.js')
      )
        return;
      const imports = [];
      const transformed = code.replace(/(["'])\.\/fonts\/([^"']+\.woff2)\1/g, (_, quote, file) => {
        // This browser-only PNG editor does not ship the unused legacy
        // Liberation font reserved by Excalidraw for server-side exports.
        if (file.startsWith('Liberation/')) return JSON.stringify('local:');
        const name = `sketchFont${imports.length}`;
        imports.push(
          `import ${name} from ${JSON.stringify(resolve(dirname(id), 'fonts', file) + '?url')};`,
        );
        return `new URL(${name}, window.location.href).href`;
      });
      if (imports.length) return { code: imports.join('\n') + '\n' + transformed, map: null };
    },
  };
}

// Do not download the drawing editor, locales and fonts just to open a chat.
// Shared chunks and all existing non-editor assets retain their precache policy.
export async function withoutSketchPrecache(entries, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sketch = 'src/sketch-editor.js';
  function assets(key, skip, visited = new Set()) {
    if (key === skip || visited.has(key) || !manifest[key]) return new Set();
    visited.add(key);
    const entry = manifest[key];
    const result = new Set([entry.file, ...(entry.css || []), ...(entry.assets || [])]);
    for (const child of [...(entry.imports || []), ...(entry.dynamicImports || [])])
      for (const asset of assets(child, skip, visited)) result.add(asset);
    return result;
  }
  const editorAssets = assets(sketch);
  const chatAssets = assets('src/main.js', sketch);
  return entries.filter(({ url }) => !editorAssets.has(url) || chatAssets.has(url));
}
