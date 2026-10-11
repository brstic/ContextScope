import { createHmac, randomBytes } from 'node:crypto';

/**
 * Locally keyed fingerprints (HMAC-SHA256). The key never leaves the machine and is
 * generated per installation, so stored fingerprints cannot be matched against
 * dictionaries of known prompts by anyone without the key.
 */
export interface Fingerprinter {
  /** 128-bit hex digest of the text. */
  fp(text: string): string;
  /** Cumulative prefix fingerprint: fp(previousPrefix + ":" + segmentFp). */
  chain(previousPrefix: string | null, segmentFp: string): string;
}

export const generateFingerprintKey = (): Buffer => randomBytes(32);

export const createFingerprinter = (key: Buffer | string): Fingerprinter => {
  const k = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  if (k.length < 16) throw new Error('fingerprint key must be at least 16 bytes');
  const fp = (text: string): string => createHmac('sha256', k).update(text, 'utf8').digest('hex').slice(0, 32);
  return {
    fp,
    chain: (prev, seg) => fp(`${prev ?? ''}:${seg}`),
  };
};

/**
 * Canonical JSON for "normalized structural match": object keys sorted, no whitespace.
 * Arrays keep their order (ordering matters to models and to caching).
 */
export const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value)) ?? 'null';
};

/** Whitespace-normalised text for "normalized duplicate" detection of prose. */
export const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();
