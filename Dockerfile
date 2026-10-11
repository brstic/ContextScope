# syntax=docker/dockerfile:1.7
# ---- builder ---------------------------------------------------------------
FROM node:25-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# better-sqlite3 falls back to a source build when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Self-contained production install of the CLI (and its workspace deps) in /out.
RUN pnpm deploy --filter contextscope --prod /out \
  && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist

# ---- runtime ---------------------------------------------------------------
FROM node:25-bookworm-slim
ENV NODE_ENV=production \
    CONTEXTSCOPE_DATA_DIR=/data \
    CONTEXTSCOPE_HOST=0.0.0.0 \
    CONTEXTSCOPE_PORT=3377 \
    CONTEXTSCOPE_WEB_DIR=/app/web/dist
# CONTEXTSCOPE_HOST is non-loopback, so CONTEXTSCOPE_AUTH_TOKEN (>= 16 chars) MUST be provided
# at run time: the CLI refuses to start without it.
RUN groupadd --system --gid 10001 contextscope \
  && useradd --system --uid 10001 --gid contextscope --home-dir /data --shell /usr/sbin/nologin contextscope \
  && mkdir -p /data && chown contextscope:contextscope /data
WORKDIR /app
COPY --from=builder --chown=root:root /out /app
USER contextscope
VOLUME ["/data"]
EXPOSE 3377
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3377/api/health',{headers:process.env.CONTEXTSCOPE_AUTH_TOKEN?{authorization:'Bearer '+process.env.CONTEXTSCOPE_AUTH_TOKEN}:{}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["start"]
