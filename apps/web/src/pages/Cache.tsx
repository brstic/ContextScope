import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { FindingList } from '../components/Findings';
import { PageHeader } from '../components/Layout';
import { Metric, MetricGrid } from '../components/Metric';
import { Num } from '../components/Num';
import { ErrorState, GetStarted, LoadingBlock } from '../components/States';
import { axisProps, ChartFrame, gridProps, HBarList, LegendDot, tokenTick, tooltipProps } from '../components/charts';
import { Badge } from '../components/ui/badge';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Select } from '../components/ui/select';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api, type Bucket } from '../lib/api';
import { formatBucket, formatPct, formatTokens, kindLabel, providerLabel } from '../lib/format';

export default function CachePage() {
  const [bucket, setBucket] = useState<Bucket>('hour');
  const sum = useQuery({ queryKey: ['cache', 'summary'], queryFn: ({ signal }) => api.cacheSummary(signal) });
  const trend = useQuery({ queryKey: ['cache', 'trends', bucket], queryFn: ({ signal }) => api.cacheTrends(bucket, signal) });
  const header = <PageHeader title="Cache Analyzer" description="Prompt-cache reads and writes as reported by providers, plus local prefix-stability estimates." actions={<Select label="Bucket" value={bucket} onValueChange={(v) => setBucket(v as Bucket)} options={[{ value: 'hour', label: 'Hourly' }, { value: 'day', label: 'Daily' }]} className="w-28" />} />;
  if (sum.isPending) return <div>{header}<LoadingBlock rows={8} /></div>;
  if (sum.isError) return <div>{header}<ErrorState error={sum.error} onRetry={() => void sum.refetch()} /></div>;
  const s = sum.data;
  const t = s.totals;
  if (t.requestsReportingUsage === 0) return <div>{header}<Panel><GetStarted /></Panel></div>;
  const series = (trend.data ?? []).map((b) => ({ ...b, label: formatBucket(b.t, bucket) }));
  return (
    <div className="space-y-3">
      {header}
      <div className="flex items-center gap-2 text-[12px] text-muted"><Badge tone="read">Reported by providers</Badge> totals, trend and per-model numbers</div>
      <MetricGrid className="xl:grid-cols-5">
        <Metric label="Cache reads" value={<Num value={t.cacheReadTokens} />} accent="var(--cache-read)" sub={`${t.requestsWithCacheRead} requests`} />
        <Metric label="Cache writes" value={<Num value={t.cacheWriteTokens} />} accent="var(--cache-write)" sub={`${t.requestsWithCacheWrite} requests`} />
        <Metric label="Token hit rate" value={<Num value={t.cacheHitRate} as="pct" />} accent="var(--cache-read)" sub={`of ${formatTokens(t.inputTokens)} input`} />
        <Metric label="Actual savings" value={<Num value={t.actualSavingsNanoUsd} as="usd" />} sub="measured vs uncached price" />
        <Metric label="Reporting usage" value={t.requestsReportingUsage} sub="requests" />
      </MetricGrid>
      <Panel>
        <PanelHeader title="Cache trend" description={<span className="flex flex-wrap gap-3"><LegendDot color="var(--uncached)" label="Uncached" /><LegendDot color="var(--cache-read)" label="Read" /><LegendDot color="var(--cache-write)" label="Write" /></span>} />
        <PanelBody>
          {trend.isError ? <ErrorState error={trend.error} onRetry={() => void trend.refetch()} /> : (
            <ChartFrame title="Cache tokens over time">
              <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis {...axisProps} tickFormatter={tokenTick} />
                <RTooltip {...tooltipProps} formatter={(v) => formatTokens(Number(v))} />
                <Area dataKey="uncachedInputTokens" name="Uncached" stackId="c" stroke="var(--uncached)" fill="var(--uncached)" fillOpacity={0.3} isAnimationActive={false} />
                <Area dataKey="cacheReadTokens" name="Cache read" stackId="c" stroke="var(--cache-read)" fill="var(--cache-read)" fillOpacity={0.35} isAnimationActive={false} />
                <Area dataKey="cacheWriteTokens" name="Cache write" stackId="c" stroke="var(--cache-write)" fill="var(--cache-write)" fillOpacity={0.35} isAnimationActive={false} />
              </AreaChart>
            </ChartFrame>
          )}
        </PanelBody>
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="By provider" />
          <Table>
            <THead><Tr><Th>Provider</Th><Th className="text-right">Input</Th><Th className="text-right">Read</Th><Th className="text-right">Write</Th><Th className="text-right">Hit rate</Th><Th className="text-right">Savings</Th></Tr></THead>
            <TBody>{s.byProvider.map((p) => (<Tr key={p.provider}><Td>{providerLabel(p.provider)}</Td><Td className="text-right"><Num value={p.inputTokens} /></Td><Td className="text-right"><Num value={p.cacheReadTokens} /></Td><Td className="text-right"><Num value={p.cacheWriteTokens} /></Td><Td className="text-right"><Num value={p.cacheHitRate} as="pct" /></Td><Td className="text-right"><Num value={p.actualSavingsNanoUsd} as="usd" /></Td></Tr>))}</TBody>
          </Table>
        </Panel>
        <Panel>
          <PanelHeader title="Prefix stability" description={<><Badge tone="uncached">Eligibility estimate</Badge> from local fingerprints, not provider data</>} />
          <PanelBody className="space-y-3">
            <div className="flex flex-wrap gap-6 text-[12px]">
              <span className="text-muted">Avg shared prefix <span className="num ml-1 text-[16px] text-fg">{formatPct(s.prefixStability.avgSharedSegmentRatio)}</span></span>
              <span className="text-muted">Comparisons <span className="num ml-1 text-[16px] text-fg">{s.prefixStability.comparisons}</span></span>
            </div>
            <div><h3 className="mb-1.5 text-[12px] text-muted">Where the prefix first changes, by segment kind</h3>
              <HBarList title="First change by kind" format={(v) => String(v)} color="var(--cache-write)" rows={s.prefixStability.firstChangeByKind.map((k) => ({ key: k.kind, label: kindLabel(k.kind), value: k.count }))} />
            </div>
          </PanelBody>
        </Panel>
      </div>
      <Panel>
        <PanelHeader title="By model" />
        <Table>
          <THead><Tr><Th>Model</Th><Th>Provider</Th><Th className="text-right">Requests</Th><Th className="text-right">Input</Th><Th className="text-right">Read</Th><Th className="text-right">Write</Th><Th className="text-right">Hit rate</Th><Th className="text-right">Savings</Th></Tr></THead>
          <TBody>{s.byModel.map((m) => (<Tr key={`${m.provider}:${m.model}`}><Td className="num">{m.model}</Td><Td>{providerLabel(m.provider)}</Td><Td className="num text-right">{m.requests}</Td><Td className="text-right"><Num value={m.inputTokens} /></Td><Td className="text-right"><Num value={m.cacheReadTokens} /></Td><Td className="text-right"><Num value={m.cacheWriteTokens} /></Td><Td className="text-right"><Num value={m.cacheHitRate} as="pct" /></Td><Td className="text-right"><Num value={m.actualSavingsNanoUsd} as="usd" /></Td></Tr>))}</TBody>
        </Table>
      </Panel>
      <Panel>
        <PanelHeader title="Cache findings" />
        <FindingList findings={s.findings} empty="No cache findings." />
      </Panel>
    </div>
  );
}
