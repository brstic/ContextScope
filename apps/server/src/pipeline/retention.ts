import type { ContextScopeConfig } from '@contextscope/shared';
import type { Store } from '../types.js';

export const RETENTION_INTERVAL_MS = 10 * 60_000;

/**
 * Run store.cleanup now and every 10 minutes (unref'd timer, never keeps the process alive).
 * Errors are passed to `onError` (default: ignored). Returns a stop function.
 */
export const startRetention = (
  store: Store,
  config: ContextScopeConfig,
  getNow: () => number = Date.now,
  onError: (err: unknown) => void = () => {},
): (() => void) => {
  const run = (): void => {
    try {
      store.cleanup(getNow(), config.capture.metadataRetentionDays);
    } catch (err) {
      onError(err);
    }
  };
  run();
  const timer = setInterval(run, RETENTION_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
};
