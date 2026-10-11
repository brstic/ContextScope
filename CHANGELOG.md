# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). All packages share one version.

## [1.0.0] - Unreleased

### Added

- Transparent local proxy for OpenAI (Chat Completions, Responses), Anthropic Messages and Gemini
  `generateContent` / `streamGenerateContent`, forwarding bytes unchanged (JSON and SSE).
- Context profiler: segments, sizes, keyed fingerprints, prefix comparison between requests.
- Prompt cache debugger: normalized usage (reported / estimated / unavailable), cache hit ratio, findings.
- Cost estimates from a versioned price catalog with overrides.
- React dashboard, REST API with OpenAPI document, live SSE feed.
- `contextscope` CLI: `start`, `demo`, `import`, `export`, `status`, `stop`, `doctor`, `config`.
- Privacy by default (`metadata` capture), opt-in deep capture with encryption and crypto-shredding.
- Docker image, compose file, CI and release workflows.
