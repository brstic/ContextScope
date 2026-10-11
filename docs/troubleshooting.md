# Troubleshooting

Start with `contextscope doctor`: it checks Node (≥ 22.12), the data dir, SQLite (WAL), the port, the dashboard
build, DNS for the default upstreams and the configuration. ✗ lines are failures (exit code 1), ! lines warnings.

| Symptom | Cause / fix |
|---|---|
| `Refusing to listen on non-loopback host` | Set `--auth-token` / `CONTEXTSCOPE_AUTH_TOKEN` (≥ 16 chars) and use a TLS reverse proxy ([deployment.md](deployment.md)). |
| `Invalid configuration:` + paths, exit 2 | Fix the listed values; `contextscope config` shows where each value came from. |
| `EADDRINUSE` / port in use | Another program uses 3377: `--port 3400`. `contextscope status` shows if ContextScope itself runs. |
| `already running (pid …)` | `contextscope stop` (add `--demo` for the demo instance). |
| Status says stale pid file | The process died; the file was cleaned up. Check `<dataDir>/contextscope.log` for detached runs. |
| Dashboard says “not built” | Run `pnpm build`, or set `CONTEXTSCOPE_WEB_DIR`. |
| SDK gets 404 | Check the base URL: OpenAI needs `/openai/v1`, Anthropic `/anthropic` (no `/v1`), Gemini `/gemini/v1beta/...`. |
| `502 contextscope_upstream_error` | Upstream unreachable (DNS, firewall, proxy). `doctor` shows DNS warnings. |
| `504` after a long pause | Upstream sent nothing for `CONTEXTSCOPE_REQUEST_TIMEOUT_MS` (default 10 min). |
| Usage shows “unavailable” for streamed OpenAI chat | Send `stream_options: { include_usage: true }`. |
| No cache reads on Anthropic | Prefix changed before the breakpoint, it is below the minimum cacheable length, or the TTL (5 min) expired. See the Cache page and findings. |
| `401` in the dashboard | Enter the auth token; API clients send `Authorization: Bearer <token>`. |
| `better-sqlite3` fails to load | Reinstall for your Node version (`pnpm rebuild better-sqlite3`); needs build tools if no prebuilt binary exists. |
| Data dir not writable (Docker) | The container runs as uid 10001; the `/data` volume must be writable by it. |

Logs: foreground runs print to the terminal; `--detach` writes `<dataDir>/contextscope.log`; Docker:
`docker compose logs`. Logs never contain API keys or prompt text. When filing a bug, include `doctor` output
and never paste keys.
