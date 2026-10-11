# Common rules for apps/server work (proxy, pipeline, api)

ContextScope: MIT TypeScript pnpm monorepo, root = /work in the shell. Read first: docs/ARCHITECTURE.md, apps/server/src/types.ts (THE internal contracts between proxy/, pipeline/, api/ — do not change existing signatures; you may add optional fields and tell the integrator), apps/server/src/db/schema.ts + apps/server/migrations/0001_init.sql, packages/shared/src/*.ts, packages/core/src/*.ts, packages/providers/src/index.ts, packages/pricing/src/types.ts + pricing.ts exports, packages/analyzer/src/types.ts + index.ts.

Installed deps in apps/server: fastify 5, @fastify/static, undici 7, better-sqlite3, drizzle-orm, pino, zod 4. No new dependencies. ESM NodeNext (relative imports end in .js), strict TS + noUncheckedIndexedAccess, no explicit any, `import type`. `export PATH=/work/.tools/bin:$PATH`.

Tests: Vitest, files in apps/server/test/<area>*.test.ts, run from root `npx vitest run apps/server/test/<area>` (root vitest.config.ts aliases workspace packages to src). Typecheck: `npx tsc -p apps/server/tsconfig.json --noEmit` (app.ts is a stub with `declare function`s — fine). Lint: `npx eslint apps/server/src/<area> apps/server/test`.

Rules: never log or persist credentials (use core/redact). Absent metadata = null, never 0. Observability failures must never affect the proxied response. Bounded memory everywhere. Do not commit. Another agent works on each other server area at the same time; write only in your paths. The integrator writes apps/server/src/app.ts (wiring) afterwards, so export clear factory functions and describe them in your report (signatures + how to wire).
