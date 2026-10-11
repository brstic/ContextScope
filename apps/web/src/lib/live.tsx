import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveEvent, RequestSummary } from '@contextscope/shared';
import { eventsUrl } from './api';
import { useBatchedEvents, type LiveStatus } from './useBatchedEvents';

type Subscriber = (completed: RequestSummary[], events: LiveEvent[]) => void;

interface LiveContextValue {
  status: LiveStatus;
  paused: boolean;
  setPaused: (p: boolean) => void;
  queueDepth: number | null;
  dropped: number | null;
  inFlight: number;
  subscribe: (fn: Subscriber) => () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export const LiveProvider = ({ children }: { children: ReactNode }) => {
  const qc = useQueryClient();
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<{ queueDepth: number | null; dropped: number | null }>({
    queueDepth: null,
    dropped: null,
  });
  const [inFlight, setInFlight] = useState(0);
  const subs = useRef(new Set<Subscriber>());
  const pending = useRef(new Set<string>());

  const onBatch = useCallback(
    (events: LiveEvent[]) => {
      const completed: RequestSummary[] = [];
      let findings = false;
      let lastStats: { queueDepth: number; dropped: number } | null = null;
      for (const e of events) {
        if (e.type === 'request.started') pending.current.add(e.id);
        else if (e.type === 'request.completed') {
          pending.current.delete(e.request.id);
          completed.push(e.request);
        } else if (e.type === 'findings.updated') findings = true;
        else if (e.type === 'stats') lastStats = { queueDepth: e.queueDepth, dropped: e.dropped };
      }
      if (lastStats) setStats(lastStats);
      setInFlight(pending.current.size);
      if (completed.length) {
        void qc.invalidateQueries({ queryKey: ['overview'] });
        void qc.invalidateQueries({ queryKey: ['filters'] });
      }
      if (findings) void qc.invalidateQueries({ queryKey: ['optimizations'] });
      subs.current.forEach((fn) => fn(completed, events));
    },
    [qc],
  );

  const url = useMemo(() => eventsUrl(), []);
  const status = useBatchedEvents({ url, onBatch, paused });

  const subscribe = useCallback((fn: Subscriber) => {
    subs.current.add(fn);
    return () => {
      subs.current.delete(fn);
    };
  }, []);

  const value = useMemo<LiveContextValue>(
    () => ({ status, paused, setPaused, queueDepth: stats.queueDepth, dropped: stats.dropped, inFlight, subscribe }),
    [status, paused, stats, inFlight, subscribe],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
};

const fallback: LiveContextValue = {
  status: 'paused',
  paused: true,
  setPaused: () => undefined,
  queueDepth: null,
  dropped: null,
  inFlight: 0,
  subscribe: () => () => undefined,
};

export const useLive = (): LiveContextValue => useContext(LiveContext) ?? fallback;
