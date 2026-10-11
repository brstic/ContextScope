import { getAdapter } from '@contextscope/providers';
import type { ContextScopeConfig, ProviderId } from '@contextscope/shared';
import type { Route } from '../types.js';

export type { Route } from '../types.js';

export class InvalidProxyPath extends Error {
  readonly statusCode = 400;
  constructor() {
    super('Invalid proxy request target');
  }
}

/** Only startup configuration supplies an origin; request headers never do. */
export function buildRoutes(config: ContextScopeConfig): Route[] {
  const builtins: ProviderId[] = ['openai', 'anthropic', 'gemini'];
  return [
    ...builtins.map((name): Route => ({
      prefix: `/${name}`,
      name,
      protocol: name,
      adapter: getAdapter(name),
      upstream: config.upstreams[name].replace(/\/$/, ''),
      custom: false,
    })),
    ...config.customProviders.map((p): Route => ({
      prefix: `/${p.name}`,
      name: p.name,
      protocol: p.protocol,
      adapter: getAdapter(p.protocol),
      upstream: p.upstream.replace(/\/$/, ''),
      custom: true,
    })),
  ];
}

export interface ResolvedRoute {
  route: Route;
  restPath: string;
  query: string;
}

export function resolveRoute(routes: Route[], url: string): ResolvedRoute | null {
  if (!url.startsWith('/') || url.startsWith('//')) throw new InvalidProxyPath();
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const route = routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
  if (!route) return null;
  // Validate decoded layers, but forward the ORIGINAL target. Never URL-resolve it:
  // URL resolution would normalise dot segments and permit authority replacement.
  let decoded = path;
  for (let depth = 0; ; depth++) {
    if (
      decoded.includes('\\') ||
      decoded.includes('//') ||
      /(^|\/)\.{1,2}(\/|$)/.test(decoded) ||
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
      /[\u0000-\u0020\u007f#]/.test(decoded)
    )
      throw new InvalidProxyPath();
    if (!/%[\da-f]{2}/i.test(decoded)) break;
    if (depth >= 8) throw new InvalidProxyPath();
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new InvalidProxyPath();
    }
  }
  return { route, restPath: path.slice(route.prefix.length) || '/', query: q < 0 ? '' : url.slice(q) };
}
