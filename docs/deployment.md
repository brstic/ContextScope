# Deployment

ContextScope is meant to run next to your application. The defaults (`127.0.0.1:3377`) are local-only.

## Local (npm / source)

```sh
pnpm install && pnpm build
pnpm start                                   # foreground, Ctrl+C to stop
node packages/cli/dist/bin.js start --detach # background; log in .contextscope/contextscope.log
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js stop           # SIGTERM, waits up to 10 s
```

## Docker

The image binds `0.0.0.0` inside the container, so an auth token is **required** (the CLI refuses otherwise).

```sh
docker build -t contextscope .
export CONTEXTSCOPE_AUTH_TOKEN=$(openssl rand -hex 32)
docker run -d --name contextscope -p 127.0.0.1:3377:3377 \
  -e CONTEXTSCOPE_AUTH_TOKEN -v contextscope-data:/data contextscope
docker stop contextscope    # graceful (SIGTERM)
docker start contextscope
```

With compose (publishes on `127.0.0.1` only):

```sh
CONTEXTSCOPE_AUTH_TOKEN=$(openssl rand -hex 32) docker compose up -d --build
docker compose logs -f
docker compose down          # data stays in the contextscope-data volume
```

**Upgrade:** `git pull && docker compose up -d --build` (or pull the new image tag). Migrations run on start;
back up the volume first (`docker run --rm -v contextscope-data:/data -v "$PWD":/b busybox tar czf /b/cs.tgz /data`).

The container runs as user `contextscope` (uid 10001); data lives in `/data`. The health check calls
`/api/health` with the token.

## Remote access (auth + TLS)

ContextScope speaks plain HTTP. For anything beyond localhost:

1. set `CONTEXTSCOPE_AUTH_TOKEN` (at least 16 characters), and
2. put a TLS-terminating reverse proxy in front, keeping ContextScope itself on loopback.

Caddy example (`Caddyfile`), with ContextScope published on `127.0.0.1:3377`:

```caddy
contextscope.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3377 {
		flush_interval -1   # do not buffer SSE streams
	}
}
```

The dashboard asks for the token and sends it as `Authorization: Bearer <token>` on `/api/*`. The proxy routes
(`/openai`, `/anthropic`, `/gemini`) carry the caller's own provider keys; restrict who can reach them (firewall,
VPN, Caddy `basicauth` or IP matchers on those paths).
