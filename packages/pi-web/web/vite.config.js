import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 静态资源由 Go 在 /static/ 下提供。
  base: '/static/',
  plugins: [
    svelte(),
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
        globPatterns: ['assets/**/*.{js,css}'],
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.map((entry) => ({ ...entry, url: '/static/' + entry.url })),
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
