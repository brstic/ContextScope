# ContextScope architecture

```
Client SDK ──► ContextScope (Fastify, 127.0.0.1:3377)
                 /openai/*  /anthropic/*  /gemini/*  ──► undici ──► allow-listed upstream
                 │  bytes are forwarded unchanged (request and response, JSON and SSE)
                 └─ side-channel observer (bounded tee, never blocks the client stream)
                      ├─ ProviderAdapter.parseRequest / StreamAccumulator / parseResponse
                      ├─ core.buildSegments (keyed HMAC fingerprints, estimated sizes)
                      ├─ pricing.cost (integer nano-USD)
                      ├─ analyzer (prefix compare, findings)
                      └─ bounded persistence queue ──► SQLite (WAL, Drizzle)
                 /api/*      dashboard REST API (+ /api/events SSE live feed)
                 /           built React dashboard (apps/web/dist)
```

## Packages and their contracts

| Package | Owns | Key exports |
|---|---|---|
| `packages/shared` | domain types, Zod config + import schemas, API DTOs | `TraceRecord`, `NormalizedUsage`, `ContextSegment`, `Finding`, `configSchema`, `importedTraceSchema`, API DTOs in `api.ts` |
| `packages/core` | adapter contract, fingerprints, segments, redaction | `ProviderAdapter`, `StreamAccumulator`, `SseEvent`, `createFingerprinter`, `buildSegments`, `sharedPrefixLength`, `redact*` |
| `packages/providers` | OpenAI, Anthropic, Gemini adapters; SSE + JSON-array stream parsers | `openaiAdapter`, `anthropicAdapter`, `geminiAdapter`, `adapters`, `getAdapter`, `SseParser`, `JsonArrayStreamParser` |
| `packages/pricing` | versioned price catalog, cost math | `createPricing(overrides?) : Pricing`, `DEFAULT_CATALOG`, `COST_DISCLAIMER` |
| `packages/analyzer` | prefix comparison, alignment, findings | `createAnalyzer(limits?) : Analyzer` |
| `packages/test-fixtures` | deterministic provider fixtures + demo dataset | `fixtures` (per provider), `demoTraces(seed?) : ImportedTrace[]` |
| `apps/server` | proxy, pipeline, DB, REST API, live SSE | `startServer(config) : Promise<RunningServer>`, `openDatabase`, `importTraceFile` |
| `apps/web` | React dashboard | built to `apps/web/dist` |
| `packages/cli` (`contextscope`) | `start`, `demo`, `import`, `export`, `status`, `stop`, `doctor`, `config` | `bin.js` |

## Usage normalization rules (from provider docs, Oct 2026)

`NormalizedUsage` invariant: `totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens`;
`outputTokens` always includes reasoning; `reasoningTokens` is the reasoning part of it.

* **OpenAI Responses**: `usage.input_tokens` is the TOTAL input (includes cached). `input_tokens_details.cached_tokens` = cache read,
  `input_tokens_details.cache_write_tokens` (GPT-5.6+, may be absent) = cache write. uncached = input − cached − write.
  `output_tokens` includes `output_tokens_details.reasoning_tokens`. Streaming: usage arrives in `response.completed`
  (`event: response.completed`, `data.response.usage`). Also `response.failed` / `response.incomplete` carry usage.
  Meaningful output events: `response.output_text.delta`, `response.function_call_arguments.delta`, `response.refusal.delta`,
  `response.reasoning_summary_text.delta`, `response.output_item.added` with type function_call.
* **OpenAI Chat Completions**: `usage.prompt_tokens` = TOTAL input, `prompt_tokens_details.cached_tokens` = read;
  `completion_tokens` includes `completion_tokens_details.reasoning_tokens`. Streaming: chunks are `data: {...}` and `data: [DONE]`;
  usage only appears when the client sent `stream_options.include_usage: true` (last chunk with `choices: []`). Without it usage is
  unavailable (do NOT add the option by default). Meaningful: `choices[].delta.content` non-empty, `delta.tool_calls`, `delta.refusal`.
* **Anthropic Messages**: `usage.input_tokens` is ONLY the uncached part after the last cache breakpoint.
  total = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. TTL split in
  `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. Streaming: `message_start` has
  `message.usage` (input side + initial output), `message_delta` has cumulative `usage.output_tokens` (and may repeat input-side fields:
  later non-null values win), `message_stop` terminal. `ping` is a heartbeat. Meaningful: `content_block_delta` with `text_delta`,
  `input_json_delta`, `thinking_delta`. `error` event = upstream error. Cache order: tools → system → messages.
* **Gemini**: `usageMetadata.promptTokenCount` is TOTAL prompt INCLUDING `cachedContentTokenCount`. `candidatesTokenCount`
  excludes `thoughtsTokenCount`, so outputTokens = candidates + thoughts, reasoning = thoughts. `toolUsePromptTokenCount` → `other`.
  Gemini reports no cache writes (explicit caches are created via a separate API) → cacheWriteTokens null.
  `streamGenerateContent?alt=sse` → SSE `data:` JSON chunks, usage repeated cumulatively, last one wins.
  Without `alt=sse` → one JSON array streamed incrementally. Model comes from the URL `models/{model}:op`. API key may be in `?key=`
  or `x-goog-api-key` (both secret).

Absent fields stay `null`. A stream that ends before its usage-carrying event has `usage.complete = false`.

## Privacy

Default capture mode `metadata` stores no prompt/response text: only sizes, keyed HMAC-SHA256 fingerprints (key generated per
install in the data dir, `fingerprint.key`, mode 0600), usage, timing and costs. Deep capture (`deep_memory` keeps content in a
bounded in-process ring buffer; `deep_persistent` stores it AES-256-GCM encrypted with an expiry) is opt-in. Credentials are
stripped by `core/redact` before logs, DB, exports and errors; secret headers are never stored at all.

## Performance

The client's bytes are piped straight through (undici → Fastify reply); a bounded copy goes to the analysis queue, which is
drained in batches on `setImmediate` with an 8 ms budget per tick and one SQLite commit per batch. "Seen in N earlier
requests" reads running per-fingerprint counters (`context_fingerprints`, migration 0002) in O(1); only fingerprints whose
sightings straddle the request's start time (concurrent or out-of-order arrivals, viewing an old request) fall back to
subtracting the requests started since then, which walks the newest requests by `started_ms`. Counters are rebuilt when
retention deletes requests.

`pnpm bench` (after `pnpm build`) runs the proxy in its own process against a local mock upstream. Measured on Node 22.23,
small chat-completions JSON, Oct 2026:

| Scenario | Direct | Via ContextScope | Overhead |
|---|---:|---:|---:|
| Sequential, p50 / p95 | 0.35 / 0.64 ms | 4.02 / 5.41 ms | +3.7 / +4.8 ms |
| 100 req/s, p50 / p95 / p99 | 0.71 / 0.80 / 1.52 ms | 2.41 / 2.90 / 4.69 ms | +1.7 / +2.1 / +3.2 ms |
| Saturated, 20 concurrent, p50 | 5.6 ms | 37.9 ms | ≈ 480 req/s ceiling |

The proxy uses about 2.9 ms of CPU per request including analysis and persistence (≈ 1 ms analysis + SQLite, ≈ 0.5 ms
proxying, the rest Fastify/HTTP). The saturated row is a closed loop at full CPU (latency = concurrency ÷ throughput); real
LLM calls take hundreds of milliseconds to seconds, so a single process keeps up with several hundred requests per second.
The `seenCounts` lookup stays constant as the database grows (≈ 0.01 ms at 1k and at 20k requests; it was O(n), ≈ 73 ms at
20k, before the counters).
