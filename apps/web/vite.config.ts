import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@docforge/model': fileURLToPath(
        new URL('../../packages/model/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    // Everything ships in the bundle. No external requests at runtime.
    assetsInlineLimit: 0,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
});
