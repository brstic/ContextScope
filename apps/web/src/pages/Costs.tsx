import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '../components/Layout';
import { Metric, MetricGrid } from '../components/Metric';
import { Est, Num } from '../components/Num';
import { ErrorState, GetStarted, LoadingBlock } from '../components/States';
import { axisProps, ChartFrame, gridProps, HBarList, LegendDot, tooltipProps } from '../components/charts';
import { Badge } from '../components/ui/badge';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Select } from '../components/ui/select';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api, type Bucket } from '../lib/api';
import { formatBucket, formatTime, formatTokens, formatUsd, providerLabel } from '../lib/format';

export default function CostsPage() {
  const [bucket, setBucket] = useState<Bucket>('hour');
  const sum = useQuery({ queryKey: ['costs', 'summary'], queryFn: ({ signal }) => api.costSummary(signal) });
  const trend = useQuery({ queryKey: ['costs', 'trends', bucket], queryFn: ({ signal }) => api.costTrends(bucket, signal) });
  const opt = useQuery({ queryKey: ['optimizations', {}], queryFn: ({ signal }) => api.optimizations({}, signal) });
  const header = <PageHeader title="Cost Analytics" description="Estimated from public list prices and provider-reported usage." actions={<Select label="Bucket" value={bucket} onValueChange={(v) => setBucket(v as Bucket)} options={[{ value: 'hour', label: 'Hourly' }, { value: 'day', label: 'Daily' }]} className="w-28" />} />;
  if (sum.isPending) return <div>{header}<LoadingBlock rows={8} /></div>;
  if (sum.isError) return <div>{header}<ErrorState error={sum.error} onRetry={() => void sum.refetch()} /></div>;
  const s = sum.data;
  const t = s.totals;
  if (s.byModel.length === 0) return <div>{header}<Panel><GetStarted /></Panel></div>;
  const series = (trend.data ?? []).map((b) => ({ ...b, label: formatBucket(b.t, bucket) }));
  const potential = (opt.data ?? []).reduce((a, f) => a + (f.estimatedTokenReduction ?? 0), 0);
  const cached = t.cacheReadNanoUsd + t.cacheWriteNanoUsd;
  return (
    <div className="space-y-3">
      {header}
      <MetricGrid className="xl:grid-cols-6">
        <Metric label="Total cost" value={<>{formatUsd(t.totalNanoUsd)}<Est /></>} sub={t.unpricedRequests ? `${t.unpricedRequests} unpriced requests excluded` : 'all requests priced'} />
        <Metric label="Uncached input" value={formatUsd(t.uncachedInputNanoUsd)} accent="var(--uncached)" />
        <Metric label="Cache read" value={formatUsd(t.cacheReadNanoUsd)} accent="var(--cache-read)" />
        <Metric label="Cache write" value={formatUsd(t.cacheWriteNanoUsd)} accent="var(--cache-write)" />
        <Metric label="Output" value={formatUsd(t.outputNanoUsd)} accent="var(--output)" />
        <Metric label="Cached vs uncached input" value={<span className="text-[15px]">{formatUsd(cached)} / {formatUsd(t.uncachedInputNanoUsd)}</span>} />
      </MetricGrid>
      <Panel>
        <PanelHeader title="Savings and opportunities" description="Three different things, deliberately not added together" />
        <PanelBody className="grid gap-3 md:grid-cols-3">
          <div><div className="text-[12px] text-muted">Actual savings <Badge tone="read">measured</Badge></div><div className="num mt-1 text-[18px] font-semibold">{formatUsd(t.actualSavingsNanoUsd)}</div><p className="text-[11px] text-muted">Cache reads priced at the uncached rate, minus what they cost.</p></div>
          <div><div className="text-[12px] text-muted">Potential <Badge tone="uncached">estimate</Badge></div><div className="num mt-1 text-[18px] font-semibold">{opt.data ? `${opt.data.length} findings` : '—'}</div><p className="text-[11px] text-muted"><Link to="/optimizations" className="underline">Optimizations</Link> with recommendations; not converted to dollars.</p></div>
          <div><div className="text-[12px] text-muted">Avoidable token volume <Badge tone="uncached">estimate</Badge></div><div className="num mt-1 text-[18px] font-semibold">{opt.data ? formatTokens(potential) : '—'}<Est /></div><p className="text-[11px] text-muted">Sum of defensible per-finding token reductions.</p></div>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Cost over time" description={<span className="flex flex-wrap gap-3"><LegendDot color="var(--uncached)" label="Uncached input" /><LegendDot color="var(--cache-read)" label="Cache read" /><LegendDot color="var(--cache-write)" label="Cache write" /><LegendDot color="var(--output)" label="Output" /></span>} />
        <PanelBody>
          {trend.isError ? <ErrorState error={trend.error} onRetry={() => void trend.refetch()} /> : (
            <ChartFrame title="Cost over time stacked by component">
              <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis {...axisProps} tickFormatter={(v: number) => formatUsd(v)} width={64} />
                <RTooltip {...tooltipProps} formatter={(v) => formatUsd(Number(v))} />
                <Bar dataKey="uncachedInputNanoUsd" name="Uncached input" stackId="c" fill="var(--uncached)" isAnimationActive={false} />
                <Bar dataKey="cacheReadNanoUsd" name="Cache read" stackId="c" fill="var(--cache-read)" isAnimationActive={false} />
                <Bar dataKey="cacheWriteNanoUsd" name="Cache write" stackId="c" fill="var(--cache-write)" isAnimationActive={false} />
                <Bar dataKey="outputNanoUsd" name="Output" stackId="c" fill="var(--output)" isAnimationActive={false} />
              </BarChart>
            </ChartFrame>
          )}
        </PanelBody>
      </Panel>
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel><PanelHeader title="By provider" /><PanelBody><HBarList title="Cost by provider" format={formatUsd} rows={s.byProvider.map((p) => ({ key: p.provider, label: providerLabel(p.provider), value: p.totalNanoUsd, sub: `${p.requests} requests` }))} /></PanelBody></Panel>
        <Panel><PanelHeader title="By model" /><PanelBody><HBarList title="Cost by model" format={formatUsd} rows={s.byModel.map((m) => ({ key: `${m.provider}:${m.model}`, label: <span className="num">{m.model}</span>, value: m.totalNanoUsd, sub: m.unpriced ? `${m.unpriced} unpriced` : undefined }))} /></PanelBody></Panel>
        <Panel><PanelHeader title="By session" /><PanelBody><HBarList title="Cost by session" format={formatUsd} rows={s.bySession.slice(0, 8).map((x) => ({ key: x.id, label: <Link className="num hover:underline" to={`/sessions/${encodeURIComponent(x.id)}`}>{x.id}</Link>, value: x.totalNanoUsd }))} /></PanelBody></Panel>
      </div>
      <Panel>
        <PanelHeader title="Top requests" />
        <Table>
          <THead><Tr><Th>Time</Th><Th>Model</Th><Th className="text-right">Input</Th><Th className="text-right">Cached</Th><Th className="text-right">Output</Th><Th className="text-right">Cost</Th></Tr></THead>
          <TBody>{s.topRequests.map((r) => (<Tr key={r.id} className="hover:bg-raised"><Td><Link className="num hover:underline" to={`/requests/${encodeURIComponent(r.id)}`}>{formatTime(r.startedAt)}</Link></Td><Td className="num">{r.model ?? '—'}</Td><Td className="text-right"><Num value={r.totalInputTokens} /></Td><Td className="text-right"><Num value={r.cacheReadTokens} /></Td><Td className="text-right"><Num value={r.outputTokens} /></Td><Td className="text-right"><Num value={r.totalNanoUsd} as="usd" /></Td></Tr>))}</TBody>
        </Table>
      </Panel>
      <p className="text-[11px] text-muted">Pricing <span className="num">{s.pricing.version}</span> · {s.pricing.source} · effective {s.pricing.effectiveDate}. {s.disclaimer}</p>
    </div>
  );
}
