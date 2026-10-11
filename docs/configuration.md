# Configuration

Precedence (highest first): **CLI flags > `CONTEXTSCOPE_*` environment > config file > defaults.**
`contextscope config` prints the effective configuration (secrets masked) with the source of every value;
`contextscope config --path` prints the config file in use.

## Config file

JSON only. Found via `--config <path>`, else `CONTEXTSCOPE_CONFIG`, else `./contextscope.config.json` if present.
Relative paths inside the file resolve against the file's folder; relative paths from flags/env resolve against
the current directory.

```json
{
  "port": 3377,
  "capture": { "mode": "metadata", "metadataRetentionDays": 90 },
  "customProviders": [
    { "name": "groq", "protocol": "openai", "upstream": "https://api.groq.com", "trusted": true }
  ]
}
```

## Options

| Option | Flag | Environment | Default |
|---|---|---|---|
| `host` | `--host` | `CONTEXTSCOPE_HOST` | `127.0.0.1` |
| `port` | `--port` | `CONTEXTSCOPE_PORT` | `3377` |
| `dataDir` | `--data-dir` | `CONTEXTSCOPE_DATA_DIR` | `./.contextscope` (`./.contextscope-demo` for `demo`) |
| `dbPath` | `--db` | `CONTEXTSCOPE_DB` | `<dataDir>/contextscope.db` |
| `capture.mode` | `--capture` | `CONTEXTSCOPE_CAPTURE_MODE` | `metadata` (`deep_memory`, `deep_persistent`) |
| `capture.contentRetentionHours` | | `CONTEXTSCOPE_CONTENT_RETENTION_HOURS` | `24` |
| `capture.metadataRetentionDays` | | `CONTEXTSCOPE_METADATA_RETENTION_DAYS` | `90` (0 = forever) |
| `capture.memoryBufferEntries` | | | `200` |
| `logLevel` | `--log-level` | `CONTEXTSCOPE_LOG_LEVEL` | `info` |
| `authToken` | `--auth-token` | `CONTEXTSCOPE_AUTH_TOKEN` | none (min 16 chars; required on non-loopback hosts) |
| `pricingFile` | | `CONTEXTSCOPE_PRICING_FILE` | none (JSON array of model prices) |
| `upstreams.openai` | | `CONTEXTSCOPE_OPENAI_UPSTREAM` | `https://api.openai.com` |
| `upstreams.anthropic` | | `CONTEXTSCOPE_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` |
| `upstreams.gemini` | | `CONTEXTSCOPE_GEMINI_UPSTREAM` | `https://generativelanguage.googleapis.com` |
| `limits.maxInspectBytes` | | `CONTEXTSCOPE_MAX_INSPECT_BYTES` | 8 MiB (analysis only; proxying is not limited by it) |
| `limits.idleTimeoutMs` | | `CONTEXTSCOPE_REQUEST_TIMEOUT_MS` | `600000` |
| `limits.maxResponseInspectBytes`, `maxRequestBytes`, `connectTimeoutMs`, `queueCapacity`, `maxSegments` | | | see `packages/shared/src/config.ts` |
| `customProviders` | | | `[]` (OpenAI-protocol upstreams, `trusted: true` required) |
| `webDir` | | `CONTEXTSCOPE_WEB_DIR` | bundled dashboard |
| `demo` | `--demo` / `contextscope demo` | | `false` |

Upstreams must be bare origins (`https://host[:port]`, no path, query or credentials).

## Validation and safety

Invalid values print each problem as `path: message (from flag|env|file)` and exit with code 2.
Binding to a non-loopback host without an auth token is refused; remote access additionally needs a TLS
terminating reverse proxy (see [deployment.md](deployment.md)).

## Demo mode

`contextscope demo` (or `start --demo`) seeds deterministic synthetic traces, labels the UI as demo and uses a
separate data dir (`.contextscope-demo`, or `<dataDir>/demo` when the data dir comes from env/file), so demo data
never mixes with real data. Use `status --demo` / `stop --demo` for it.

## Files in the data dir

`contextscope.db` (+ `-wal`, `-shm`), `fingerprint.key` (0600), `content.key` (deep_persistent only),
`contextscope.pid`, `contextscope.log` (when started with `--detach`).
