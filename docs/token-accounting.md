# Token accounting

Every provider reports usage differently. ContextScope normalizes it to one shape (`NormalizedUsage`):

```
totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
outputTokens     includes reasoning; reasoningTokens is the reasoning part of it
```

## Sources

Each number carries its source:

- **reported** — returned by the provider.
- **exact_local** — computed locally with a verified tokenizer for that model and content type.
- **estimated** — documented approximation (e.g. bytes / 4); always labelled, never shown as exact.
- **unavailable** — could not be determined (e.g. a stream without usage). Shown as “—”, never as 0.

A stream that ended before its usage-carrying event is marked incomplete.

## Per-provider rules

**OpenAI Responses.** `usage.input_tokens` is the total input (includes cached).
`input_tokens_details.cached_tokens` = cache read; `input_tokens_details.cache_write_tokens` = cache write when
present. Uncached = input − cached − write. `output_tokens` includes `output_tokens_details.reasoning_tokens`.
Streaming usage arrives in `response.completed` (also `response.failed` / `response.incomplete`).

**OpenAI Chat Completions.** `prompt_tokens` = total input; `prompt_tokens_details.cached_tokens` = cache read;
`completion_tokens` includes `completion_tokens_details.reasoning_tokens`. Streamed usage only appears when the
client sends `stream_options.include_usage: true`; ContextScope does not add it, otherwise usage is unavailable.

**Anthropic Messages.** `usage.input_tokens` is only the uncached part after the last cache breakpoint.
Total = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; the TTL split comes from
`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. Streaming: `message_start` carries the
input side, `message_delta` the cumulative `output_tokens` (later non-null values win).

**Gemini.** `promptTokenCount` is the total prompt including `cachedContentTokenCount`. `candidatesTokenCount`
excludes `thoughtsTokenCount`, so output = candidates + thoughts and reasoning = thoughts.
`toolUsePromptTokenCount` is counted separately. Gemini reports no cache writes (`cacheWriteTokens` is null).
Streamed usage is cumulative; the last chunk wins.

## Cache hit ratio

```
cache hit ratio = cacheReadTokens / totalInputTokens
```

computed over requests where both are known (reported or exact). Requests with unavailable usage are excluded and
counted separately, so the ratio is never diluted by unknowns. Cache writes count in the denominator: writing a
prefix is not a hit.

## Costs

Costs are estimates from a versioned price catalog (`packages/pricing`), in integer nano-USD, with cache read/write
rates where the provider prices them. Override prices with `pricingFile` or in Settings. Your invoice is the
source of truth.
