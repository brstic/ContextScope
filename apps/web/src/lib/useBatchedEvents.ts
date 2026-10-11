import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent } from '@contextscope/shared';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'paused';

export const LIVE_EVENT_TYPES: LiveEvent['type'][] = [
  'request.started',
  'request.completed',
  'findings.updated',
  'stats',
  'heartbeat',
];

export interface BatchedEventsOptions {
  url: string;
  /** Called at most once per `intervalMs` with every event received in between. */
  onBatch: (events: LiveEvent[]) => void;
  intervalMs?: number;
  paused?: boolean;
  /** Injectable for tests. */
  EventSourceImpl?: typeof EventSource;
}

/**
 * Subscribes to the dashboard SSE stream and flushes events in batches (default ~250 ms),
 * so a burst of events causes one state update instead of one rerender per event.
 * Events are buffered in a ref; only connection status lives in React state.
 */
export const useBatchedEvents = ({
  url,
  onBatch,
  intervalMs = 250,
  paused = false,
  EventSourceImpl,
}: BatchedEventsOptions): LiveStatus => {
  const [status, setStatus] = useState<LiveStatus>(paused ? 'paused' : 'connecting');
  const buffer = useRef<LiveEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBatchRef = useRef(onBatch);
  useEffect(() => {
    onBatchRef.current = onBatch;
  }, [onBatch]);

  const flush = useCallback(() => {
    timer.current = null;
    if (buffer.current.length === 0) return;
    const batch = buffer.current;
    buffer.current = [];
    onBatchRef.current(batch);
  }, []);

  useEffect(() => {
    if (paused) {
      setStatus('paused');
      return;
    }
    const ES = EventSourceImpl ?? (typeof EventSource !== 'undefined' ? EventSource : undefined);
    if (!ES) {
      setStatus('reconnecting');
      return;
    }
    setStatus('connecting');
    const es = new ES(url);
    const handle = (ev: MessageEvent<string>) => {
      let data: LiveEvent;
      try {
        data = JSON.parse(ev.data) as LiveEvent;
      } catch {
        return;
      }
      buffer.current.push(data);
      if (timer.current === null) timer.current = setTimeout(flush, intervalMs);
    };
    const listeners = LIVE_EVENT_TYPES.map((t) => {
      const l = (e: Event) => handle(e as MessageEvent<string>);
      es.addEventListener(t, l);
      return [t, l] as const;
    });
    es.onopen = () => setStatus('connected');
    // EventSource reconnects by itself; surface the state.
    es.onerror = () => setStatus(es.readyState === 2 ? 'reconnecting' : 'reconnecting');
    return () => {
      listeners.forEach(([t, l]) => es.removeEventListener(t, l));
      es.close();
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      flush();
    };
  }, [url, paused, intervalMs, flush, EventSourceImpl]);

  return status;
};
