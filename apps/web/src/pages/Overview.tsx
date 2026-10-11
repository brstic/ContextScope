import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { FindingList } from '../components/Findings';
import { PageHeader } from '../components/Layout';
import { Metric, MetricGrid } from '../components/Metric';
import { Est, Num } from '../components/Num';
import { ErrorState, GetStarted, LoadingBlock } from '../components/States';
import { axisProps, ChartFrame, gridProps, HBarList, LegendDot, tokenTick, tooltipProps } from '../components/charts';
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/table';
import { api } from '../lib/api';
import {
  formatBucket,
  formatMs,
  formatPct,
  formatTime,
  formatTokens,
  formatUsd,
  providerLabel,
  shortId,
} from '../lib/format';
import { useState } from 'react';
import { Select } from '../components/ui/select';

const RANGES = [
  { value: '1h', label: 'Last hour', ms: 3600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 86400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86400_000 },
  { value: '365d', label: 'Last 12 months', ms: 365 * 86400_000 },
];

const PROVIDER_COLORS = ['var(--uncached)', 'var(--cache-read)', 'var(--output)', 'var(--reasoning)'];

export default function OverviewPage() {
  // 30 days by default: a profiler is opened after traffic happened, not only during it.
  const [range, setRange] = useState('30d');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const ms = RANGES.find((r) => r.value === range)?.ms ?? 86400_000;
  // Round to the minute so the query key is stable between renders.
  const to = Math.ceil(Date.now() / 60_000) * 60_000;
  const from = new Date(to - ms).toISOString();
  const filters = useQuery({ queryKey: ['filters'], queryFn: ({ signal }) => api.filters(signal) });
  const q = useQuery({
    queryKey: ['overview', range, from, provider, model],
    queryFn: ({ signal }) =>
      api.overview(
        { from, to: new Date(to).toISOString(), provider: provider || undefined, model: model || undefined },
        signal,
      ),
  });
  const providerOptions = (filters.data?.providers ?? []).map((p) => ({ value: p, label: providerLabel(p) }));
  const modelOptions = [
    ...new Set(
      (filters.data?.models ?? []).filter((m) => !provider || m.provider === provider).map((m) => m.model),
    ),
  ].map((m) => ({ value: m, label: m }));
  const bucket = ms > 2 * 86400_000 ? 'day' : 'hour';

  const header = (
    <PageHeader
      title="Overview"
      description="Traffic captured by the local proxy. Token counts are reported by providers unless marked est."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Provider"
            anyLabel="All providers"
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              setModel('');
            }}
            options={providerOptions}
            className="w-36"
          />
          <Select
            label="Model"
            anyLabel="All models"
            value={model}
            onValueChange={setModel}
            options={modelOptions}
            className="w-44"
          />
          <Select label="Time range" value={range} onValueChange={setRange} options={RANGES} className="w-36" />
        </div>
      }
    />
  );

  if (q.isPending) {
    return (
      <div>
        {header}
        <MetricGrid>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-[72px]" />
          ))}
        </MetricGrid>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-60" />
          <Skeleton className="h-60" />
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div>
        {header}
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  const d = q.data;
  const t = d.totals;
  const hasAnyData = (filters.data?.providers.length ?? 0) > 0;
  if (t.requests === 0 && !provider && !model && !hasAnyData) {
    return (
      <div>
        {header}
        <Panel>
          <GetStarted />
        </Panel>
      </div>
    );
  }
  if (t.requests === 0) {
    return (
      <div>
        {header}
        <Panel>
          <PanelBody className="text-muted">
            No requests match these filters in the selected range. Choose a longer time range or clear the
            provider and model filters.
          </PanelBody>
        </Panel>
      </div>
    );
  }
  const series = d.series.map((b) => ({ ...b, label: formatBucket(b.t, bucket), hit: hitRate(b) }));

  return (
    <div className="space-y-3">
      {header}
      <MetricGrid>
        <Metric label="Requests" value={<Num value={t.requests} as="int" />} sub={`${t.errors} errors`} />
        <Metric
          label="Input tokens"
          value={<Num value={t.inputTokens} />}
          accent="var(--uncached)"
          sub={t.requestsWithoutUsage ? `${t.requestsWithoutUsage} without usage¹` : 'reported'}
        />
        <Metric label="Output tokens" value={<Num value={t.outputTokens} />} accent="var(--output)" sub="reported" />
        <Metric
          label="Cache token hit rate"
          value={<Num value={t.cacheHitRate} as="pct" hint="No request reported both input and cache reads" />}
          accent="var(--cache-read)"
          sub={
            <>
              <span className="num">{formatTokens(t.cacheReadTokens)}</span> read ·{' '}
              <span className="num">{formatTokens(t.cacheWriteTokens)}</span> written
            </>
          }
        />
        <Metric
          label="Cost"
          value={
            <>
              {formatUsd(t.totalNanoUsd)}
              <Est />
            </>
          }
          sub={t.unpricedRequests ? `${t.unpricedRequests} unpriced²` : 'from pricing table'}
        />
        <Metric label="Avg latency" value={<Num value={t.avgDurationMs} as="ms" />} />
        <Metric label="p95 latency" value={<Num value={t.p95DurationMs} as="ms" />} />
        <Metric
          label="Open findings"
          value={
            <Link to="/optimizations" className="hover:underline">
              {t.openFindings}
            </Link>
          }
        />
      </MetricGrid>
      {t.requestsWithoutUsage || t.unpricedRequests ? (
        <p className="text-[11px] text-muted">
          {t.requestsWithoutUsage ? (
            <>¹ {t.requestsWithoutUsage} requests reported no usage and are excluded from token totals. </>
          ) : null}
          {t.unpricedRequests ? (
            <>² {t.unpricedRequests} requests had no matching price and are excluded from cost.</>
          ) : null}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Request volume" description="Requests and errors per bucket" />
          <PanelBody>
            <ChartFrame title="Request volume over time">
              <BarChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis {...axisProps} allowDecimals={false} />
                <RTooltip {...tooltipProps} />
                <Bar dataKey="requests" name="Requests" stackId="a" fill="var(--muted)" isAnimationActive={false} />
                <Bar dataKey="errors" name="Errors" fill="var(--error)" isAnimationActive={false} />
              </BarChart>
            </ChartFrame>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader
            title="Tokens"
            description={
              <span className="flex flex-wrap gap-3">
                <LegendDot color="var(--uncached)" label="Uncached input" />
                <LegendDot color="var(--cache-read)" label="Cache read" />
                <LegendDot color="var(--cache-write)" label="Cache write" />
                <LegendDot color="var(--output)" label="Output" />
              </span>
            }
          />
          <PanelBody>
            <ChartFrame title="Tokens over time, stacked by uncached input, cache read, cache write and output">
              <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis {...axisProps} tickFormatter={tokenTick} />
                <RTooltip {...tooltipProps} formatter={(v) => formatTokens(Number(v))} />
                {(
                  [
                    ['uncachedInputTokens', 'Uncached input', 'var(--uncached)'],
                    ['cacheReadTokens', 'Cache read', 'var(--cache-read)'],
                    ['cacheWriteTokens', 'Cache write', 'var(--cache-write)'],
                    ['outputTokens', 'Output', 'var(--output)'],
                  ] as const
                ).map(([k, n, c]) => (
                  <Area
                    key={k}
                    type="monotone"
                    dataKey={k}
                    name={n}
                    stackId="t"
                    stroke={c}
                    fill={c}
                    fillOpacity={0.35}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ChartFrame>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Cache token hit rate" description="Cache read ÷ total input, per bucket (reported)" />
          <PanelBody>
            <ChartFrame title="Cache hit rate trend">
              <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis {...axisProps} domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                <RTooltip {...tooltipProps} formatter={(v) => formatPct(v === null ? null : Number(v))} />
                <Line
                  dataKey="hit"
                  name="Hit rate"
                  stroke="var(--cache-read)"
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartFrame>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Cost by model" description="Estimated from the pricing table" />
          <PanelBody>
            <HBarList
              title="Cost by model"
              format={formatUsd}
              rows={[...d.byModel]
                .sort((a, b) => b.totalNanoUsd - a.totalNanoUsd)
                .slice(0, 8)
                .map((m) => ({
                  key: `${m.provider}:${m.model}`,
                  label: (
                    <span>
                      <span className="num">{m.model}</span>{' '}
                      <span className="text-muted">{providerLabel(m.provider)}</span>
                    </span>
                  ),
                  value: m.totalNanoUsd,
                  sub: m.unpriced ? `${m.unpriced} unpriced requests excluded` : undefined,
                }))}
            />
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel>
          <PanelHeader title="Providers" description="Share of requests" />
          <PanelBody>
            <HBarList
              title="Provider distribution"
              format={(v) => `${v} req`}
              rows={d.byProvider.map((p, i) => ({
                key: p.provider,
                label: providerLabel(p.provider),
                value: p.requests,
                color: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
                sub: (
                  <>
                    <span className="num">{formatTokens(p.inputTokens)}</span> input ·{' '}
                    <span className="num">{formatUsd(p.totalNanoUsd)}</span> est.
                  </>
                ),
              }))}
            />
          </PanelBody>
        </Panel>
        <Panel className="lg:col-span-2">
          <PanelHeader title="Top sessions" description="By estimated cost" />
          <Table>
            <THead>
              <Tr>
                <Th>Session</Th>
                <Th className="text-right">Requests</Th>
                <Th className="text-right">Input</Th>
                <Th className="text-right">Hit rate</Th>
                <Th className="text-right">Cost</Th>
              </Tr>
            </THead>
            <TBody>
              {d.topSessions.length === 0 ? (
                <Tr>
                  <Td colSpan={5} className="text-muted">
                    No sessions. Send the x-contextscope-session header to group requests.
                  </Td>
                </Tr>
              ) : (
                d.topSessions.slice(0, 6).map((s) => (
                  <Tr key={s.id} className="hover:bg-raised">
                    <Td>
                      <Link to={`/sessions/${encodeURIComponent(s.id)}`} className="num hover:underline">
                        {s.id}
                      </Link>
                    </Td>
                    <Td className="num text-right">{s.requests}</Td>
                    <Td className="text-right">
                      <Num value={s.inputTokens} />
                    </Td>
                    <Td className="text-right">
                      <Num value={s.cacheHitRate} as="pct" />
                    </Td>
                    <Td className="text-right">
                      <Num value={s.totalNanoUsd} as="usd" />
                    </Td>
                  </Tr>
                ))
              )}
            </TBody>
          </Table>
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Top requests" description="Most expensive in range" />
          <Table>
            <THead>
              <Tr>
                <Th>Time</Th>
                <Th>Model</Th>
                <Th className="text-right">Input</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Duration</Th>
              </Tr>
            </THead>
            <TBody>
              {d.topRequests.slice(0, 8).map((r) => (
                <Tr key={r.id} className="hover:bg-raised">
                  <Td>
                    <Link to={`/requests/${encodeURIComponent(r.id)}`} className="num hover:underline">
                      {formatTime(r.startedAt)}
                    </Link>
                  </Td>
                  <Td className="num max-w-[180px] truncate" title={r.model ?? undefined}>
                    {r.model ?? '—'}
                  </Td>
                  <Td className="text-right">
                    <Num value={r.totalInputTokens} />
                  </Td>
                  <Td className="text-right">
                    <Num value={r.totalNanoUsd} as="usd" hint="Not priced: no matching model in the pricing table" />
                  </Td>
                  <Td className="num text-right">{formatMs(r.durationMs)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {d.topRequests.length === 0 ? <LoadingBlock rows={0} /> : null}
        </Panel>
        <Panel>
          <PanelHeader
            title="Recent findings"
            actions={
              <Link to="/optimizations" className="text-[12px] text-muted hover:text-fg">
                All optimizations
              </Link>
            }
          />
          <FindingList findings={d.recentFindings.slice(0, 6)} empty="No findings in this range." />
        </Panel>
      </div>
      <p className="text-[11px] text-muted">
        Showing {shortId(d.range.from, 10)} to {shortId(d.range.to, 10)}. Costs are estimates from public price lists,
        not invoices.
      </p>
    </div>
  );
}

const hitRate = (b: { inputTokens: number; cacheReadTokens: number }): number | null =>
  b.inputTokens > 0 ? b.cacheReadTokens / b.inputTokens : null;
