import { useQuery } from '@tanstack/react-query';
import { GitCompare } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ContextStrip, StripLegend, UsageBar } from '../components/ContextStrip';
import { FindingList } from '../components/Findings';
import { PageHeader } from '../components/Layout';
import { Metric, MetricGrid } from '../components/Metric';
import { Num } from '../components/Num';
import { SegmentTable } from '../components/SegmentTable';
import { ErrorState, LoadingBlock } from '../components/States';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { api } from '../lib/api';
import { formatBytes, formatDateTime, formatMs, kindLabel, providerLabel, shortId, stateLabel } from '../lib/format';

const JsonViewer = lazy(() => import('../components/JsonViewer'));

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-2 border-b border-border py-1.5 text-[12px] last:border-b-0">
    <dt className="text-muted">{k}</dt>
    <dd className="min-w-0 break-words">{v}</dd>
  </div>
);

export default function RequestInspectorPage() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState<number | null>(null);
  const selectSegment = (index: number): void => {
    setTab('context');
    setSelected(index);
    // Bring the chosen row into view once the Context tab has rendered.
    requestAnimationFrame(() => document.getElementById(`seg-${index}`)?.scrollIntoView({ block: 'nearest' }));
  };
  const det = useQuery({ queryKey: ['request', id], queryFn: ({ signal }) => api.request(id, signal) });
  const ctx = useQuery({ queryKey: ['request', id, 'context'], queryFn: ({ signal }) => api.requestContext(id, signal) });
  const fnd = useQuery({ queryKey: ['request', id, 'findings'], queryFn: ({ signal }) => api.requestFindings(id, signal) });
  const content = useQuery({
    queryKey: ['request', id, 'content'],
    queryFn: ({ signal }) => api.requestContent(id, signal),
    // Only ask when the server says content was kept; otherwise the Raw tab explains deep capture.
    enabled: tab === 'raw' && det.data?.contentAvailable === true,
  });

  if (det.isPending) return <LoadingBlock rows={8} label="Loading request" />;
  if (det.isError) return <ErrorState error={det.error} onRetry={() => void det.refetch()} title="Could not load request" />;
  const r = det.data;
  const u = r.usage;
  const c = r.cost;
  const segs = ctx.data?.segments ?? [];
  const shared = r.prefix?.sharedSegments ?? null;
  const t = r.timing;
  const end = t.durationMs ?? 0;
  const marks = [
    { k: 'Start', v: 0 as number | null },
    { k: 'TTFB', v: t.ttfbMs },
    { k: 'TTFT', v: t.ttftMs },
    { k: 'End', v: t.durationMs },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="num">{r.model ?? 'unknown model'}</span>
            <Badge tone="outline">{providerLabel(r.provider)}</Badge>
            <Badge tone={r.state === 'completed' && (r.httpStatus ?? 0) < 400 ? 'success' : 'error'}>
              {r.httpStatus ?? stateLabel(r.state)}
            </Badge>
            {r.demo ? <Badge tone="write">demo</Badge> : null}
          </span>
        }
        description={
          <span className="num">
            {r.id} · {formatDateTime(t.startedAt)} · {r.method} {r.endpoint}
          </span>
        }
        actions={
          r.previousRequestId ? (
            <Button asChild size="sm">
              <Link to={`/compare?a=${encodeURIComponent(r.previousRequestId)}&b=${encodeURIComponent(r.id)}`}>
                <GitCompare aria-hidden /> Compare with previous
              </Link>
            </Button>
          ) : null
        }
      />
      <Panel>
        <PanelBody className="space-y-2">
          {ctx.isPending ? <LoadingBlock rows={1} /> : <ContextStrip segments={segs} sharedSegments={shared} highlightIndex={selected} onSelect={selectSegment} />}
          <UsageBar usage={u} />
        </PanelBody>
      </Panel>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Request sections">
          {['overview', 'timeline', 'context', 'cache', 'cost', 'raw', 'issues'].map((k) => (
            <TabsTrigger key={k} value={k} className="capitalize">
              {k}
              {k === 'issues' && fnd.data?.length ? <Badge tone="write">{fnd.data.length}</Badge> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <MetricGrid>
            <Metric label="Input" value={<Num value={u.totalInputTokens} />} accent="var(--uncached)" />
            <Metric label="Cache read" value={<Num value={u.cacheReadTokens} />} accent="var(--cache-read)" />
            <Metric label="Cache write" value={<Num value={u.cacheWriteTokens} />} accent="var(--cache-write)" />
            <Metric label="Output" value={<Num value={u.outputTokens} />} accent="var(--output)" />
            <Metric label="Reasoning" value={<Num value={u.reasoningTokens} />} accent="var(--reasoning)" />
            <Metric label="Cost (est.)" value={<Num value={c?.totalNanoUsd ?? null} as="usd" hint="Pricing unavailable" />} />
            <Metric label="Duration" value={<Num value={t.durationMs} as="ms" />} />
            <Metric label="TTFT" value={<Num value={t.ttftMs} as="ms" hint="TTFT unavailable" />} />
          </MetricGrid>
          <Panel className="mt-3">
            <PanelBody>
              <dl>
                <Row k="Session" v={r.sessionId ? <Link className="num hover:underline" to={`/sessions/${encodeURIComponent(r.sessionId)}`}>{r.sessionId}</Link> : '—'} />
                <Row k="Provider request id" v={<span className="num">{r.providerRequestId ?? '—'}</span>} />
                <Row k="Stream" v={r.stream ? `yes${r.streamCompleted === false ? ' (incomplete)' : ''}` : 'no'} />
                <Row k="Usage source" v={`${u.source}${u.complete ? '' : ' (partial)'}`} />
                <Row k="Bytes" v={<span className="num">{formatBytes(r.requestBytes)} sent · {formatBytes(r.responseBytes)} received</span>} />
                <Row k="Tools / messages" v={<span className="num">{r.features.toolCount} tools · {r.features.messageCount} messages · {r.features.cacheControlBlocks} cache_control blocks</span>} />
                <Row k="Origin" v={r.origin} />
                {r.errorMessage ? <Row k="Error" v={<span className="text-error">{r.errorMessage}</span>} /> : null}
              </dl>
            </PanelBody>
          </Panel>
        </TabsContent>
        <TabsContent value="timeline">
          <Panel>
            <PanelHeader title="Timeline" description="Start, time to first byte, time to first token, end" />
            <PanelBody>
              <div className="relative h-10 rounded-[4px] bg-raised" role="img" aria-label="Request timeline">
                {end > 0
                  ? marks.map((m) =>
                      m.v === null ? null : (
                        <span key={m.k} className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: `${Math.min(100, (m.v / end) * 100)}%` }}>
                          <span className="absolute -top-0.5 left-1 whitespace-nowrap text-[11px] text-muted">{m.k}</span>
                        </span>
                      ),
                    )
                  : null}
              </div>
              <dl className="mt-3">
                {marks.map((m) => (
                  <Row key={m.k} k={m.k} v={m.v === null ? <span className="text-muted">{m.k === 'TTFT' ? 'TTFT unavailable' : '—'}</span> : <span className="num">{formatMs(m.v)}</span>} />
                ))}
                <Row k="Connect" v={<Num value={t.connectMs} as="ms" hint="Not measurable" />} />
              </dl>
            </PanelBody>
          </Panel>
        </TabsContent>
        <TabsContent value="context">
          <Panel>
            <PanelHeader title="Context segments" description={`${segs.length} segments in cache order. Tokens are local estimates.`} actions={<StripLegend />} />
            {ctx.isError ? <div className="p-3"><ErrorState error={ctx.error} onRetry={() => void ctx.refetch()} /></div> : <SegmentTable segments={segs} sharedSegments={shared} highlight={selected} onSelect={setSelected} />}
          </Panel>
        </TabsContent>
        <TabsContent value="cache">
          <Panel>
            <PanelHeader title="Cache" description="Reported by the provider" />
            <PanelBody className="space-y-3">
              <MetricGrid className="xl:grid-cols-4">
                <Metric label="Cache read" value={<Num value={u.cacheReadTokens} />} accent="var(--cache-read)" />
                <Metric label="Cache write" value={<Num value={u.cacheWriteTokens} />} accent="var(--cache-write)" sub={u.cacheWrite1hTokens !== null ? `5m ${u.cacheWrite5mTokens ?? '—'} · 1h ${u.cacheWrite1hTokens}` : undefined} />
                <Metric label="Uncached input" value={<Num value={u.uncachedInputTokens} />} accent="var(--uncached)" />
                <Metric label="Savings (actual)" value={<Num value={c?.actualCacheSavingsNanoUsd ?? null} as="usd" />} />
              </MetricGrid>
              <div className="text-[13px]">
                <h3 className="font-medium">Prefix comparison</h3>
                {r.prefix ? (
                  <p className="mt-1 text-muted">
                    Against <Link className="num text-fg hover:underline" to={`/requests/${encodeURIComponent(r.prefix.againstRequestId)}`}>{shortId(r.prefix.againstRequestId)}</Link>:{' '}
                    <span className="num text-fg">{r.prefix.sharedSegments}/{r.prefix.totalSegments}</span> segments identical
                    {r.prefix.sharedEstimatedTokens !== null ? <> (<span className="num text-fg">{r.prefix.sharedEstimatedTokens.toLocaleString('en-US')}</span> tokens est.)</> : null}.
                    {r.prefix.firstChangedSegmentIndex !== null ? <> First change at segment <span className="num text-fg">#{r.prefix.firstChangedSegmentIndex}</span> ({kindLabel(r.prefix.firstChangedKind)}: {r.prefix.firstChangedLabel}). Providers cache by exact prefix, so everything after this point is re-processed.</> : null}{' '}
                    {r.prefix.note}
                  </p>
                ) : (
                  <p className="mt-1 text-muted">No earlier request in this session or with this provider + model to compare against.</p>
                )}
                {Object.keys(r.features.cacheOptions).length ? (
                  <p className="mt-2 text-muted">Cache options: <span className="num text-fg">{Object.entries(r.features.cacheOptions).map(([k, v]) => `${k}=${v}`).join(', ')}</span></p>
                ) : null}
              </div>
            </PanelBody>
            <FindingList findings={(fnd.data ?? []).filter((f) => f.affects === 'caching' || f.affects === 'both')} empty="No cache findings for this request." />
          </Panel>
        </TabsContent>
        <TabsContent value="cost">
          <Panel>
            <PanelHeader title="Cost breakdown" description="Estimate from the pricing table, not an invoice" />
            <PanelBody>
              {c ? (
                <dl>
                  <Row k="Uncached input" v={<Num value={c.uncachedInputNanoUsd} as="usd" />} />
                  <Row k="Cache read" v={<Num value={c.cacheReadNanoUsd} as="usd" />} />
                  <Row k="Cache write" v={<Num value={c.cacheWriteNanoUsd} as="usd" />} />
                  <Row k="Output" v={<Num value={c.outputNanoUsd} as="usd" />} />
                  <Row k="Total" v={<Num value={c.totalNanoUsd} as="usd" estimated />} />
                  <Row k="Actual cache savings" v={<Num value={c.actualCacheSavingsNanoUsd} as="usd" />} />
                  <Row k="Pricing" v={<span className="num">{c.pricingModelKey ?? '—'} · {c.pricingSource ?? '—'} · {c.pricingVersion ?? '—'} · {c.confidence ?? '—'} confidence</span>} />
                  {c.notes.length ? <Row k="Notes" v={c.notes.join(' · ')} /> : null}
                </dl>
              ) : (
                <p className="text-muted">Pricing unavailable for this model. Add a pricing override in Settings.</p>
              )}
              <p className="mt-2 text-[11px] text-muted">Costs are computed locally from public list prices and provider-reported usage. Discounts, batch pricing and taxes are not included.</p>
            </PanelBody>
          </Panel>
        </TabsContent>
        <TabsContent value="raw">
          <Panel>
            <PanelHeader title="Raw request and response" />
            <PanelBody>
              {!r.contentAvailable || content.data === null ? (
                <p className="text-[13px] text-muted">
                  Content is not stored for this request (capture mode <span className="num text-fg">{ctx.data?.captureMode ?? 'metadata'}</span>). ContextScope keeps only fingerprints and sizes by default.
                  To see raw bodies, switch capture mode to deep (memory or persistent) in <Link to="/settings" className="text-fg underline">Settings</Link>; it applies to new requests only.
                </p>
              ) : content.isPending ? (
                <LoadingBlock rows={4} />
              ) : content.isError ? (
                <ErrorState error={content.error} onRetry={() => void content.refetch()} />
              ) : (
                <Suspense fallback={<LoadingBlock rows={4} />}>
                  <p className="mb-2 text-[11px] text-muted">Stored in {content.data.storage}{content.data.expiresAt ? `, expires ${formatDateTime(content.data.expiresAt)}` : ''}.</p>
                  <h3 className="mb-1 text-[12px] text-muted">Request</h3>
                  <JsonViewer label="Raw request JSON" value={JSON.stringify(content.data.request, null, 2)} />
                  <h3 className="mb-1 mt-3 text-[12px] text-muted">Response</h3>
                  <JsonViewer label="Raw response JSON" value={typeof content.data.response === 'string' ? content.data.response : JSON.stringify(content.data.response, null, 2)} />
                </Suspense>
              )}
            </PanelBody>
          </Panel>
        </TabsContent>
        <TabsContent value="issues">
          <Panel>
            <PanelHeader title="Issues" description="Findings attached to this request" />
            {fnd.isError ? <div className="p-3"><ErrorState error={fnd.error} onRetry={() => void fnd.refetch()} /></div> : <FindingList findings={fnd.data ?? []} empty="No issues found for this request." />}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
