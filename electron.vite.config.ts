import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

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
    plugins: [react()],
    resolve: { alias: { '@renderer': resolve('src/renderer'), '@core': resolve('src/core') } }
  }
});
