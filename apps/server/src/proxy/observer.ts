import * as zlib from 'node:zlib';
import type { Transform } from 'node:stream';
import { SseParser, JsonArrayStreamParser } from '@contextscope/providers';
import type { SseEvent, StreamAccumulator } from '@contextscope/core';
import type { CapturedExchange } from '../types.js';

/** Bounded analysis-only copy. A slow decompressor is dropped, never awaited by push(). */
export class ResponseObserver {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private stopped = false;
  private parser: SseParser | JsonArrayStreamParser | null = null;
  private accumulator: StreamAccumulator | null = null;
  private decoder: Transform | null = null;
  private decoderDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly exchange: CapturedExchange,
    private readonly limit: number,
    encoding: string,
    private readonly elapsed: () => number,
    private readonly warn: () => void,
  ) {
    if (!exchange.match) {
      this.stopped = true;
      return;
    }
    try {
      const sse = exchange.responseContentType?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
      exchange.isStream = sse || exchange.match.streamFromPath;
      if (exchange.isStream) {
        this.accumulator = exchange.route.adapter.createStreamAccumulator(exchange.match);
        const feed = (event: SseEvent): void => {
          const result = this.accumulator?.onEvent(event);
          if (result?.meaningfulOutput && exchange.ttftMs === null) exchange.ttftMs = elapsed();
        };
        this.parser = sse
          ? new SseParser(feed, { maxEventBytes: limit })
          : new JsonArrayStreamParser(
              (obj) => feed({ event: null, data: JSON.stringify(obj), id: null, retry: null }),
              { maxObjectBytes: limit },
            );
      }
      switch (encoding.trim().toLowerCase()) {
        case '':
        case 'identity':
          break;
        case 'gzip':
          this.decoder = zlib.createGunzip();
          break;
        case 'br':
          this.decoder = zlib.createBrotliDecompress();
          break;
        case 'deflate':
          this.decoder = zlib.createInflate();
          break;
        case 'zstd': {
          // Available on recent Node 22; gracefully disable analysis on older runtimes.
          const factory = (zlib as unknown as { createZstdDecompress?: () => Transform })
            .createZstdDecompress;
          if (!factory) throw new Error('Unsupported encoding');
          this.decoder = factory();
          break;
        }
        default:
          throw new Error('Unsupported encoding');
      }
      if (this.decoder) {
        const decoder = this.decoder;
        this.decoderDone = new Promise((resolve) => {
          decoder.once('end', resolve);
          decoder.once('close', resolve);
          decoder.once('error', () => {
            this.stop();
            resolve();
          });
        });
        decoder.on('data', (chunk: Buffer) => this.inspect(chunk));
      }
    } catch {
      this.stop();
    }
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.exchange.responseTruncated = true;
    this.decoder?.destroy();
    this.warn();
  }

  private inspect(chunk: Buffer): void {
    if (this.stopped) return;
    try {
      if (this.bytes + chunk.length > this.limit) {
        this.stop();
        return;
      }
      this.bytes += chunk.length;
      if (this.parser) this.parser.push(chunk);
      else this.chunks.push(Buffer.from(chunk));
    } catch {
      this.stop();
    }
  }

  push(chunk: Buffer): void {
    if (this.stopped) return;
    try {
      if (!this.decoder) this.inspect(chunk);
      else if (this.decoder.writableLength + chunk.length > Math.min(this.limit, 1024 * 1024)) this.stop();
      else this.decoder.write(chunk);
    } catch {
      this.stop();
    }
  }

  async finish(completed: boolean): Promise<void> {
    if (this.decoder && !this.stopped) this.decoder.end();
    await this.decoderDone;
    try {
      if (!this.stopped) this.parser?.end();
      if (this.accumulator) {
        this.exchange.streamResult = this.accumulator.finish(completed && !this.stopped);
        this.exchange.streamCompleted =
          completed && !this.stopped && this.exchange.streamResult.usage.complete;
      } else if (!this.stopped) {
        // Decoded bytes ONLY in this analysis copy. The downstream retains wire bytes/headers.
        this.exchange.responseBody = Buffer.concat(this.chunks, this.bytes);
      }
    } catch {
      this.stop();
    }
    this.chunks = [];
  }
}
