#!/usr/bin/env sh
# GEMINI_API_KEY=... sh request.sh
# Replace https://generativelanguage.googleapis.com with http://127.0.0.1:3377/gemini.
set -eu
BASE="${CONTEXTSCOPE_GEMINI_URL:-http://127.0.0.1:3377/gemini}"
MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
: "${GEMINI_API_KEY:?set GEMINI_API_KEY}"

echo "== generateContent"
curl -sS "$BASE/v1beta/models/$MODEL:generateContent" \
  -H 'content-type: application/json' \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'x-contextscope-session: example-gemini-rest' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Name one benefit of prompt caching."}]}]}'
echo

echo "== streamGenerateContent (SSE)"
curl -sS -N "$BASE/v1beta/models/$MODEL:streamGenerateContent?alt=sse" \
  -H 'content-type: application/json' \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'x-contextscope-session: example-gemini-rest' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Count from 1 to 5."}]}]}'
echo
