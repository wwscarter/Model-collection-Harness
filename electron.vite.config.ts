import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Inject a CSP that matches the mode: Vite's dev client needs inline scripts and a websocket. */
function cspPlugin() {
  let command = 'build';
  return {
    name: 'newai-csp',
    configResolved(config: { command: string }) { command = config.command; },
    transformIndexHtml(html: string) {
      const dev = command === 'serve';
      const policy = [
        "default-src 'self'",
        dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        dev ? "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*" : "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace('<!-- NEWAI_CSP -->', `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preload scripts must be CommonJS. Electron disables ESM preloads
    // when sandbox: true, so this file is deliberately emitted as preload.cjs.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'preload.cjs' } } },
    resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
  },
  renderer: {
    root: resolve('.'),
    build: { rollupOptions: { input: resolve('index.html') } },
    plugins: [react(), tailwindcss(), cspPlugin()],
    resolve: { alias: { '@renderer': resolve('src/renderer'), '@core': resolve('src/core') } }
  }
});
