export * from './domain.js';
export * from './import-format.js';
export * from './config.js';
export * from './api.js';
export * from './format.js';

export const CONTEXTSCOPE_VERSION = '1.0.0';

/** Optional integration headers an application may send; stripped before forwarding. */
export const CS_HEADERS = {
  session: 'x-contextscope-session',
  project: 'x-contextscope-project',
  trace: 'x-contextscope-trace',
} as const;

export const NANO_PER_USD = 1_000_000_000;
