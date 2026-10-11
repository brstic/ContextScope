/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sharedSrc = decodeURIComponent(new URL('../../packages/shared/src/index.ts', import.meta.url).pathname);

// The ContextScope server listens on 3377 by default; the dashboard is same-origin in production.
const apiProxy = { '/api': { target: 'http://127.0.0.1:3377', changeOrigin: false } };

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@contextscope/shared/format': sharedSrc.replace(/index\.ts$/, 'format.ts'),
      '@contextscope/shared': sharedSrc,
    },
  },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
