# Providers

ContextScope forwards requests byte-for-byte to a fixed, allow-listed upstream per route prefix.

| Route prefix | Upstream (default) | Endpoints analysed |
|---|---|---|
| `/openai` | `https://api.openai.com` | `POST /v1/chat/completions`, `POST /v1/responses` (JSON and SSE) |
| `/anthropic` | `https://api.anthropic.com` | `POST /v1/messages` (JSON and SSE) |
| `/gemini` | `https://generativelanguage.googleapis.com` | `POST /v1beta/models/{model}:generateContent`, `:streamGenerateContent` (`?alt=sse` or JSON array) |
| `/<custom>` | `customProviders[].upstream` | OpenAI protocol |

Other paths under a prefix are proxied unchanged but not analysed. The live list is at `GET /api/providers`.

## Routing each SDK

| SDK | Setting |
|---|---|
| OpenAI JS | `new OpenAI({ baseURL: 'http://127.0.0.1:3377/openai/v1' })` |
| OpenAI Python | `OpenAI(base_url="http://127.0.0.1:3377/openai/v1")` |
| Anthropic JS | `new Anthropic({ baseURL: 'http://127.0.0.1:3377/anthropic' })` (SDK appends `/v1/messages`) |
| Anthropic Python | `Anthropic(base_url="http://127.0.0.1:3377/anthropic")` |
| Gemini REST | `http://127.0.0.1:3377/gemini/v1beta/models/gemini-2.5-flash:generateContent` with `x-goog-api-key` |
| OpenAI-compatible tools | base URL `http://127.0.0.1:3377/openai/v1` (or `/<custom>/v1`) |

Many tools also read `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`. Runnable examples are in [`examples/`](../examples).

## Integration headers (optional, stripped before forwarding)

- `x-contextscope-session` — groups requests into a session
- `x-contextscope-project` — project id (default `default`)
- `x-contextscope-trace` — your own trace id

## Custom OpenAI-compatible providers

```json
{ "customProviders": [{ "name": "groq", "protocol": "openai", "upstream": "https://api.groq.com", "trusted": true }] }
```

Requests to `/groq/...` go to that origin. Names `openai`, `anthropic`, `gemini`, `api`, `assets` are reserved.

## Usage notes

- Streamed OpenAI Chat Completions report usage only with `stream_options: { include_usage: true }`; ContextScope
  never adds it, so without it usage is shown as unavailable.
- How each provider's usage is normalized: [token-accounting.md](token-accounting.md).
