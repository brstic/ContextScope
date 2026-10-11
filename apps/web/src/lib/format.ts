// Import the formatters directly (not the shared index) so zod never enters the browser bundle:
// zod uses `new Function`, which the dashboard's strict CSP (no 'unsafe-eval') blocks.
import { formatMs, formatPct, formatTokens, formatUsd } from '@contextscope/shared/format';

export { formatMs, formatPct, formatTokens, formatUsd };

/** Placeholder for numbers the provider did not report. Never render unknown as 0. */
export const UNKNOWN = '—';
export const UNKNOWN_HINT = 'Not reported by the provider';

export const isUnknown = (v: unknown): v is null | undefined => v === null || v === undefined;

export const formatInt = (n: number | null | undefined): string =>
  isUnknown(n) ? UNKNOWN : n.toLocaleString('en-US');

export const formatBytes = (n: number | null | undefined): string => {
  if (isUnknown(n)) return UNKNOWN;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

export const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleString('en-GB', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export const formatBucket = (iso: string, bucket: 'hour' | 'day' = 'hour'): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return bucket === 'day'
    ? d.toLocaleDateString('en-GB', { month: 'short', day: '2-digit' })
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

export const formatRelative = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return UNKNOWN;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return UNKNOWN;
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Signed delta, e.g. "+1,204" / "−3.2k"; unknown when either side is unknown. */
export const formatDelta = (
  a: number | null | undefined,
  b: number | null | undefined,
  fmt: (n: number) => string = (n) => formatTokens(n),
): string => {
  if (isUnknown(a) || isUnknown(b)) return UNKNOWN;
  const d = b - a;
  if (d === 0) return '±0';
  return `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
};

export const shortId = (id: string | null | undefined, n = 8): string => (id ? id.slice(0, n) : UNKNOWN);

export const shortFingerprint = (fp: string | null | undefined): string => (fp ? fp.slice(0, 8) : UNKNOWN);

export const providerLabel = (p: string): string =>
  p === 'openai' ? 'OpenAI' : p === 'anthropic' ? 'Anthropic' : p === 'gemini' ? 'Gemini' : p;

export const stateLabel = (s: string): string =>
  ({
    pending: 'Pending',
    completed: 'Completed',
    client_aborted: 'Client aborted',
    upstream_error: 'Upstream error',
    rejected: 'Rejected',
  })[s] ?? s;

export const kindLabel = (k: string | null | undefined): string =>
  k
    ? (({
        tool_definition: 'Tool definition',
        system: 'System',
        developer: 'Developer',
        user: 'User',
        assistant: 'Assistant',
        tool_call: 'Tool call',
        tool_result: 'Tool result',
        document: 'Document',
        schema: 'Schema',
        image: 'Image',
        audio: 'Audio',
        file: 'File',
        cached_content_ref: 'Cached content ref',
        config: 'Config',
        other: 'Other',
      }) as Record<string, string>)[k] ?? k
    : UNKNOWN;

export const findingTypeLabel = (t: string): string =>
  t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
