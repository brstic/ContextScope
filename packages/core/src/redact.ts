/**
 * Secret redaction. Applied before anything reaches logs, the database, exports,
 * error messages or the dashboard.
 */

export const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
  'openai-organization',
  'openai-project',
  'anthropic-admin-api-key',
  'x-amz-security-token',
]);

export const SECRET_QUERY_PARAMS = new Set([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'auth',
  'signature',
  'sig',
  'x-goog-api-key',
]);

export const REDACTED = '<redacted>';

export const redactHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    out[key] = SECRET_HEADERS.has(key) ? REDACTED : Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
};

/** Redact secret query params in a path+query or full URL string. */
export const redactUrl = (url: string): string => {
  const qIndex = url.indexOf('?');
  if (qIndex < 0) return url;
  const base = url.slice(0, qIndex);
  const params = new URLSearchParams(url.slice(qIndex + 1));
  const parts: string[] = [];
  for (const [k, v] of params) {
    const value = SECRET_QUERY_PARAMS.has(k.toLowerCase()) ? REDACTED : encodeURIComponent(v);
    parts.push(`${encodeURIComponent(k)}=${value}`);
  }
  return `${base}?${parts.join('&')}`;
};

// Patterns for well-known credential formats that may leak into bodies or error text.
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /ya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /(?<=bearer\s)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(?<=[?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi,
];

/** Remove credential-looking strings from free text. */
export const redactText = (text: string): string => {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out;
};

const SECRET_KEY_RE = /(^|_|-)(api_?key|secret|password|access_token|refresh_token|authorization)$/;

/** Deep-redact a JSON value: secret-named keys and credential-looking strings. */
export const redactJson = (value: unknown, depth = 0): unknown => {
  if (depth > 64) return '<truncated>';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    out[k] = SECRET_HEADERS.has(key) || SECRET_KEY_RE.test(key) ? REDACTED : redactJson(v, depth + 1);
  }
  return out;
};
