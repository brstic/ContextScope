import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { LiveEvent } from '@contextscope/shared';
import type { LiveHub } from '../types.js';

export interface LiveHubOptions {
  maxBuffered?: number;
}
/** A transport can optionally acknowledge backpressure without changing LiveHub's public interface. */
interface Sink {
  (event: LiveEvent): void;
  ready?: () => boolean;
  onDrop?: () => void;
}
interface Subscriber {
  send: Sink;
  queue: LiveEvent[];
  flushing: boolean;
}
const limits = new WeakMap<LiveHub, number>();
export const createLiveHub = (opts: LiveHubOptions = {}): LiveHub => {
  const max = Math.max(1, Math.floor(opts.maxBuffered ?? 1000));
  const subs = new Set<Subscriber>();
  let closed = false;
  const drop = (s: Subscriber): void => {
    subs.delete(s);
    s.queue.length = 0;
    s.send.onDrop?.();
  };
  const flush = (s: Subscriber): void => {
    if (s.flushing) return;
    s.flushing = true;
    try {
      while (subs.has(s) && s.queue.length && (s.send.ready?.() ?? true)) s.send(s.queue.shift()!);
    } catch {
      drop(s);
    } finally {
      s.flushing = false;
    }
  };
  const hub: LiveHub = {
    publish(event) {
      if (closed) return;
      for (const s of subs) {
        s.queue.push(event);
        if (s.queue.length > max) drop(s);
        else flush(s);
      }
    },
    subscribe(send) {
      if (closed) return () => {};
      const s: Subscriber = { send, queue: [], flushing: false };
      subs.add(s);
      return () => {
        subs.delete(s);
        s.queue.length = 0;
      };
    },
    get subscribers() {
      return subs.size;
    },
    close() {
      closed = true;
      for (const s of subs) drop(s);
    },
  };
  limits.set(hub, max);
  return hub;
};

export interface RegisterEventsDeps {
  live: LiveHub;
  maxBuffered?: number;
  heartbeatMs?: number;
}
/** Uses a Fastify stream, so security/onSend hooks remain active. Each accepted write is sent once. */
export const registerEvents = (app: FastifyInstance, deps: RegisterEventsDeps): void => {
  const connections = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of connections) close();
  });
  app.get('/api/events', { logLevel: 'silent' }, (_request, reply) => {
    const max = deps.maxBuffered ?? limits.get(deps.live) ?? 1000;
    const pending: string[] = [];
    let blocked = false;
    let ended = false;
    let unsubscribe: () => void = () => {};
    const stream = new Readable({
      read() {
        blocked = false;
        while (pending.length && !blocked) blocked = !stream.push(pending.shift()!);
      },
    });
    const close = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      unsubscribe();
      pending.length = 0;
      connections.delete(close);
      stream.destroy();
    };
    const send = (event: LiveEvent): void => {
      if (ended) return;
      const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      if (blocked) {
        pending.push(frame);
        if (pending.length > max) close();
      } else blocked = !stream.push(frame);
    };
    const sink: Sink = send;
    sink.onDrop = close;
    unsubscribe = deps.live.subscribe(sink);
    // close() reads `timer` only when called, which is always after this line.
    const timer = setInterval(
      () => send({ type: 'heartbeat', at: new Date().toISOString() }),
      deps.heartbeatMs ?? 15000,
    );
    timer.unref();
    connections.add(close);
    stream.once('close', close);
    reply.raw.once('close', close);
    stream.push('retry: 3000\n\n');
    return reply
      .type('text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
};
