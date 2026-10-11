import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/Layout';
import { Num } from '../components/Num';
import { ErrorState, GetStarted, LoadingBlock } from '../components/States';
import { Button } from '../components/ui/button';
import { Panel } from '../components/ui/panel';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';

export default function SessionsPage() {
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const q = useQuery({
    queryKey: ['sessions', page],
    queryFn: ({ signal }) => api.sessions({ page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / pageSize));
  return (
    <div className="space-y-3">
      <PageHeader title="Sessions" description="Requests grouped by the x-contextscope-session header" />
      <Panel>
        {q.isPending ? (
          <LoadingBlock rows={8} />
        ) : q.isError ? (
          <div className="p-3"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
        ) : q.data.items.length === 0 ? (
          <GetStarted title="No sessions yet. Send the x-contextscope-session header with your requests to group them." />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Session</Th><Th>Last seen</Th><Th className="text-right">Requests</Th><Th className="text-right">Input</Th>
                <Th className="text-right">Output</Th><Th className="text-right">Hit rate</Th><Th className="text-right">Cost</Th>
                <Th className="text-right">Avg latency</Th><Th>Models</Th><Th className="text-right">Findings</Th>
              </Tr>
            </THead>
            <TBody>
              {q.data.items.map((s) => (
                <Tr key={s.id} className="hover:bg-raised">
                  <Td><Link to={`/sessions/${encodeURIComponent(s.id)}`} className="num hover:underline">{s.id}</Link></Td>
                  <Td className="num text-muted">{formatDateTime(s.lastSeen)}</Td>
                  <Td className="num text-right">{s.requests}</Td>
                  <Td className="text-right"><Num value={s.inputTokens} /></Td>
                  <Td className="text-right"><Num value={s.outputTokens} /></Td>
                  <Td className="text-right"><Num value={s.cacheHitRate} as="pct" /></Td>
                  <Td className="text-right"><Num value={s.totalNanoUsd} as="usd" /></Td>
                  <Td className="text-right"><Num value={s.avgDurationMs} as="ms" /></Td>
                  <Td className="num max-w-[220px] truncate text-muted">{s.models.join(', ')}</Td>
                  <Td className="num text-right">{s.findingCount}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border p-2 text-[12px]">
          <span className="text-muted">Page <span className="num text-fg">{page}</span> of <span className="num text-fg">{pages}</span></span>
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </Panel>
    </div>
  );
}
