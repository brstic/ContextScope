import type { RequestDetail } from '@contextscope/shared';
import { useQuery } from '@tanstack/react-query';
import { Crosshair } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ContextStrip, StripLegend, UsageBar } from '../components/ContextStrip';
import { PageHeader } from '../components/Layout';
import { ErrorState, LoadingBlock } from '../components/States';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Select } from '../components/ui/select';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api } from '../lib/api';
import { formatDelta, formatMs, formatTime, formatUsd, kindLabel, shortId } from '../lib/format';
import { cn } from '../lib/utils';

const MergeDiff = lazy(() => import('../components/MergeDiff'));
const DIFF_CAP = 200_000;

const stringify = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function ComparePage() {
  const [sp, setSp] = useSearchParams();
  const a = sp.get('a') ?? '';
  const b = sp.get('b') ?? '';
  const [hl, setHl] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const recent = useQuery({ queryKey: ['requests', { pageSize: 50 }], queryFn: ({ signal }) => api.requests({ pageSize: 50 }, signal) });
  const cmp = useQuery({ queryKey: ['compare', a, b], queryFn: ({ signal }) => api.compare(a, b, signal), enabled: Boolean(a && b) });
  const ca = useQuery({ queryKey: ['request', a, 'content'], queryFn: ({ signal }) => api.requestContent(a, signal), enabled: Boolean(showDiff && cmp.data?.contentAvailable) });
  const cb = useQuery({ queryKey: ['request', b, 'content'], queryFn: ({ signal }) => api.requestContent(b, signal), enabled: Boolean(showDiff && cmp.data?.contentAvailable) });

  const opts = (recent.data?.items ?? []).map((r) => ({ value: r.id, label: `${formatTime(r.startedAt)} · ${r.model ?? '—'} · ${shortId(r.id)}` }));
  for (const id of [a, b]) if (id && !opts.some((o) => o.value === id)) opts.unshift({ value: id, label: shortId(id, 16) });
  const set = (k: 'a' | 'b', v: string) => setSp((p) => { const n = new URLSearchParams(p); n.set(k, v); return n; });

  const d = cmp.data;
  const first = d?.firstCacheRelevantDifference;
  const findFirst = () => {
    if (!d || !first || first.segmentIndex === null) return;
    const row = d.alignment.findIndex((x) => x.bIndex === first.segmentIndex || x.aIndex === first.segmentIndex);
    setHl(first.segmentIndex);
    document.getElementById(`align-${row}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const shared = d ? d.alignment.findIndex((x) => x.status !== 'same') : -1;
  const sharedCount = d ? (shared === -1 ? d.alignment.length : shared) : null;

  const metrics = (x: RequestDetail) => ({ input: x.usage.totalInputTokens, read: x.usage.cacheReadTokens, write: x.usage.cacheWriteTokens, output: x.usage.outputTokens, cost: x.cost?.totalNanoUsd ?? null, dur: x.timing.durationMs, ttft: x.timing.ttftMs });

  let diffBody: React.ReactNode = null;
  if (showDiff) {
    if (ca.isPending || cb.isPending) diffBody = <LoadingBlock rows={3} />;
    else if (!ca.data || !cb.data) diffBody = <p className="text-muted">Content is not available for both requests.</p>;
    else {
      const ta = stringify(ca.data.request);
      const tb = stringify(cb.data.request);
      const capped = ta.length > DIFF_CAP || tb.length > DIFF_CAP;
      diffBody = <Suspense fallback={<LoadingBlock rows={3} />}>{capped ? <p className="mb-2 text-[12px] text-cache-write">Content is larger than 200k characters; showing the first 200k of each side.</p> : null}<MergeDiff a={ta.slice(0, DIFF_CAP)} b={tb.slice(0, DIFF_CAP)} /></Suspense>;
    }
  }

  return (
    <div className="space-y-3">
      <PageHeader title="Compare" description="Where does B stop sharing A's prompt prefix? Segments are aligned by fingerprint, then position." />
      <Panel>
        <PanelBody className="grid gap-2 sm:grid-cols-2">
          <div><label className="mb-1 block text-[12px] text-muted">Request A (earlier)</label><Select label="Request A" value={a} onValueChange={(v) => set('a', v)} options={opts} placeholder="Pick request A" className="w-full" /></div>
          <div><label className="mb-1 block text-[12px] text-muted">Request B (later)</label><Select label="Request B" value={b} onValueChange={(v) => set('b', v)} options={opts} placeholder="Pick request B" className="w-full" /></div>
        </PanelBody>
      </Panel>
      {!a || !b ? <p className="text-[13px] text-muted">Pick two requests, or open a request and use Compare with previous.</p> : cmp.isPending ? <LoadingBlock rows={8} /> : cmp.isError ? <ErrorState error={cmp.error} onRetry={() => void cmp.refetch()} /> : d ? (
        <>
          <Panel>
            <PanelHeader title="Aligned context strips" actions={<StripLegend />} />
            <PanelBody className="space-y-3">
              {(['a', 'b'] as const).map((k) => (
                <div key={k} className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2">
                  <span className="num pt-1 font-semibold">{k.toUpperCase()}</span>
                  <div className="space-y-1">
                    <ContextStrip segments={k === 'a' ? d.segmentsA : d.segmentsB} sharedSegments={sharedCount} highlightIndex={k === 'b' ? hl : null} title={`Request ${k.toUpperCase()} context`} />
                    <UsageBar usage={d[k].usage} />
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={findFirst} disabled={!first || first.segmentIndex === null}><Crosshair aria-hidden /> Find first cache-relevant difference</Button>
                {first ? <p className="text-[12px] text-muted">{first.segmentIndex !== null ? <><span className="text-fg">#{first.segmentIndex} {kindLabel(first.kind)}{first.label ? `: ${first.label}` : ''}</span>. </> : null}{first.explanation}</p> : null}
              </div>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader title="Deltas" description="B minus A" />
            <Table>
              <THead><Tr><Th>Metric</Th><Th className="text-right">A</Th><Th className="text-right">B</Th><Th className="text-right">Δ</Th></Tr></THead>
              <TBody>
                {(() => {
                  const ma = metrics(d.a); const mb = metrics(d.b);
                  const rows: [string, keyof typeof ma, (n: number) => string][] = [['Input tokens', 'input', (n) => n.toLocaleString('en-US')], ['Cache read', 'read', (n) => n.toLocaleString('en-US')], ['Cache write', 'write', (n) => n.toLocaleString('en-US')], ['Output', 'output', (n) => n.toLocaleString('en-US')], ['Cost (est.)', 'cost', formatUsd], ['Duration', 'dur', formatMs], ['TTFT', 'ttft', formatMs]];
                  return rows.map(([l, k, f]) => (<Tr key={k}><Td>{l}</Td><Td className="num text-right">{ma[k] === null ? '—' : f(ma[k])}</Td><Td className="num text-right">{mb[k] === null ? '—' : f(mb[k])}</Td><Td className="num text-right">{formatDelta(ma[k], mb[k], f)}</Td></Tr>));
                })()}
              </TBody>
            </Table>
          </Panel>
          <Panel>
            <PanelHeader title="Structural diff" description={<><Link className="num hover:underline" to={`/requests/${encodeURIComponent(d.a.id)}`}>A {shortId(d.a.id)}</Link> vs <Link className="num hover:underline" to={`/requests/${encodeURIComponent(d.b.id)}`}>B {shortId(d.b.id)}</Link></>} />
            <Table>
              <THead><Tr><Th>Status</Th><Th>A segment</Th><Th>B segment</Th><Th className="text-right">Est. tokens A → B</Th></Tr></THead>
              <TBody>
                {d.alignment.map((x, i) => {
                  const sa = x.aIndex !== null ? d.segmentsA[x.aIndex] : undefined;
                  const sb = x.bIndex !== null ? d.segmentsB[x.bIndex] : undefined;
                  const isFirst = hl !== null && x.bIndex === hl;
                  return (
                    <Tr key={i} id={`align-${i}`} className={cn(isFirst && 'cs-flash bg-raised')}>
                      <Td><Badge tone={x.status === 'same' ? 'read' : x.status === 'changed' ? 'write' : x.status === 'added' ? 'uncached' : 'error'}>{x.status}</Badge></Td>
                      <Td className="max-w-[260px] truncate">{sa ? `#${sa.index} ${kindLabel(sa.kind)} · ${sa.label}` : '—'}</Td>
                      <Td className="max-w-[260px] truncate">{sb ? `#${sb.index} ${kindLabel(sb.kind)} · ${sb.label}` : '—'}</Td>
                      <Td className="num text-right">{sa?.estimatedTokens ?? '—'} → {sb?.estimatedTokens ?? '—'}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </Panel>
          <Panel>
            <PanelHeader title="Text diff" actions={d.contentAvailable ? <Button size="sm" onClick={() => setShowDiff((s) => !s)}>{showDiff ? 'Hide' : 'Show'} text diff</Button> : null} />
            <PanelBody>{d.contentAvailable ? diffBody : <p className="text-[12px] text-muted">Text diff needs stored content for both requests. Enable deep capture in Settings; only fingerprints are kept otherwise.</p>}</PanelBody>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
