import type { ContextSegment, NormalizedUsage } from '@contextscope/shared';
import { formatTokens, kindLabel } from '../lib/format';
import { kindColor, layoutStrip, layoutUsage, usageColor } from '../lib/strip';
import { cn } from '../lib/utils';
import { Tooltip } from './ui/tooltip';

type StripSegment = Pick<
  ContextSegment,
  'index' | 'kind' | 'label' | 'estimatedTokens' | 'tokenSource' | 'byteLength' | 'cacheControl'
>;

/**
 * The context strip: estimated structure of the request context in cache order,
 * with a marker at the shared-prefix boundary. Estimated parts are hatched.
 */
export const ContextStrip = ({
  segments,
  sharedSegments = null,
  highlightIndex = null,
  onSelect,
  height = 22,
  mini = false,
  title = 'Context structure (estimated tokens, cache order)',
}: {
  segments: StripSegment[];
  sharedSegments?: number | null;
  highlightIndex?: number | null;
  onSelect?: (index: number) => void;
  height?: number;
  mini?: boolean;
  title?: string;
}) => {
  const layout = layoutStrip(segments, sharedSegments);
  if (segments.length === 0) {
    return <div className="text-[12px] text-muted">No context segments recorded.</div>;
  }
  return (
    <figure className="min-w-0" aria-label={title}>
      <div
        className="relative flex w-full overflow-hidden rounded-[4px] border border-border bg-raised"
        style={{ height }}
        role="img"
        aria-label={`${title}: ${segments.length} segments${layout.boundaryPct !== null ? `, shared prefix ${Math.round(layout.boundaryPct)}%` : ''}`}
      >
        {layout.parts.map((p) => {
          const partProps = {
            'aria-label': `${kindLabel(p.kind)} ${p.label}: ${p.tokens === null ? 'tokens unknown' : `${formatTokens(p.tokens)} tokens`}`,
            className: cn(
              'block h-full shrink-0 border-r border-bg/60 last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              p.estimated && 'hatch',
              highlightIndex === p.index && 'outline-2 -outline-offset-2 outline-cache-write',
              onSelect ? 'cursor-pointer hover:brightness-110' : 'cursor-default',
            ),
            style: { width: `${p.pct}%`, backgroundColor: kindColor(p.kind), minWidth: 2 },
          };
          // Only a strip with an action renders buttons; otherwise segments are focusable
          // tooltips, so nothing looks clickable that does nothing.
          const body = onSelect ? (
            <button type="button" tabIndex={mini ? -1 : 0} onClick={() => onSelect(p.index)} {...partProps} />
          ) : (
            <span role="img" tabIndex={mini ? -1 : 0} {...partProps} />
          );
          if (mini) return <span key={p.index} className="contents">{body}</span>;
          return (
            <Tooltip
              key={p.index}
              content={
                <span>
                  <span className="font-medium">{p.label}</span>
                  <span className="text-muted"> · {kindLabel(p.kind)}</span>
                  <br />
                  <span className="num">{p.tokens === null ? '—' : formatTokens(p.tokens)}</span> tokens
                  {p.estimated ? ' (est.)' : ''} · <span className="num">{p.pct.toFixed(1)}%</span>
                  {p.cacheControl ? (
                    <>
                      <br />
                      cache_control: <span className="num">{p.cacheControl}</span>
                    </>
                  ) : null}
                </span>
              }
            >
              {body}
            </Tooltip>
          );
        })}
        {layout.parts
          .filter((p) => p.cacheControl)
          .map((p) => (
            <span
              key={`cc-${p.index}`}
              aria-hidden
              className="pointer-events-none absolute top-0 h-1.5 w-1.5 -translate-x-1/2 bg-cache-write"
              style={{ left: `${p.left + p.pct}%`, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}
            />
          ))}
        {layout.boundaryPct !== null ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-fg"
            style={{ left: `calc(${layout.boundaryPct}% - 1px)` }}
          />
        ) : null}
      </div>
      {!mini && layout.boundaryPct !== null ? (
        <figcaption className="relative mt-1 h-4 overflow-hidden text-[11px] text-muted">
          <span
            className="absolute truncate whitespace-nowrap"
            title="Identical to previous request up to here"
            style={
              layout.boundaryPct > 50
                ? { right: `${100 - layout.boundaryPct}%`, maxWidth: `${layout.boundaryPct}%` }
                : { left: `${layout.boundaryPct}%`, maxWidth: `${100 - layout.boundaryPct}%` }
            }
          >
            {layout.boundaryPct > 50 ? 'identical to previous request up to here ▏' : '▏identical to previous request up to here'}
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
};

/** Provider-reported usage bar, drawn directly under the strip and visibly different (solid, no hatch). */
export const UsageBar = ({
  usage,
  height = 10,
  mini = false,
}: {
  usage: Pick<
    NormalizedUsage,
    'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'totalInputTokens'
  >;
  height?: number;
  mini?: boolean;
}) => {
  const layout = layoutUsage(usage);
  if (!layout) {
    return (
      <div className="text-[11px] text-muted" title="Not reported by the provider">
        Reported usage: — (not reported by the provider)
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div
        className="flex w-full overflow-hidden rounded-[3px]"
        style={{ height }}
        role="img"
        aria-label={`Reported usage: ${layout.parts.map((p) => `${p.label} ${formatTokens(p.tokens)}`).join(', ')}`}
      >
        {layout.parts.map((p) => (
          <span
            key={p.key}
            className="h-full"
            style={{ width: `${p.pct}%`, backgroundColor: usageColor[p.key] }}
            title={`${p.label}: ${formatTokens(p.tokens)} tokens (reported)`}
          />
        ))}
      </div>
      {!mini ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {layout.parts.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1">
              <span className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: usageColor[p.key] }} />
              {p.label} <span className="num text-fg">{formatTokens(p.tokens)}</span>
            </span>
          ))}
          <span>reported by provider</span>
        </div>
      ) : null}
    </div>
  );
};

export const StripLegend = () => {
  const kinds = ['tool_definition', 'system', 'developer', 'user', 'assistant', 'tool_call', 'tool_result', 'document'];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: kindColor(k) }} />
          {kindLabel(k)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="hatch inline-block size-2 rounded-[2px] bg-[var(--k-other)]" /> estimated
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-0.5 bg-fg" /> shared-prefix boundary
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block size-2 bg-cache-write"
          style={{ clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}
        />{' '}
        cache_control
      </span>
    </div>
  );
};
