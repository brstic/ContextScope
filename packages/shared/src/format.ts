/** Small formatting helpers shared by CLI and web. */

export const formatUsd = (nano: number | null | undefined): string => {
  if (nano === null || nano === undefined) return '—';
  const usd = nano / 1e9;
  if (usd === 0) return '$0.00';
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(5)}`;
  if (Math.abs(usd) < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const formatTokens = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
};

export const formatMs = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
};

export const formatPct = (r: number | null | undefined): string =>
  r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`;
