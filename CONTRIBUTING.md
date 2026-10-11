# Contributing to ContextScope

Thanks for helping! Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Node ≥ 22.12 and pnpm (via corepack):

```sh
corepack enable
pnpm install
pnpm build            # TypeScript packages + dashboard
pnpm demo             # dashboard with synthetic data at http://127.0.0.1:3377
```

## Architecture

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: `apps/server` proxies `/openai`, `/anthropic`,
`/gemini` byte-for-byte and observes a bounded copy on a side channel; `packages/providers` parse
requests/responses/streams; `packages/core` builds segments and fingerprints; `packages/analyzer` compares
prefixes and emits findings; `packages/pricing` computes costs; `apps/web` is the dashboard; `packages/cli` is
the `contextscope` command.

## Provider adapter guide

1. Implement `ProviderAdapter` from `packages/core` in `packages/providers/src/<provider>.ts`: endpoint matching,
   `parseRequest`, `parseResponse`, `createStreamAccumulator`.
2. Normalize usage to `NormalizedUsage` following the provider's **documented** fields; unknown values are
   `null`, never 0. Cite the docs in comments and in [docs/token-accounting.md](docs/token-accounting.md).
3. Add fixtures in `packages/test-fixtures` (synthetic, no secrets) and tests for JSON, SSE and truncated streams.
4. Register the route in the server and document it in [docs/providers.md](docs/providers.md).

## Adding optimization rules

Rules live in `packages/analyzer/src/request-rules.ts` (single request) and `history-rules.ts` (across a
session). A rule returns `Finding`s with a severity, evidence and an estimate marked as estimated. Add unit tests
with both a triggering and a non-triggering case; avoid noisy rules.

## Testing

```sh
pnpm lint && pnpm typecheck
pnpm test          # all Node packages (Vitest)
pnpm test:web      # dashboard (jsdom)
pnpm test:e2e      # Playwright smoke (after pnpm build)
pnpm bench         # proxy overhead benchmark (after pnpm build)
```

## Coding standards

TypeScript strict, ESM (NodeNext), `import type` for types, no `any`, Prettier formatting (`pnpm format`).
Never log or store credentials; run anything user-supplied through `core/redact`. Keep the proxy path
non-blocking: analysis must never slow or alter the client's bytes.

## Pull requests

Small, focused PRs with tests and docs. Fill in the PR template, add a changeset for user-visible changes, and
make sure CI is green. No real prompts, keys or personal data in fixtures or screenshots.

## Releasing

All packages share one version (Changesets `fixed` group in `.changeset/config.json`). The Changesets CLI is
used on demand, not installed:

```sh
pnpm dlx @changesets/cli add        # contributors: describe the change
pnpm dlx @changesets/cli version    # maintainers: bump versions + changelogs
git commit -am "release: vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`: it builds and pushes the Docker image to GHCR, and
publishes to npm only when an `NPM_TOKEN` secret is configured. Update `CHANGELOG.md` before tagging.
