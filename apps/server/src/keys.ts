import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-installation secret keys, stored as hex in `dataDir` (dir 0700, files 0600):
 *
 *   fingerprint.key  HMAC key for segment fingerprints. Losing it only means new fingerprints
 *                    no longer match old ones (duplicate/prefix history restarts).
 *   content.key      AES-256-GCM key for deep-capture content persisted in the database
 *                    (capture mode `deep_persistent`). Deleting this file makes every persisted
 *                    content blob permanently unreadable (crypto-shredding); metadata stays intact.
 *
 * Keys never leave the machine and are never logged.
 */
export interface Keys {
  fingerprintKey: Buffer;
  contentKey: Buffer;
}

export const FINGERPRINT_KEY_FILE = 'fingerprint.key';
export const CONTENT_KEY_FILE = 'content.key';
const KEY_BYTES = 32;

const loadOrCreate = (dir: string, file: string, minBytes: number): Buffer => {
  const path = join(dir, file);
  if (!existsSync(path)) {
    const key = randomBytes(KEY_BYTES);
    try {
      // 'wx': never overwrite a key another process created in the meantime.
      writeFileSync(path, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const text = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    throw new Error(`${file} is not a valid hex key (delete it to generate a new one)`);
  }
  const key = Buffer.from(text, 'hex');
  if (key.length < minBytes) throw new Error(`${file} must contain at least ${minBytes} bytes`);
  return key;
};

export const loadOrCreateKeys = (dataDir: string): Keys => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // not fatal (e.g. a directory owned by someone else); files are still 0600
  }
  const fingerprintKey = loadOrCreate(dataDir, FINGERPRINT_KEY_FILE, 16);
  const contentKey = loadOrCreate(dataDir, CONTENT_KEY_FILE, KEY_BYTES).subarray(0, KEY_BYTES);
  return { fingerprintKey, contentKey };
};
