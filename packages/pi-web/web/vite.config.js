import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { sketchFonts, withoutSketchPrecache } from './sketch-assets.js';

export default defineConfig({
  // 静态资源由 Go 在 /static/ 下提供。
  base: '/static/',
  plugins: [
    svelte(),
    sketchFonts(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      base: '/',
      buildBase: '/',
      scope: '/',
      injectRegister: false,
      manifest: false,
      registerType: 'prompt',
      injectManifest: {
        globPatterns: ['assets/**/*.{js,css,woff2}'],
        maximumFileSizeToCacheInBytes: 8 << 20,
        manifestTransforms: [
          async (entries) => ({
            manifest: (
              await withoutSketchPrecache(entries, resolve(__dirname, 'dist/.vite/manifest.json'))
            ).map((entry) => ({ ...entry, url: '/static/' + entry.url })),
            warnings: [],
          }),
        ],
      },
    }),
  ],
  build: {
    manifest: true,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'src/main.js'),
      },
    },
  },
});
