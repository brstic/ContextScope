import { describe, expect, it } from 'vitest';
import type { RawSegment } from '@contextscope/shared';
import {
  REDACTED,
  buildSegments,
  canonicalJson,
  createFingerprinter,
  redactHeaders,
  redactJson,
  redactText,
  redactUrl,
  sharedPrefixLength,
} from './index.js';

const key = Buffer.alloc(32, 7);
const seg = (kind: RawSegment['kind'], text: string, extra: Partial<RawSegment> = {}): RawSegment => ({
  kind,
  role: null,
  path: '/x',
  label: kind,
  exactText: text,
  normalizedText: text.replace(/\s+/g, ' ').trim(),
  plainText: text,
  cacheControl: null,
  messageIndex: null,
  multimodal: false,
  ...extra,
});

describe('fingerprints', () => {
  it('are keyed: different keys give different fingerprints', () => {
    const a = createFingerprinter(key).fp('hello');
    const b = createFingerprinter(Buffer.alloc(32, 8)).fp('hello');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
  });

  it('canonicalJson sorts keys but keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });
});

describe('buildSegments', () => {
  it('detects duplicates in request and estimates tokens, never claiming exactness', () => {
    const f = createFingerprinter(key);
    const out = buildSegments(
      [
        seg('system', 'You are helpful.'),
        seg('document', 'DOC  A'),
        seg('document', 'DOC A'),
        seg('image', 'x', { multimodal: true }),
      ],
      f,
    );
    expect(out[1]?.duplicateCountInRequest).toBe(1);
    expect(out[2]?.duplicateCountInRequest).toBe(1);
    expect(out[1]?.exactFingerprint).not.toBe(out[2]?.exactFingerprint);
    expect(out[0]?.tokenSource).toBe('estimated');
    expect(out[3]?.estimatedTokens).toBeNull();
    expect(out[3]?.tokenSource).toBe('unavailable');
    expect(out[0]?.content).toBeUndefined();
  });

  it('prefix fingerprints identify the first changed segment', () => {
    const f = createFingerprinter(key);
    const a = buildSegments([seg('tool_definition', 't1'), seg('system', 's'), seg('user', 'u1')], f);
    const b = buildSegments([seg('tool_definition', 't1-changed'), seg('system', 's'), seg('user', 'u1')], f);
    const c = buildSegments([seg('tool_definition', 't1'), seg('system', 's'), seg('user', 'u2')], f);
    expect(sharedPrefixLength(a, b)).toBe(0);
    expect(sharedPrefixLength(a, c)).toBe(2);
  });
});

describe('redaction', () => {
  it('removes credentials from headers, urls, text and json', () => {
    expect(redactHeaders({ Authorization: 'Bearer sk-abc', 'content-type': 'a' })).toEqual({
      authorization: REDACTED,
      'content-type': 'a',
    });
    const url = redactUrl('/v1beta/models/x:generateContent?key=AIzaSECRET&alt=sse');
    expect(url).not.toContain('AIzaSECRET');
    expect(url).toContain('alt=sse');
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    expect(redactText(`failed with ${secret}`)).not.toContain(secret);
    expect(JSON.stringify(redactJson({ api_key: 'x', nested: { text: secret } }))).not.toContain(secret);
  });
});
