import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // The Go server serves built assets under /static/. Without this, the chunk
  // loader resolves dynamic imports against /assets/ and they 404.
  base: '/static/',
  plugins: [svelte()],
  build: {
    manifest: true,
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'src/main.js'),
      },
    },
  },
});
