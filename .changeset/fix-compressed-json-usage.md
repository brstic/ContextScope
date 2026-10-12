---
'@contextscope/server': patch
---

Record token usage and cost for compressed (gzip/br/deflate) non-streaming JSON responses. The proxy's
analysis copy is already decoded, but it was decoded a second time, so every compressed JSON response (e.g.
OpenAI, which sends JSON with `content-encoding: br`) showed "Usage unavailable".
