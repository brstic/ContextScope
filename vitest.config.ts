import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Root test runner for all Node packages. Workspace packages resolve to their
// TypeScript sources so tests never depend on a stale build.
// apps/web has its own Vitest config (jsdom) and is run with `pnpm test:web`.
export default defineConfig({
  resolve: {
    alias: {
      '@contextscope/shared': pkg('shared'),
      '@contextscope/core': pkg('core'),
      '@contextscope/providers': pkg('providers'),
      '@contextscope/analyzer': pkg('analyzer'),
      '@contextscope/pricing': pkg('pricing'),
      '@contextscope/test-fixtures': pkg('test-fixtures'),
      '@contextscope/server': fileURLToPath(new URL('./apps/server/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/**', 'e2e/**'],
    testTimeout: 20_000,
    pool: 'forks',
  },
});
