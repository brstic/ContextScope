# Examples

Start ContextScope first (`contextscope start`, or `pnpm start` in this repo), then run an example.
Your provider API key is forwarded to the provider unchanged; ContextScope never stores it.
The optional `x-contextscope-session` header groups requests into a session and is stripped before forwarding.

| Folder | What | Base URL |
|---|---|---|
| `openai-node` | OpenAI JS SDK: Chat Completions, Responses, streaming | `http://127.0.0.1:3377/openai/v1` |
| `openai-python` | OpenAI Python SDK | `http://127.0.0.1:3377/openai/v1` |
| `anthropic-node` | Anthropic JS SDK (Messages, streaming, cache_control) | `http://127.0.0.1:3377/anthropic` |
| `anthropic-python` | Anthropic Python SDK | `http://127.0.0.1:3377/anthropic` |
| `gemini-rest/request.sh` | `generateContent` and `streamGenerateContent?alt=sse` with curl | `http://127.0.0.1:3377/gemini` |
| `openai-compatible/curl.sh` | Plain curl against the OpenAI route | `http://127.0.0.1:3377/openai/v1` |
| `traces/sample-trace.json` | Offline trace file for `contextscope import` (3 traces) | — |

**About the SDK base URLs.** Verified on 2026-10-11 with the official JS SDKs `openai` 7.32.0 and `@anthropic-ai/sdk` 0.133.0:
through ContextScope (pointed at a local mock upstream) `chat.completions.create`, `responses.create` and `messages.create`
reached `POST /v1/chat/completions`, `/v1/responses` and `/v1/messages` and were recorded with their usage.
The OpenAI SDKs append paths to a base that includes `/v1`; the Anthropic SDKs append `/v1/messages`, so their base has no `/v1`.
The Python SDKs use the same base-URL convention but were not executed here.
