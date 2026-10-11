import { demoTraces } from '@contextscope/test-fixtures';
import type { ImportResult } from '@contextscope/shared';
import type { Pipeline, Store } from '../types.js';

export const DEMO_SETTING = 'demoSeeded';
/** Bump when the demo data set changes so existing installs re-seed (ids are deterministic: duplicates are skipped). */
export const DEMO_VERSION = 1;

/** Seed deterministic demo traces once per DEMO_VERSION. Idempotent. Returns null when already seeded. */
export const seedDemo = (pipeline: Pipeline, store: Store): ImportResult | null => {
  if (store.getSetting<number>(DEMO_SETTING) === DEMO_VERSION) return null;
  const result = pipeline.importTraces(demoTraces(), { demo: true, origin: 'demo' });
  store.setSetting(DEMO_SETTING, DEMO_VERSION);
  return result;
};
