import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] }
  },
  resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
});
