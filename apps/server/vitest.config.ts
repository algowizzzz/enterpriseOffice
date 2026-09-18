import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@docforge/model': fileURLToPath(new URL('../../packages/model/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', '../../packages/model/src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
