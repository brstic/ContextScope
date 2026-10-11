import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { FindingList } from '../components/Findings';
import { PageHeader } from '../components/Layout';
import { Metric, MetricGrid } from '../components/Metric';
import { Num } from '../components/Num';
import { ErrorState, LoadingBlock } from '../components/States';
import { axisProps, ChartFrame, gridProps, LegendDot, tokenTick, tooltipProps } from '../components/charts';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api } from '../lib/api';
import { formatTime, formatTokens } from '../lib/format';

export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['session', id], queryFn: ({ signal }) => api.session(id, signal) });
  if (q.isPending) return <LoadingBlock rows={8} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const data = s.turns.map((t, i) => ({ ...t, turn: i + 1 }));
  return (
    <div className="space-y-3">
      <PageHeader title={<span className="num">{s.id}</span>} description={`Session · ${s.models.join(', ')}`} actions={<Link className="text-[12px] text-muted hover:text-fg" to={`/requests?session=${encodeURIComponent(s.id)}`}>Show requests</Link>} />
      <MetricGrid className="xl:grid-cols-6">
        <Metric label="Turns" value={s.requests} />
        <Metric label="Input" value={<Num value={s.inputTokens} />} accent="var(--uncached)" />
        <Metric label="Output" value={<Num value={s.outputTokens} />} accent="var(--output)" />
        <Metric label="Cache hit rate" value={<Num value={s.cacheHitRate} as="pct" />} accent="var(--cache-read)" />
        <Metric label="Cost (est.)" value={<Num value={s.totalNanoUsd} as="usd" />} />
        <Metric label="Avg latency" value={<Num value={s.avgDurationMs} as="ms" />} />
      </MetricGrid>
      <Panel>
        <PanelHeader
          title="Context growth per turn"
          description={<span className="flex flex-wrap gap-3"><LegendDot color="var(--uncached)" label="Uncached" /><LegendDot color="var(--cache-read)" label="Cache read" /><LegendDot color="var(--cache-write)" label="Cache write" /><LegendDot color="var(--output)" label="Output (line)" /></span>}
        />
        <PanelBody>
          <ChartFrame title="Context growth per turn, stacked input with output line" height={240}>
            <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="turn" {...axisProps} />
              <YAxis {...axisProps} tickFormatter={tokenTick} />
              <RTooltip {...tooltipProps} formatter={(v) => formatTokens(v === null ? null : Number(v))} />
              <Bar dataKey="uncachedInputTokens" name="Uncached" stackId="i" fill="var(--uncached)" isAnimationActive={false} />
              <Bar dataKey="cacheReadTokens" name="Cache read" stackId="i" fill="var(--cache-read)" isAnimationActive={false} />
              <Bar dataKey="cacheWriteTokens" name="Cache write" stackId="i" fill="var(--cache-write)" isAnimationActive={false} />
              <Line dataKey="outputTokens" name="Output" stroke="var(--output)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            </ComposedChart>
          </ChartFrame>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Turns" />
        <Table>
          <THead><Tr><Th>#</Th><Th>Time</Th><Th>Model</Th><Th className="text-right">Input</Th><Th className="text-right">Cache read</Th><Th className="text-right">Cache write</Th><Th className="text-right">Output</Th><Th className="text-right">Cost</Th><Th className="text-right">Duration</Th><Th>First changed segment</Th></Tr></THead>
          <TBody>
            {data.map((t) => (
              <Tr key={t.requestId} className="hover:bg-raised">
                <Td className="num text-muted">{t.turn}</Td>
                <Td><Link className="num hover:underline" to={`/requests/${encodeURIComponent(t.requestId)}`}>{formatTime(t.startedAt)}</Link></Td>
                <Td className="num">{t.model ?? '—'}</Td>
                <Td className="text-right"><Num value={t.totalInputTokens} /></Td>
                <Td className="text-right"><Num value={t.cacheReadTokens} /></Td>
                <Td className="text-right"><Num value={t.cacheWriteTokens} /></Td>
                <Td className="text-right"><Num value={t.outputTokens} /></Td>
                <Td className="text-right"><Num value={t.totalNanoUsd} as="usd" /></Td>
                <Td className="text-right"><Num value={t.durationMs} as="ms" /></Td>
                <Td className="num">{t.firstChangedSegmentIndex === null ? <span className="text-muted">—</span> : `#${t.firstChangedSegmentIndex} of ${t.segmentCount}`}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Panel>
      <Panel>
        <PanelHeader title="Findings" />
        <FindingList findings={s.findings} empty="No findings for this session." />
      </Panel>
    </div>
  );
}
