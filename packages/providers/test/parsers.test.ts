import type { SseEvent } from '@contextscope/core';
import { describe, expect, it } from 'vitest';
import { JsonArrayStreamParser, SseParser } from '../src/index.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const parseSse = (
  chunks: Uint8Array[],
  opts?: { maxEventBytes?: number },
): { events: SseEvent[]; parser: SseParser } => {
  const events: SseEvent[] = [];
  const parser = new SseParser((e) => events.push(e), opts);
  for (const c of chunks) parser.push(c);
  parser.end();
  return { events, parser };
};

const parseSseText = (
  text: string,
  opts?: { maxEventBytes?: number },
): { events: SseEvent[]; parser: SseParser } => parseSse([enc(text)], opts);

/** Every way of splitting `bytes` into two chunks, plus one-byte-at-a-time. */
const allSplits = (bytes: Uint8Array): Uint8Array[][] => {
  const out: Uint8Array[][] = [];
  for (let i = 0; i <= bytes.length; i++) out.push([bytes.slice(0, i), bytes.slice(i)]);
  out.push(Array.from(bytes, (b) => Uint8Array.of(b)));
  return out;
};

const ev = (
  data: string,
  event: string | null = null,
  id: string | null = null,
  retry: number | null = null,
): SseEvent => ({
  event,
  data,
  id,
  retry,
});

describe('SseParser', () => {
  const sample =
    '\uFEFF: heartbeat\r\nevent: greet\r\ndata: Привет 👋 мир\r\nid: 7\r\n\r\n' +
    'data:no-space\rdata:  two spaces\r\r' +
    'retry: 1500\nunknown: x\ndata: {"a":"é"}\n\n' +
    ': ping\n\n' +
    'data\n\n' +
    'event: last\ndata: tail 🚀';

  const expected: SseEvent[] = [
    ev('Привет 👋 мир', 'greet', '7'),
    ev('no-space\n two spaces', null, '7'),
    ev('{"a":"é"}', null, '7', 1500),
    ev('', null, '7'),
    ev('tail 🚀', 'last', '7'),
  ];

  it('parses a mixed stream (BOM, CRLF, lone CR, comments, multiline, missing trailing blank line)', () => {
    const { events, parser } = parseSseText(sample);
    expect(events).toEqual(expected);
    expect(parser.events).toBe(5);
    expect(parser.comments).toBe(2);
    expect(parser.malformed).toBe(0);
  });

  it('yields identical events for a split at every byte boundary and byte-by-byte', () => {
    const bytes = enc(sample);
    for (const chunks of allSplits(bytes)) {
      expect(parseSse(chunks).events).toEqual(expected);
    }
  });

  it('handles several events in one chunk', () => {
    const { events } = parseSseText('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    expect(events.map((e) => e.data)).toEqual(['1', '2', '3']);
  });

  it('decodes multi-byte UTF-8 split mid-sequence', () => {
    const text = 'data: 🙂 Ж ✓\n\n';
    const bytes = enc(text);
    // emoji starts at byte 6 and is 4 bytes long: split inside it
    for (let i = 7; i <= 9; i++) {
      const { events } = parseSse([bytes.slice(0, i), bytes.slice(i)]);
      expect(events).toEqual([ev('🙂 Ж ✓')]);
    }
  });

  it('treats CR at the end of one chunk and LF at the start of the next as one line ending', () => {
    const { events } = parseSse([enc('data: a\r'), enc('\ndata: b\r'), enc('\n\r'), enc('\n')]);
    expect(events).toEqual([ev('a\nb')]);
  });

  it('joins multiline data with \\n', () => {
    const { events } = parseSseText('data: line1\ndata: line2\ndata:\ndata: line4\n\n');
    expect(events).toEqual([ev('line1\nline2\n\nline4')]);
  });

  it('does not dispatch events without data lines', () => {
    const { events, parser } = parseSseText('event: nothing\n\nid: 3\n\n\n\n: only a comment\n\n');
    expect(events).toEqual([]);
    expect(parser.events).toBe(0);
    expect(parser.comments).toBe(1);
  });

  it('dispatches a pending event on end() without a trailing blank line', () => {
    expect(parseSseText('data: done').events).toEqual([ev('done')]);
    expect(parseSseText('data: done\n').events).toEqual([ev('done')]);
  });

  it('drops oversize events, counts them malformed and keeps parsing', () => {
    const big = 'x'.repeat(5000);
    const { events, parser } = parseSseText(`data: small\n\ndata: ${big}\ndata: more\n\ndata: after\n\n`, {
      maxEventBytes: 1024,
    });
    expect(events.map((e) => e.data)).toEqual(['small', 'after']);
    expect(parser.malformed).toBe(1);
  });

  it('stays bounded when an oversize line arrives in many small chunks', () => {
    const events: SseEvent[] = [];
    const p = new SseParser((e) => events.push(e), { maxEventBytes: 256 });
    p.push(enc('data: '));
    for (let i = 0; i < 1000; i++) p.push(enc('y'.repeat(100)));
    p.push(enc('\n\ndata: ok\n\n'));
    p.end();
    expect(events.map((e) => e.data)).toEqual(['ok']);
    expect(p.malformed).toBe(1);
  });

  it('counts multibyte bytes, not chars, against the limit', () => {
    const { events, parser } = parseSseText(`data: ${'Ж'.repeat(100)}\n\n`, { maxEventBytes: 150 });
    expect(events).toEqual([]);
    expect(parser.malformed).toBe(1);
  });
});

describe('JsonArrayStreamParser', () => {
  const parseArr = (chunks: Uint8Array[]): { objects: unknown[]; parser: JsonArrayStreamParser } => {
    const objects: unknown[] = [];
    const parser = new JsonArrayStreamParser((o) => objects.push(o));
    for (const c of chunks) parser.push(c);
    parser.end();
    return { objects, parser };
  };

  const items = [
    { a: 1, s: 'brackets ] [ } { inside', nested: { arr: [1, [2, 3], { x: null }] } },
    { esc: 'quote \\" and \\\\ backslash "', emoji: '👋 Привет' },
    { t: true },
  ];
  const text = `[${items.map((o) => JSON.stringify(o, null, 2)).join('\r\n,\r\n')}]`;

  it('parses a pretty-printed array', () => {
    const { objects, parser } = parseArr([enc(text)]);
    expect(objects).toEqual(items);
    expect(parser.objects).toBe(3);
    expect(parser.malformed).toBe(0);
  });

  it('gives identical objects for a split at every byte boundary', () => {
    for (const chunks of allSplits(enc(text))) {
      expect(parseArr(chunks).objects).toEqual(items);
    }
  });

  it('handles an empty array and leading whitespace', () => {
    expect(parseArr([enc('  \n[ ]  ')]).objects).toEqual([]);
  });

  it('counts malformed elements without throwing', () => {
    const { objects, parser } = parseArr([enc('[{"ok":1},{"bad":},{"ok":2}]')]);
    expect(objects).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(parser.malformed).toBe(1);
  });

  it('does not emit a truncated object', () => {
    const { objects } = parseArr([enc('[{"ok":1},{"partial":')]);
    expect(objects).toEqual([{ ok: 1 }]);
  });

  it('skips oversize elements', () => {
    const objects: unknown[] = [];
    const p = new JsonArrayStreamParser((o) => objects.push(o), { maxObjectBytes: 64 });
    p.push(enc(`[{"big":"${'z'.repeat(500)}"},{"small":1}]`));
    p.end();
    expect(objects).toEqual([{ small: 1 }]);
    expect(p.malformed).toBe(1);
  });
});
