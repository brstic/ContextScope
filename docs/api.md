# REST API

The dashboard uses a JSON API under `/api`. The machine-readable description is served at
**`GET /api/openapi.json`** (OpenAPI 3) by a running instance.

## Auth and CSRF

- With an auth token configured, every `/api/*` request needs `Authorization: Bearer <token>`
  (`/api/events` also accepts `?token=` because EventSource cannot set headers).
- Non-GET requests need `x-contextscope-csrf: 1`; a present `Origin` must match `Host`. No CORS headers are sent.

## Endpoints (overview)

| Method & path | Purpose |
|---|---|
| `GET /api/health` | liveness, version, demo flag, queue stats |
| `GET /api/overview` | headline metrics for a time range |
| `GET /api/requests`, `/api/requests/:id` | request list (filters, paging) and detail |
| `GET /api/requests/:id/context`, `/content`, `/findings` | segments, deep-captured content (if any), findings |
| `GET /api/sessions`, `/api/sessions/:id` | sessions (`x-contextscope-session`) |
| `GET /api/cache/summary`, `/api/cache/trends` | cache hit ratio, reads/writes by provider and model |
| `GET /api/costs/summary`, `/api/costs/trends` | estimated costs and the price catalog version |
| `GET /api/optimizations` | findings across requests (`severity`, `type`) |
| `GET /api/compare?a=&b=` | prefix comparison of two requests |
| `GET /api/providers`, `/api/filters` | configured routes; filter values |
| `GET/PUT /api/settings` | capture mode, retention, pricing overrides |
| `GET /api/export`, `POST /api/import` | export records; import `contextscope.trace` files |
| `GET /api/events` | Server-Sent Events live feed |

Errors have the shape `{ "error": { "type": "...", "message": "..." } }`. Money is integer nano-USD;
unknown values are `null`, never 0.
