import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
  },
  renderer: {
    root: resolve('.'),
    build: { rollupOptions: { input: resolve('index.html') } },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@renderer': resolve('src/renderer'), '@core': resolve('src/core') } }
  }
});
