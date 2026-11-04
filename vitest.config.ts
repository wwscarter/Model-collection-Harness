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
      // Whole-project floors, set below the 2026-11 baseline (67% lines). They
      // prevent the old "92.5%" illusion while leaving room to iterate.
      thresholds: { lines: 60, statements: 55, functions: 48, branches: 48 },
    },
  },
  resolve: { alias: { '@core': resolve('src/core'), '@utils': resolve('src/utils'), '@main': resolve('src/main') } }
});
