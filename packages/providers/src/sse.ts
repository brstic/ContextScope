import type { SseEvent } from '@contextscope/core';

export interface SseParserOptions {
  /** Maximum UTF-8 size of one event (all its lines). Larger events are dropped and counted malformed. Default 4 MiB. */
  maxEventBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 4 * 1024 * 1024;
const LF = 10;
const CR = 13;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Incremental Server-Sent Events parser following the WHATWG event-stream rules
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream):
 *
 *  - UTF-8 decoding is streaming, so multi-byte sequences may be split across chunks;
 *  - lines end with CRLF, LF or a lone CR (also when CR ends one chunk and LF starts the next);
 *  - a leading BOM is ignored; lines starting with ':' are comments (heartbeats);
 *  - `field: value` strips exactly one leading space from the value; a line without ':' is a field with empty value;
 *  - `data` lines are joined with '\n'; `event`, `id`, `retry` are honoured, unknown fields ignored;
 *  - a blank line dispatches; an event without data lines is not dispatched.
 *
 * Deviation (documented): `end()` dispatches a pending event that lacks the trailing blank line,
 * because some upstreams close the connection right after the last `data:` line.
 *
 * Memory is bounded: the pending line plus the pending event never exceed `maxEventBytes`;
 * an oversize event is discarded up to its terminating blank line and counted as malformed.
 */
export class SseParser {
  /** Dispatched events. */
  events = 0;
  /** Dropped events (oversize). */
  malformed = 0;
  /** Comment lines (heartbeats). */
  comments = 0;

  private readonly onEvent: (e: SseEvent) => void;
  private readonly maxEventBytes: number;
  private readonly decoder = new TextDecoder('utf-8');
  private started = false;
  private lastWasCR = false;
  private line = '';
  private lineHasChars = false;
  private lineBytes = 0;
  private data: string[] = [];
  private dataBytes = 0;
  private eventType: string | null = null;
  private lastEventId: string | null = null;
  private retry: number | null = null;
  private discarding = false;
  private ended = false;

  constructor(onEvent: (e: SseEvent) => void, opts: SseParserOptions = {}) {
    this.onEvent = onEvent;
    this.maxEventBytes =
      opts.maxEventBytes !== undefined && opts.maxEventBytes > 0
        ? opts.maxEventBytes
        : DEFAULT_MAX_EVENT_BYTES;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flush the decoder and dispatch a pending event that lacks the final blank line. */
  end(): void {
    if (this.ended) return;
    this.feed(this.decoder.decode());
    this.ended = true;
    if (this.lineHasChars) this.processLine();
    this.finishEvent();
  }

  private feed(text: string): void {
    if (text.length === 0) return;
    let start = 0;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (this.lastWasCR) {
        this.lastWasCR = false;
        if (c === LF) {
          // second half of a CRLF split (possibly across chunks)
          start = i + 1;
          continue;
        }
      }
      if (c === LF || c === CR) {
        this.appendToLine(text, start, i);
        this.processLine();
        if (c === CR) this.lastWasCR = true;
        start = i + 1;
      }
    }
    this.appendToLine(text, start, text.length);
  }

  private appendToLine(text: string, from: number, to: number): void {
    if (to <= from) return;
    this.lineHasChars = true;
    if (this.discarding) return;
    const piece = text.slice(from, to);
    this.lineBytes += utf8Bytes(piece);
    if (this.lineBytes + this.dataBytes > this.maxEventBytes) {
      this.startDiscarding();
      return;
    }
    this.line += piece;
  }

  private startDiscarding(): void {
    this.discarding = true;
    this.line = '';
    this.lineBytes = 0;
    this.data = [];
    this.dataBytes = 0;
  }

  private processLine(): void {
    const blank = !this.lineHasChars;
    const line = this.line;
    this.line = '';
    this.lineBytes = 0;
    this.lineHasChars = false;
    if (blank) {
      this.finishEvent();
      return;
    }
    if (this.discarding) return;
    if (line.charCodeAt(0) === 58 /* ':' */) {
      this.comments++;
      return;
    }
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32 /* ' ' */) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        this.data.push(value);
        // +1 for the joining newline
        this.dataBytes += utf8Bytes(value) + 1;
        if (this.dataBytes > this.maxEventBytes) this.startDiscarding();
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  private finishEvent(): void {
    if (this.discarding) {
      this.malformed++;
      this.discarding = false;
    } else if (this.data.length > 0) {
      const event: SseEvent = {
        event: this.eventType !== null && this.eventType.length > 0 ? this.eventType : null,
        data: this.data.join('\n'),
        id: this.lastEventId,
        retry: this.retry,
      };
      this.events++;
      this.resetEvent();
      this.onEvent(event);
      return;
    }
    this.resetEvent();
  }

  private resetEvent(): void {
    this.data = [];
    this.dataBytes = 0;
    this.eventType = null;
    this.retry = null;
  }
}
