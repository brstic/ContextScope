import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { errorBody } from './errors.js';

const NO_BUILD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContextScope — dashboard not built</title>
</head>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:15vh auto;padding:0 1.5rem;color:#111">
<h1 style="font-size:1.5rem">ContextScope server is running</h1>
<p>The dashboard build was not found, so only the API is served.</p>
<p>Build it with:</p>
<pre style="background:#f4f4f5;padding:.75rem 1rem;border-radius:.5rem;overflow:auto">pnpm build</pre>
<p style="color:#555">This serves <code>apps/web/dist</code> and requires pnpm/node. The API itself is
available under <code>/api/</code> (see <code>/api/openapi.json</code>).</p>
</body>
</html>
`;

/**
 * Resolve the built dashboard directory: the webDir override, the directory bundled
 * with the package (dist/src/../..), or apps/web/dist from the current working directory.
 */
export const resolveWebDir = (webDir: string | null): string | null => {
  const candidates = [
    webDir,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../web/dist'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
  ].filter((d): d is string => typeof d === 'string' && d.length > 0);
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory() && existsSync(resolve(dir, 'index.html'))) return dir;
    } catch {
      /* candidate does not exist */
    }
  }
  return null;
};

/**
 * Serve the built dashboard (SPA) with @fastify/static, or a small explanation page when
 * no build exists. Path traversal is delegated to @fastify/static (root-bound, decoded
 * paths rejected).
 */
export const registerDashboard = (
  app: FastifyInstance,
  webDir: string | null,
  proxyPrefixes: string[] = ['/openai', '/anthropic', '/gemini'],
): void => {
  const dir = resolveWebDir(webDir);

  if (dir === null) {
    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? '/';
      if (
        url === '/api' ||
        url.startsWith('/api/') ||
        proxyPrefixes.some((p) => url === p || url.startsWith(`${p}/`))
      ) {
        void reply.code(404).type('application/json').send(errorBody('not_found', 'Not found'));
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        void reply
          .code(405)
          .type('application/json')
          .send(errorBody('method_not_allowed', 'Method not allowed'));
        return;
      }
      void reply.type('text/html; charset=utf-8').send(NO_BUILD_HTML);
    });
    return;
  }

  void app.register(fastifyStatic, { root: dir, prefix: '/' });

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '/';
    if (
      url === '/api' ||
      url.startsWith('/api/') ||
      proxyPrefixes.some((p) => url === p || url.startsWith(`${p}/`))
    ) {
      void reply.code(404).type('application/json').send(errorBody('not_found', 'Not found'));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      void reply
        .code(405)
        .type('application/json')
        .send(errorBody('method_not_allowed', 'Method not allowed'));
      return;
    }
    if (url.includes('..') || extname(url.split('?')[0] ?? '')) {
      void reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    void reply.sendFile('index.html');
  });
};
