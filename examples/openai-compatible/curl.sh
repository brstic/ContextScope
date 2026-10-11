#!/usr/bin/env sh
# OPENAI_API_KEY=sk-... sh curl.sh
# Any OpenAI-compatible client works with base URL http://127.0.0.1:3377/openai/v1.
# For another OpenAI-compatible upstream add a customProviders entry and use /<name>/v1 (docs/providers.md).
set -eu
BASE="${CONTEXTSCOPE_OPENAI_URL:-http://127.0.0.1:3377/openai/v1}"
: "${OPENAI_API_KEY:?set OPENAI_API_KEY}"

curl -sS "$BASE/chat/completions" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H 'x-contextscope-session: example-curl' \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"Say hi."}]}'
echo
