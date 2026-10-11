import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Copy, Repeat } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ContextStrip, StripLegend, UsageBar } from '../components/ContextStrip';
import { PageHeader } from '../components/Layout';
import { Num } from '../components/Num';
import { ErrorState, GetStarted, LoadingBlock } from '../components/States';
import { Badge } from '../components/ui/badge';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { api } from '../lib/api';
import { formatTime, formatTokens, kindLabel, shortFingerprint } from '../lib/format';
import { groupSegments } from '../lib/strip';
import { cn } from '../lib/utils';

export default function ContextExplorerPage() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState('');
  const selected = sp.get('id');
  const recent = useQuery({ queryKey: ['requests', { pageSize: 30, q }], queryFn: ({ signal }) => api.requests({ pageSize: 30, q: q || undefined }, signal) });
  const id = selected ?? recent.data?.items[0]?.id ?? null;
  const ctx = useQuery({ queryKey: ['request', id, 'context'], queryFn: ({ signal }) => api.requestContext(id ?? '', signal), enabled: Boolean(id) });
  const det = useQuery({ queryKey: ['request', id], queryFn: ({ signal }) => api.request(id ?? '', signal), enabled: Boolean(id) });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const segs = ctx.data?.segments ?? [];
  const total = segs.reduce((a, s) => a + (s.estimatedTokens ?? 0), 0);
  const groups = groupSegments(segs);

  return (
    <div className="space-y-3">
      <PageHeader title="Context Explorer" description="What a request's context is made of, grouped by kind. Token counts are local estimates." />
      <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Panel>
          <PanelHeader title="Requests" />
          <div className="p-2">
            <label className="sr-only" htmlFor="ctx-search">Search requests</label>
            <input id="ctx-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search id, model, session" className="h-8 w-full rounded-[4px] border border-border bg-bg px-2 text-[13px] placeholder:text-muted" />
          </div>
          {recent.isPending ? <LoadingBlock rows={6} /> : recent.isError ? <div className="p-2"><ErrorState error={recent.error} onRetry={() => void recent.refetch()} /></div> : (
            <ul className="max-h-[50vh] overflow-y-auto lg:max-h-[70vh]">
              {recent.data.items.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setSp({ id: r.id })} aria-current={r.id === id} className={cn('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', r.id === id && 'bg-raised shadow-[inset_2px_0_0_var(--text)]')}>
                    <span className="min-w-0"><span className="num block truncate">{r.model ?? '—'}</span><span className="num text-muted">{formatTime(r.startedAt)}</span></span>
                    <Num value={r.totalInputTokens} className="text-muted" />
                  </button>
                </li>
              ))}
              {recent.data.items.length === 0 ? <li><GetStarted /></li> : null}
            </ul>
          )}
        </Panel>
        <div className="min-w-0 space-y-3">
          {!id ? null : ctx.isPending ? <LoadingBlock rows={8} /> : ctx.isError ? <ErrorState error={ctx.error} onRetry={() => void ctx.refetch()} /> : (
            <>
              <Panel>
                <PanelHeader title={<>Request <Link className="num hover:underline" to={`/requests/${encodeURIComponent(id)}`}>{id}</Link></>} description={`${segs.length} segments · ${formatTokens(total)} tokens est.`} actions={<StripLegend />} />
                <PanelBody className="space-y-2">
                  <ContextStrip segments={segs} sharedSegments={det.data?.prefix?.sharedSegments ?? null} />
                  {det.data ? <UsageBar usage={det.data.usage} /> : null}
                </PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="Structure" />
                <ul role="tree" aria-label="Context grouped by kind">
                  {[...groups.entries()].filter(([, v]) => v.length).map(([g, items]) => {
                    const gt = items.reduce((a, s) => a + (s.estimatedTokens ?? 0), 0);
                    const repeated = items.filter((s) => s.duplicateCountInRequest > 0 || (s.seenInRequests ?? 0) > 0).length;
                    const isOpen = open[g] ?? g !== 'Conversation history';
                    return (
                      <li key={g} role="treeitem" aria-expanded={isOpen} className="border-b border-border last:border-b-0">
                        <button type="button" onClick={() => setOpen((o) => ({ ...o, [g]: !isOpen }))} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                          <span className="flex items-center gap-1.5 font-medium"><ChevronRight aria-hidden className={cn('size-3.5 text-muted transition-transform', isOpen && 'rotate-90')} />{g}<span className="text-muted font-normal">({items.length})</span>{repeated ? <Badge tone="output"><Repeat className="size-3" aria-hidden /> {repeated} repeated</Badge> : null}</span>
                          <span className="num text-right">{formatTokens(gt)} <span className="text-muted">est. · {total ? ((gt / total) * 100).toFixed(1) : '0.0'}%</span></span>
                          <span className="col-span-2 h-1 rounded-[2px] bg-raised"><span className="block h-full rounded-[2px] bg-muted" style={{ width: `${total ? (gt / total) * 100 : 0}%` }} /></span>
                        </button>
                        {isOpen ? (
                          <ul role="group" className="pb-1">
                            {items.map((s) => (
                              <li key={s.index} role="treeitem" className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-1 pl-8 pr-3 text-[12px]">
                                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                  <span className="num text-muted">#{s.index}</span>
                                  <span className="truncate" title={s.path}>{s.label}</span>
                                  <span className="text-muted">{kindLabel(s.kind)}</span>
                                  <span className="num text-muted">{shortFingerprint(s.exactFingerprint)}</span>
                                  {s.cacheControl ? <Badge tone="write">cache_control</Badge> : null}
                                  {s.duplicateCountInRequest ? <Badge tone="output"><Copy className="size-3" aria-hidden />dup ×{s.duplicateCountInRequest}</Badge> : null}
                                  {s.seenInRequests ? <Badge>seen in {s.seenInRequests}</Badge> : null}
                                </span>
                                <span className="text-right"><Num value={s.estimatedTokens} estimated={s.tokenSource === 'estimated'} /> <span className="num text-muted">{s.estimatedTokens !== null && total ? `${((s.estimatedTokens / total) * 100).toFixed(1)}%` : ''}</span></span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
