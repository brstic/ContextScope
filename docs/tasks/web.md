# Task: apps/web — the ContextScope dashboard

ContextScope is an MIT, self-hosted "Chrome DevTools for LLM API requests": context profiler, prompt-cache debugger, token/cost analyzer. Monorepo root = /work in the shell. Dependencies are ALREADY installed in apps/web (React 19, Vite 7, Tailwind v4 via @tailwindcss/vite, Radix, TanStack Query v5 + Table v8, Recharts 3, CodeMirror 6 incl. @codemirror/merge, lucide-react, react-router-dom 7, vitest + jsdom + testing-library). No new dependencies. Write ONLY in apps/web. No git commit. `export PATH=/work/.tools/bin:$PATH` before pnpm.

## API contract
Read packages/shared/src/api.ts and packages/shared/src/domain.ts fully. Import TYPES from '@contextscope/shared' (Vite alias + tsconfig paths to ../../packages/shared/src/index.ts); the pure helpers formatUsd/formatTokens/formatMs/formatPct may be imported too (no Node deps). Endpoints (server built separately):
- GET /api/health → HealthResponse
- GET /api/overview?from&to&provider&model → OverviewResponse
- GET /api/filters → FiltersResponse
- GET /api/requests?page&pageSize&q&provider&model&state&session&sort(startedAt|cost|duration|inputTokens)&dir(asc|desc)&from&to → Page<RequestSummary>
- GET /api/requests/:id → RequestDetail; /context → RequestContext; /findings → Finding[]; /content → ContentResponse or 404 {error:{code:'content_unavailable'}}
- GET /api/sessions?page&pageSize → Page<SessionSummary>; GET /api/sessions/:id → SessionDetail
- GET /api/cache/summary → CacheSummary; GET /api/cache/trends?bucket=hour|day → TimeBucket[]
- GET /api/costs/summary → CostSummary; GET /api/costs/trends?bucket → TimeBucket[]
- GET /api/optimizations?severity&type → Finding[]
- GET /api/compare?a&b → CompareResponse
- GET /api/providers → ProviderInfo[]
- GET /api/settings → SettingsResponse; PUT /api/settings {captureMode?, contentRetentionHours?, metadataRetentionDays?, pricingOverrides?} → SettingsResponse
- Mutating requests send header `x-contextscope-csrf: 1`. If localStorage 'cs.token' exists, send `authorization: Bearer <token>` on all requests; a 401 shows a token entry screen.
- GET /api/events → SSE (EventSource) with named events = LiveEvent.type ('request.started','request.completed','findings.updated','stats','heartbeat'), data = JSON LiveEvent.
- Money = integer nano-USD. null numbers = unknown → render '—' with tooltip 'Not reported by the provider' (never 0). Estimated values visibly labelled 'est.'.

## Design (follow strictly; distinctive, not a template)
A dense, precise devtools instrument. Dark default, fully working light mode (header toggle, localStorage, initial prefers-color-scheme).
- Dark: bg #0E1116, panel #151A21, raised #1C232C, border #2A323D, text #E6EAF0, muted #8B97A6. Light: bg #F7F8FA, panel #FFFFFF, border #DDE2E8, text #111827, muted #5B6675.
- Signal colours carry meaning only: cache read teal #2BC7B4, cache write amber #E9A23B, uncached input steel blue #6E8BFF, output rose #F0719B, reasoning sand #D8C79A, error #F25F5C, success #5BD69A (darken in light mode for AA contrast). No violet, no gradients, no glow.
- Tokens in Tailwind v4 `@theme` in src/index.css with CSS variables switched by class on <html>.
- Type: NO external font requests (offline, privacy). UI: system stack (ui-sans-serif, system-ui, 'Segoe UI', Roboto). Mono stack (ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas) for numbers, ids, tokens, model names; tabular-nums. 13px UI base, 12px table cells, headings 15–20px semibold. No all-caps eyebrows, no '→' in buttons, radius 6px panels / 4px controls.
- Signature element: the **context strip** — a horizontal stacked bar of a request's context segments in cache order (tools | system | history | latest user…) proportional to estimated tokens, coloured by kind (estimated parts get a subtle diagonal hatch), with a vertical marker at the shared-prefix boundary ("identical to previous request up to here"); directly under it the reported usage bar (uncached / cache read / cache write / output) so estimated structure and provider-reported numbers are visibly different things. Used in Request inspector, Context Explorer, Compare (two aligned strips) and as a mini strip in the request table expanded row.
- Layout: left sidebar (collapsible to icons; <768px becomes top bar + slide-over menu): Overview, Live Requests, Sessions, Context Explorer, Cache Analyzer, Cost Analytics, Optimizations, Compare, Settings. Header: live indicator (connected / reconnecting / paused), queue + dropped events, theme toggle, a 'Demo data' badge when health.demo.

## Pages (real data via TanStack Query; skeletons; empty states that say what to do — show proxy URLs http://127.0.0.1:3377/openai/v1 , /anthropic , /gemini and `contextscope demo`; error states with message + retry)
1. Overview: metrics (requests, input, output, cache token hit rate, est. cost, avg/p95 latency, open findings; footnotes for unpriced / without usage), charts: request volume, tokens stacked (uncached/read/write/output), cache hit-rate trend, cost by model (horizontal bars), provider distribution, top sessions, top requests, recent findings.
2. Live Requests: TanStack Table, server-side pagination/sort/filter; columns time, provider, model, session, input, output, cached, cost, duration, status. Search (q), provider/model/state filters from /api/filters, SSE live prepend batched (~250 ms, no rerender per event), pause/resume, keyboard j/k/arrows + Enter. Row → /requests/:id.
3. Request inspector /requests/:id tabs: Overview, Timeline (start → TTFB → TTFT → end; 'TTFT unavailable' when null), Context (segments, strip, est. tokens, short fingerprints, duplicate / seen-in badges, cache_control markers), Cache (reported read/write, prefix comparison with explanation, findings), Cost (breakdown, pricing source/version, disclaimer), Raw (only via /content, CodeMirror JSON read-only; else explain how to enable deep capture), Issues. 'Compare with previous' → /compare?a=prev&b=this.
4. Sessions list + /sessions/:id: context growth per turn (stacked uncached/read/write + output line), turns table with first changed segment, findings.
5. Context Explorer: pick a request (recent + search); tree grouped by kind (System instructions, Developer, Tool definitions, Conversation history, Tool results, Documents, Latest user message) with est. tokens, %, repeated-content indicators.
6. Cache Analyzer: totals (reads, writes, hit rate, actual savings), trend, by provider / model, prefix stability (avg shared ratio, first-change-by-kind bars), cache findings. Label 'Reported by providers' vs 'Eligibility estimate'.
7. Cost Analytics: cost over time stacked by component, by provider/model/session, top requests, cached vs uncached, pricing version + disclaimer. Actual savings (measured), potential (findings, estimate) and avoidable token volume shown separately, never summed.
8. Optimizations: findings with severity/type filters, expandable (evidence, recommendation, tradeoff, confidence, affected request links, docs link, est. token reduction labelled estimated).
9. Compare /compare?a&b: two request pickers, aligned strips, structural diff list, token/cache/cost/latency deltas, 'Find first cache-relevant difference' button (scroll + highlight + explanation), textual diff via @codemirror/merge MergeView only when content exists for both (React.lazy; cap 200k chars with notice).
10. Settings: capture mode (metadata / deep_memory / deep_persistent) with privacy warning Radix Dialog before deep modes, retention inputs, pricing overrides JSON textarea with API validation errors, provider routes table with copyable base URLs, queue/dropped/db stats, theme.

Small shadcn-style kit in src/components/ui (button, badge, panel, tabs, dialog, select, switch, tooltip, skeleton, table) on Radix + tokens; lucide icons only. Accessible (labels, focus-visible rings, chart titles), reduced motion respected. Responsive 390–1440 px: tables scroll inside their panel, never the page. API client src/lib/api.ts; same-origin; Vite dev + preview proxy '/api' → http://127.0.0.1:3377. BrowserRouter. Build outDir 'dist', base '/'. Lazy-load pages.

Tests (vitest + jsdom): '—' for null formatting, context-strip proportion math, SSE batching hook (mock EventSource), render test of Live Requests with mocked fetch (empty + rows).

Visual check: NO mock data inside src. For your own screenshots write apps/web/scripts/dev-mock-server.mjs serving realistic DTO-shaped JSON on port 3377, then in ONE shell command: start it in background, `npx vite preview --port 4173 &`, sleep, `headless-chrome --screenshot=shots/x.png --window-size=1440,900 http://127.0.0.1:4173/...`, kill both. Shots in apps/web/shots at 1440 and 390, dark and light; look at them critically (you can't view images, so at least check the DOM via a Playwright script for overflow: document.documentElement.scrollWidth <= innerWidth, and no console errors).

Finish with `cd apps/web && npx tsc -p tsconfig.json --noEmit && npx vitest run && npx vite build` and `npx eslint apps/web` from root, all passing. REPORT: files, where theme tokens live, which endpoints/params each page uses, any API fields missing from api.ts (precise list; don't edit packages/shared), test/build summary, screenshot paths.
