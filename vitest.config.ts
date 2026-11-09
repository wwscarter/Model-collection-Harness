import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A real Pi tool round plus an HTTP server can exceed the 5s default on a
    // loaded machine; the old default produced flaky failures.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Without include, V8 only reports modules the tests happened to import,
      // which made 92.5% look like project coverage while most files were absent.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/renderer/styles/**', 'src/renderer/**/*.css'],
      // Whole-project floors after the runtime split and optimization pass.
      // src/** remains included so untouched modules also count toward coverage.
      thresholds: { lines: 70, statements: 65, functions: 60, branches: 60 },
    },
  },
  resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
});
