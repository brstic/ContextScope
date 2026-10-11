import type { ContextSegment } from '@contextscope/shared';
import { Copy, Repeat } from 'lucide-react';
import { formatBytes, kindLabel, shortFingerprint } from '../lib/format';
import { kindColor } from '../lib/strip';
import { cn } from '../lib/utils';
import { Num } from './Num';
import { Badge } from './ui/badge';
import { Table, TBody, Td, Th, THead, Tr } from './ui/table';

/** Segments table used by the inspector Context tab. */
export const SegmentTable = ({
  segments,
  sharedSegments = null,
  highlight = null,
  onSelect,
}: {
  segments: ContextSegment[];
  sharedSegments?: number | null;
  highlight?: number | null;
  onSelect?: (index: number) => void;
}) => {
  const total = segments.reduce((a, s) => a + (s.estimatedTokens ?? 0), 0);
  return (
    <Table aria-label="Context segments">
      <THead>
        <Tr>
          <Th className="w-8">#</Th>
          <Th>Kind</Th>
          <Th>Label</Th>
          <Th className="text-right">Est. tokens</Th>
          <Th className="text-right">%</Th>
          <Th className="text-right">Bytes</Th>
          <Th>Fingerprint</Th>
          <Th>Signals</Th>
        </Tr>
      </THead>
      <TBody>
        {segments.map((s) => {
          const shared = sharedSegments !== null && s.index < sharedSegments;
          return (
            <Tr
              key={s.index}
              id={`seg-${s.index}`}
              onClick={onSelect ? () => onSelect(s.index) : undefined}
              className={cn(
                onSelect && 'cursor-pointer',
                'hover:bg-raised',
                highlight === s.index && 'cs-flash bg-raised',
                sharedSegments !== null && s.index === sharedSegments && 'border-t-2 border-t-fg',
              )}
            >
              <Td className="num text-muted">{s.index}</Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: kindColor(s.kind) }} />
                  {kindLabel(s.kind)}
                  {s.role && s.role !== s.kind ? <span className="text-muted">({s.role})</span> : null}
                </span>
              </Td>
              <Td className="max-w-[260px] truncate" title={`${s.label} — ${s.path}`}>
                {s.label}
              </Td>
              <Td className="text-right">
                <Num
                  value={s.estimatedTokens}
                  estimated={s.tokenSource === 'estimated'}
                  hint={s.multimodal ? 'Multimodal content: token estimate not meaningful' : 'Could not be estimated'}
                />
              </Td>
              <Td className="num text-right text-muted">
                {s.estimatedTokens !== null && total > 0 ? `${((s.estimatedTokens / total) * 100).toFixed(1)}` : '—'}
              </Td>
              <Td className="num text-right text-muted">{formatBytes(s.byteLength)}</Td>
              <Td>
                <span className="num text-muted" title={`exact ${s.exactFingerprint}\nnormalized ${s.normalizedFingerprint}`}>
                  {shortFingerprint(s.exactFingerprint)}
                </span>
              </Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  {shared ? <Badge tone="read">shared prefix</Badge> : null}
                  {sharedSegments !== null && s.index === sharedSegments ? <Badge tone="write">first change</Badge> : null}
                  {s.cacheControl ? <Badge tone="write">cache_control: {s.cacheControl}</Badge> : null}
                  {s.duplicateCountInRequest > 0 ? (
                    <Badge tone="output" title="Same normalized content appears elsewhere in this request">
                      <Copy className="size-3" aria-hidden /> dup ×{s.duplicateCountInRequest}
                    </Badge>
                  ) : null}
                  {s.seenInRequests ? (
                    <Badge tone="neutral" title="Earlier captured requests containing this exact content">
                      <Repeat className="size-3" aria-hidden /> seen in {s.seenInRequests}
                    </Badge>
                  ) : null}
                  {s.multimodal ? <Badge>multimodal</Badge> : null}
                </span>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
};
