export interface JsonArrayStreamParserOptions {
  /** Maximum UTF-8 size of one top-level element. Larger elements are skipped and counted malformed. Default 8 MiB. */
  maxObjectBytes?: number;
}

const DEFAULT_MAX_OBJECT_BYTES = 8 * 1024 * 1024;

const enum State {
  /** Before the opening '['. */
  BeforeArray,
  /** Inside the array, between elements. */
  BetweenElements,
  /** Inside a top-level element. */
  InElement,
  /** After the closing ']'. */
  Done,
}

/**
 * Incremental parser for one JSON array delivered in arbitrary chunks, as returned by
 * Gemini `streamGenerateContent` without `alt=sse`: `[{...}\r\n,{...}\r\n]`.
 *
 * Tracks string/escape state and nesting depth so that each top-level element is
 * handed to `JSON.parse` as soon as it is complete. Malformed elements are counted,
 * never thrown. Memory is bounded by `maxObjectBytes` per element.
 */
export class JsonArrayStreamParser {
  /** Successfully parsed elements. */
  objects = 0;
  /** Elements (or stray bytes) that could not be parsed. */
  malformed = 0;

  private readonly onObject: (o: unknown) => void;
  private readonly maxObjectBytes: number;
  private readonly decoder = new TextDecoder('utf-8');
  private state: State = State.BeforeArray;
  private buf = '';
  private bufBytes = 0;
  private depth = 0;
  private inString = false;
  private escape = false;
  private oversize = false;
  private stray = false;

  constructor(onObject: (o: unknown) => void, opts: JsonArrayStreamParserOptions = {}) {
    this.onObject = onObject;
    this.maxObjectBytes =
      opts.maxObjectBytes !== undefined && opts.maxObjectBytes > 0
        ? opts.maxObjectBytes
        : DEFAULT_MAX_OBJECT_BYTES;
  }

  push(chunk: Uint8Array): void {
    this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    this.feed(this.decoder.decode());
    if (this.state === State.InElement) {
      // Truncated stream: a primitive element may still be complete (e.g. `[1` → 1); objects are not.
      this.emit();
    }
    if (this.stray) this.malformed++;
    this.stray = false;
    this.state = State.Done;
  }

  private feed(text: string): void {
    let segStart = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (this.state === State.BeforeArray) {
        if (ch === '[') this.state = State.BetweenElements;
        else if (ch === '{') {
          // Tolerate a single bare object instead of an array.
          this.state = State.InElement;
          this.beginElement();
          segStart = i;
        } else if (ch !== '\ufeff' && !isWs(ch)) this.stray = true;
        if (this.state !== State.InElement) continue;
      } else if (this.state === State.BetweenElements) {
        if (isWs(ch) || ch === ',') continue;
        if (ch === ']') {
          this.state = State.Done;
          continue;
        }
        this.state = State.InElement;
        this.beginElement();
        segStart = i;
      }
      switch (this.state) {
        case State.InElement: {
          if (segStart === -1) segStart = i;
          if (this.depth === 0 && !this.inString) {
            // primitive element: ends at ',' / ']' / whitespace
            if (ch === ',' || ch === ']' || isWs(ch)) {
              this.append(text, segStart, i);
              segStart = -1;
              this.emit();
              if (ch === ']') this.state = State.Done;
              continue;
            }
          }
          const wasString = this.inString;
          this.step(ch);
          if (this.depth < 0) {
            // unbalanced closer: drop the element and resynchronise
            this.malformed++;
            this.beginElement();
            this.state = State.BetweenElements;
            segStart = -1;
            continue;
          }
          if (this.depth === 0 && !this.inString && (ch === '}' || ch === ']' || (wasString && ch === '"'))) {
            this.append(text, segStart, i + 1);
            segStart = -1;
            this.emit();
          }
          break;
        }
        case State.Done:
          if (!isWs(ch)) this.stray = true;
          break;
        default:
          break;
      }
    }
    if (this.state === State.InElement && segStart !== -1) this.append(text, segStart, text.length);
  }

  private beginElement(): void {
    this.buf = '';
    this.bufBytes = 0;
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.oversize = false;
  }

  /** Update string/escape/depth state for one character. */
  private step(ch: string): void {
    if (this.inString) {
      if (this.escape) this.escape = false;
      else if (ch === '\\') this.escape = true;
      else if (ch === '"') this.inString = false;
      return;
    }
    if (ch === '"') this.inString = true;
    else if (ch === '{' || ch === '[') this.depth++;
    else if (ch === '}' || ch === ']') this.depth--;
  }

  private append(text: string, from: number, to: number): void {
    if (to <= from || this.oversize) return;
    const piece = text.slice(from, to);
    this.bufBytes += Buffer.byteLength(piece, 'utf8');
    if (this.bufBytes > this.maxObjectBytes) {
      this.oversize = true;
      this.buf = '';
      return;
    }
    this.buf += piece;
  }

  private emit(): void {
    const text = this.buf;
    const oversize = this.oversize;
    this.beginElement();
    this.state = this.state === State.InElement ? State.BetweenElements : this.state;
    if (oversize) {
      this.malformed++;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.malformed++;
      return;
    }
    this.objects++;
    this.onObject(value);
  }
}

const isWs = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
