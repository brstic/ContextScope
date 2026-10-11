import type { Page, RequestSummary } from '@contextscope/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronRight, Pause, Play, Search } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ContextStrip, UsageBar } from '../components/ContextStrip';
import { PageHeader } from '../components/Layout';
import { Num } from '../components/Num';
import { ErrorState, GetStarted, LoadingBlock } from '../components/States';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Panel } from '../components/ui/panel';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { api, type RequestListParams } from '../lib/api';
import { formatDateTime, formatTime, providerLabel, shortId, stateLabel } from '../lib/format';
import { useLive } from '../lib/live';
import { cn } from '../lib/utils';

type SortKey = NonNullable<RequestListParams['sort']>;
const SORTABLE: Record<string, SortKey> = {
  time: 'startedAt',
  input: 'inputTokens',
  cost: 'cost',
  duration: 'duration',
};
const PAGE_SIZES = [25, 50, 100];

/** Does a live row belong in the current filtered view? Mirrors the server filters. */
export const matchesFilters = (r: RequestSummary, p: RequestListParams): boolean => {
  if (p.provider && r.provider !== p.provider) return false;
  if (p.model && r.model !== p.model) return false;
  if (p.state && r.state !== p.state) return false;
  if (p.session && r.sessionId !== p.session) return false;
  if (p.q) {
    const q = p.q.toLowerCase();
    const hay = [r.id, r.model ?? '', r.sessionId ?? '', r.endpoint, r.provider].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
};

const StatusCell = ({ r }: { r: RequestSummary }) => {
  if (r.state === 'pending') return <Badge tone="neutral">pending</Badge>;
  if (r.state !== 'completed') return <Badge tone="error">{stateLabel(r.state).toLowerCase()}</Badge>;
  const ok = r.httpStatus !== null && r.httpStatus < 400;
  return (
    <span className={cn('num', ok ? 'text-success' : 'text-error')} title={stateLabel(r.state)}>
      {r.httpStatus ?? '—'}
    </span>
  );
};

const ExpandedRow = ({ id, cols }: { id: string; cols: number }) => {
  const ctx = useQuery({ queryKey: ['request', id, 'context'], queryFn: ({ signal }) => api.requestContext(id, signal) });
  const det = useQuery({ queryKey: ['request', id], queryFn: ({ signal }) => api.request(id, signal) });
  return (
    <tr className="border-b border-border bg-bg/40">
      <td colSpan={cols} className="px-3 py-2.5">
        {ctx.isPending || det.isPending ? (
          <Skeleton className="h-8 w-full" />
        ) : ctx.isError || det.isError ? (
          <span className="text-[12px] text-error">Could not load context for this request.</span>
        ) : (
          <div className="max-w-3xl space-y-1">
            <ContextStrip
              segments={ctx.data.segments}
              sharedSegments={det.data.prefix?.sharedSegments ?? null}
              height={14}
              mini
            />
            <UsageBar usage={det.data.usage} height={6} mini />
            <div className="text-[11px] text-muted">
              {ctx.data.segments.length} segments
              {det.data.prefix
                ? ` · ${det.data.prefix.sharedSegments}/${det.data.prefix.totalSegments} shared with previous`
                : ''}{' '}
              · top: estimated structure, bottom: reported usage
            </div>
          </div>
        )}
      </td>
    </tr>
  );
};

export default function RequestsPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const live = useLive();

  const params: RequestListParams = {
    page: Number(sp.get('page') ?? '1') || 1,
    pageSize: Number(sp.get('pageSize') ?? '50') || 50,
    q: sp.get('q') ?? undefined,
    provider: sp.get('provider') ?? undefined,
    model: sp.get('model') ?? undefined,
    state: sp.get('state') ?? undefined,
    session: sp.get('session') ?? undefined,
    sort: (sp.get('sort') as SortKey | null) ?? 'startedAt',
    dir: (sp.get('dir') as 'asc' | 'desc' | null) ?? 'desc',
  };
  const queryKey = ['requests', params] as const;
  const list = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.requests(params, signal),
    placeholderData: keepPreviousData,
  });
  const filters = useQuery({ queryKey: ['filters'], queryFn: ({ signal }) => api.filters(signal) });

  const setParam = useCallback(
    (patch: Record<string, string | number | undefined>) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  // Search input is debounced into the URL.
  const [qInput, setQInput] = useState(params.q ?? '');
  useEffect(() => {
    const h = setTimeout(() => {
      if ((params.q ?? '') !== qInput) setParam({ q: qInput || undefined });
    }, 300);
    return () => clearTimeout(h);
  }, [qInput, params.q, setParam]);

  // Live prepend: only on the first page of the newest-first view. One cache write per SSE batch.
  const isLiveView = params.page === 1 && params.sort === 'startedAt' && params.dir === 'desc';
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const paramsRef = useRef(params);
  paramsRef.current = params;
  useEffect(
    () =>
      live.subscribe((completed) => {
        if (!completed.length) return;
        const p = paramsRef.current;
        if (!(p.page === 1 && p.sort === 'startedAt' && p.dir === 'desc')) return;
        const incoming = completed.filter((r) => matchesFilters(r, p));
        if (!incoming.length) return;
        qc.setQueryData<Page<RequestSummary>>(['requests', p], (old) => {
          if (!old) return old;
          const ids = new Set(incoming.map((r) => r.id));
          const kept = old.items.filter((r) => !ids.has(r.id));
          const added = incoming.filter((r) => !old.items.some((o) => o.id === r.id)).length;
          const items = [...[...incoming].reverse(), ...kept].slice(0, old.pageSize);
          return { ...old, items, total: old.total + added };
        });
        setFresh(new Set(incoming.map((r) => r.id)));
      }),
    [live, qc],
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const rows = list.data?.items ?? [];

  const columns = useMemo<ColumnDef<RequestSummary>[]>(
    () => [
      {
        id: 'expand',
        header: () => <span className="sr-only">Expand</span>,
        cell: ({ row }) => {
          const open = expanded.has(row.original.id);
          return (
            <button
              type="button"
              aria-label={open ? 'Hide context strip' : 'Show context strip'}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(row.original.id)) n.delete(row.original.id);
                  else n.add(row.original.id);
                  return n;
                });
              }}
              className="rounded-[4px] p-0.5 text-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
            </button>
          );
        },
      },
      {
        id: 'time',
        header: 'Time',
        cell: ({ row }) => (
          <span className="num" title={formatDateTime(row.original.startedAt)}>
            {formatTime(row.original.startedAt)}
          </span>
        ),
      },
      {
        id: 'provider',
        header: 'Provider',
        cell: ({ row }) => (
          <span>
            {providerLabel(row.original.provider)}
            {row.original.demo ? (
              <Badge tone="write" className="ml-1.5">
                demo
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'model',
        header: 'Model',
        cell: ({ row }) => (
          <span className="num block max-w-[220px] truncate" title={row.original.model ?? undefined}>
            {row.original.model ?? <Num value={null} />}
          </span>
        ),
      },
      {
        id: 'session',
        header: 'Session',
        cell: ({ row }) =>
          row.original.sessionId ? (
            <span className="num text-muted" title={row.original.sessionId}>
              {shortId(row.original.sessionId, 12)}
            </span>
          ) : (
            <span className="text-muted">—</span>
          ),
      },
      {
        id: 'input',
        header: 'Input',
        meta: { right: true },
        cell: ({ row }) => <Num value={row.original.totalInputTokens} />,
      },
      {
        id: 'output',
        header: 'Output',
        meta: { right: true },
        cell: ({ row }) => <Num value={row.original.outputTokens} />,
      },
      {
        id: 'cached',
        header: 'Cached',
        meta: { right: true },
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="inline-flex gap-1.5">
              <Num value={r.cacheReadTokens} className="text-cache-read" />
              {r.cacheWriteTokens ? (
                <span className="num text-cache-write" title="Cache write tokens">
                  +<Num value={r.cacheWriteTokens} />
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'cost',
        header: 'Cost',
        meta: { right: true },
        cell: ({ row }) => (
          <Num
            value={row.original.totalNanoUsd}
            as="usd"
            hint="Not priced: model missing from the pricing table or usage not reported"
          />
        ),
      },
      {
        id: 'duration',
        header: 'Duration',
        meta: { right: true },
        cell: ({ row }) => <Num value={row.original.durationMs} as="ms" />,
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <StatusCell r={row.original} />
            {row.original.findingCount ? (
              <Badge tone="write" title={`${row.original.findingCount} findings`}>
                {row.original.findingCount}
              </Badge>
            ) : null}
          </span>
        ),
      },
    ],
    [expanded],
  );

  const sorting: SortingState = useMemo(() => {
    const id = Object.entries(SORTABLE).find(([, v]) => v === params.sort)?.[0] ?? 'time';
    return [{ id, desc: params.dir !== 'asc' }];
  }, [params.sort, params.dir]);

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    state: { sorting },
    getRowId: (r) => r.id,
  });

  // Keyboard: j/k or arrows move, Enter opens.
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [role="combobox"], [role="listbox"], [role="dialog"]') || t.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!rows.length) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        if (t && t.closest('button, a') && !t.closest('[data-row]')) return;
        const r = rows[Math.min(cursor, rows.length - 1)];
        if (r) navigate(`/requests/${encodeURIComponent(r.id)}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, navigate]);
  useEffect(() => {
    tableRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onSort = (colId: string) => {
    const key = SORTABLE[colId];
    if (!key) return;
    const dir = params.sort === key && params.dir === 'desc' ? 'asc' : 'desc';
    setParam({ sort: key === 'startedAt' && dir === 'desc' ? undefined : key, dir: dir === 'desc' ? undefined : dir });
  };

  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (params.pageSize ?? 50)));
  const hasFilters = Boolean(params.q || params.provider || params.model || params.state || params.session);
  const modelOptions = (filters.data?.models ?? [])
    .filter((m) => !params.provider || m.provider === params.provider)
    .map((m) => ({ value: m.model, label: m.model }));

  return (
    <div className="space-y-3">
      <PageHeader
        title="Live Requests"
        description={
          <>
            Newest first. <kbd className="num">j</kbd>/<kbd className="num">k</kbd> or arrows to move,{' '}
            <kbd className="num">Enter</kbd> to inspect.
          </>
        }
        actions={
          <Button size="sm" onClick={() => live.setPaused(!live.paused)} aria-pressed={live.paused}>
            {live.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {live.paused ? 'Resume live' : 'Pause live'}
          </Button>
        }
      />
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
          <label className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <span className="sr-only">Search requests</span>
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search id, model, session"
              className="h-8 w-full rounded-[4px] border border-border bg-bg pl-7 pr-2 text-[13px] placeholder:text-muted"
            />
          </label>
          <Select
            label="Provider"
            anyLabel="All providers"
            value={params.provider ?? ''}
            onValueChange={(v) => setParam({ provider: v || undefined, model: undefined })}
            options={(filters.data?.providers ?? []).map((p) => ({ value: p, label: providerLabel(p) }))}
            className="w-36"
          />
          <Select
            label="Model"
            anyLabel="All models"
            value={params.model ?? ''}
            onValueChange={(v) => setParam({ model: v || undefined })}
            options={modelOptions}
            className="w-44"
          />
          <Select
            label="State"
            anyLabel="All states"
            value={params.state ?? ''}
            onValueChange={(v) => setParam({ state: v || undefined })}
            options={(filters.data?.states ?? []).map((s) => ({ value: s, label: stateLabel(s) }))}
            className="w-36"
          />
          {params.session ? (
            <Badge tone="outline">
              session <span className="num">{shortId(params.session, 12)}</span>
              <button
                type="button"
                aria-label="Clear session filter"
                className="ml-1 text-muted hover:text-fg"
                onClick={() => setParam({ session: undefined })}
              >
                ×
              </button>
            </Badge>
          ) : null}
          {hasFilters ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQInput('');
                setParam({ q: undefined, provider: undefined, model: undefined, state: undefined, session: undefined });
              }}
            >
              Clear filters
            </Button>
          ) : null}
          <span className="ml-auto text-[12px] text-muted">
            {live.inFlight ? <span className="mr-2">{live.inFlight} in flight</span> : null}
            {!isLiveView ? <span className="mr-2">live updates show on page 1, newest first</span> : null}
            <span className="num text-fg">{total.toLocaleString('en-US')}</span> requests
          </span>
        </div>

        {list.isPending ? (
          <LoadingBlock rows={8} label="Loading requests" />
        ) : list.isError ? (
          <div className="p-3">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          hasFilters ? (
            <p className="p-4 text-[13px] text-muted">No requests match these filters.</p>
          ) : (
            <GetStarted />
          )
        ) : (
          <div ref={tableRef} className="max-h-[calc(100vh-230px)] min-h-[200px] overflow-auto">
            <table className="w-full border-collapse text-[12px]" aria-label="Captured requests" aria-rowcount={total}>
              <thead className="sticky top-0 z-10 bg-panel">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => {
                      const sortable = h.column.id in SORTABLE;
                      const s = sorting[0]?.id === h.column.id ? (sorting[0]?.desc ? 'descending' : 'ascending') : 'none';
                      const right = (h.column.columnDef.meta as { right?: boolean } | undefined)?.right;
                      return (
                        <th
                          key={h.id}
                          aria-sort={sortable ? s : undefined}
                          className={cn(
                            'h-8 whitespace-nowrap border-b border-border px-2.5 text-[12px] font-medium text-muted',
                            right ? 'text-right' : 'text-left',
                            h.column.id === 'expand' && 'w-7 px-1.5',
                          )}
                        >
                          {sortable ? (
                            <button
                              type="button"
                              onClick={() => onSort(h.column.id)}
                              className="inline-flex items-center gap-1 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              {flexRender(h.column.columnDef.header, h.getContext())}
                              {s === 'descending' ? (
                                <ArrowDown className="size-3" aria-hidden />
                              ) : s === 'ascending' ? (
                                <ArrowUp className="size-3" aria-hidden />
                              ) : null}
                            </button>
                          ) : (
                            flexRender(h.column.columnDef.header, h.getContext())
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row, i) => (
                  <Fragment key={row.id}>
                    <tr
                      data-row={i}
                      aria-selected={i === cursor}
                      onClick={() => navigate(`/requests/${encodeURIComponent(row.original.id)}`)}
                      onMouseEnter={() => setCursor(i)}
                      className={cn(
                        'cursor-pointer border-b border-border hover:bg-raised',
                        i === cursor && 'bg-raised shadow-[inset_2px_0_0_var(--text)]',
                        fresh.has(row.original.id) && 'cs-flash',
                        list.isPlaceholderData && 'opacity-60',
                      )}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const right = (cell.column.columnDef.meta as { right?: boolean } | undefined)?.right;
                        return (
                          <td
                            key={cell.id}
                            className={cn(
                              'h-8 whitespace-nowrap px-2.5 align-middle',
                              right && 'text-right',
                              cell.column.id === 'expand' && 'w-7 px-1.5',
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded.has(row.original.id) ? <ExpandedRow id={row.original.id} cols={columns.length} /> : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-2 text-[12px]">
          <span className="text-muted">
            Page <span className="num text-fg">{params.page}</span> of <span className="num text-fg">{pageCount}</span>
          </span>
          <div className="flex items-center gap-2">
            <Select
              label="Rows per page"
              value={String(params.pageSize)}
              onValueChange={(v) => setParam({ pageSize: v === '50' ? undefined : v })}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))}
              className="w-28"
            />
            <Button
              size="sm"
              disabled={(params.page ?? 1) <= 1}
              onClick={() => setParam({ page: (params.page ?? 1) - 1 })}
            >
              Previous
            </Button>
            <Button
              size="sm"
              disabled={(params.page ?? 1) >= pageCount}
              onClick={() => setParam({ page: (params.page ?? 1) + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
