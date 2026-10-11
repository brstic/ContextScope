# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting
(repository → Security → "Report a vulnerability"). Do not open public issues for security problems.
We aim to acknowledge reports within 3 working days and to ship a fix or mitigation within 30 days.
Only the latest release receives security fixes.

## Threat model

ContextScope is a **local-first** developer tool. It sits between your application and LLM providers, so it
sees API keys and prompts in transit. Its design goals:

- **Local by default.** It binds to `127.0.0.1:3377`. Binding to any non-loopback address is refused unless
  an auth token (`--auth-token` / `CONTEXTSCOPE_AUTH_TOKEN`, at least 16 characters) is configured.
- **Secrets are never stored.** `authorization`, `x-api-key`, `x-goog-api-key`, `?key=` and similar
  credentials are forwarded to the upstream but stripped before anything reaches logs, the database,
  exports or error messages.
- **Metadata-only capture by default.** No prompt or response text is stored; only sizes, keyed HMAC-SHA256
  fingerprints (per-install key `fingerprint.key`, mode 0600), usage, timing and cost.
- **Deep capture is opt-in.** `deep_memory` keeps content in a bounded in-process buffer only.
  `deep_persistent` stores content AES-256-GCM encrypted with an expiry, using `content.key` in the data dir.
  Deleting `content.key` crypto-shreds all stored content immediately (it can no longer be decrypted).
- **Fixed upstreams.** Requests are only forwarded to allow-listed origins from the startup configuration;
  request headers can never choose the upstream. Path traversal and authority tricks are rejected.
- **Dashboard/API hardening.** Bearer auth when a token is set, CSRF header for state-changing requests,
  same-origin check, no CORS, CSP and other security headers.

## Remote deployment

ContextScope speaks plain HTTP. For any access beyond localhost you must:

1. set an auth token (`CONTEXTSCOPE_AUTH_TOKEN`, e.g. `openssl rand -hex 32`), and
2. terminate TLS in a reverse proxy (Caddy, nginx, Traefik) in front of it.

See [docs/deployment.md](docs/deployment.md). Anyone who can reach the proxy routes can use them to call
providers with their own keys; restrict network access accordingly.

## Out of scope

Attacks that require local access to the data dir or to the running user account, and the security of the
upstream providers themselves.
