#!/usr/bin/env node
// Runs the demo dashboard behind a path prefix (e.g. a hosted preview at /app/<token>/).
// 1. builds apps/web with Vite `--base $BASE_PATH` into .preview/<prefix>/web (the normal dist stays untouched),
// 2. starts `contextscope demo` on 127.0.0.1:<internal port> (loopback, so no auth token is needed),
// 3. listens on $HOST:$PORT and forwards requests, stripping the prefix.
// Usage: BASE_PATH=/app/x/ PORT=3000 node scripts/preview-server.mjs
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = `/${(process.env.BASE_PATH ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
const prefix = base.replace(/\/$/, '');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const inner = Number(process.env.INNER_PORT ?? 3399);
// one build + data dir per prefix, so two previews (e.g. a hosted one and a local check) never overwrite each other
const slug = prefix.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
const webDir = resolve(root, '.preview', slug, 'web');
const dataDir = resolve(root, '.preview', slug, 'data');

const build = spawnSync(
  resolve(root, 'apps/web/node_modules/.bin/vite'),
  ['build', '--base', base, '--outDir', webDir, '--emptyOutDir'],
  { cwd: resolve(root, 'apps/web'), stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn(
  process.execPath,
  [resolve(root, 'packages/cli/dist/bin.js'), 'demo', '--port', String(inner), '--data-dir', dataDir],
  { cwd: root, stdio: 'inherit', env: { ...process.env, CONTEXTSCOPE_WEB_DIR: webDir, HOST: '', PORT: '' } },
);
child.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

http
  .createServer((req, res) => {
    let url = req.url ?? '/';
    if (prefix && (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))) {
      url = url.slice(prefix.length) || '/';
      if (url.startsWith('?')) url = `/${url}`;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${inner}` };
    delete headers.origin; // the preview frame has an opaque origin; the inner server is loopback-only
    const up = http.request({ host: '127.0.0.1', port: inner, method: req.method, path: url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('ContextScope is starting, reload in a moment.');
    });
    req.pipe(up);
  })
  .listen(port, host, () => console.log(`preview proxy on http://${host}:${port}${base} -> 127.0.0.1:${inner}`));
