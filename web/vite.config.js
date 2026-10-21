import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 静态资源由 Go 在 /static/ 下提供。
  base: '/static/',
  plugins: [svelte()],
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
