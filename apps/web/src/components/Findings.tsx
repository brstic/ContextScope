import type { Finding, Severity } from '@contextscope/shared';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { findingTypeLabel, formatTokens, shortId } from '../lib/format';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

export const severityTone = (s: Severity) =>
  s === 'high' ? 'error' : s === 'medium' ? 'write' : s === 'low' ? 'uncached' : ('neutral' as const);

export const SeverityBadge = ({ severity }: { severity: Severity }) => (
  <Badge tone={severityTone(severity)} className="capitalize">
    {severity}
  </Badge>
);

export const FindingRow = ({ finding, defaultOpen = false }: { finding: Finding; defaultOpen?: boolean }) => {
  const [open, setOpen] = useState(defaultOpen);
  const id = `finding-${finding.id}`;
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={finding.severity} />
            <span className="font-medium text-fg">{finding.title}</span>
          </span>
          <span className="mt-0.5 block text-[12px] text-muted">
            {findingTypeLabel(finding.type)} · affects {finding.affects.replace('_', ' ')} · {finding.confidence}{' '}
            confidence
            {finding.estimatedTokenReduction !== null ? (
              <>
                {' '}
                · <span className="num">−{formatTokens(finding.estimatedTokenReduction)}</span> tokens est.
              </>
            ) : null}
          </span>
        </span>
      </button>
      {open ? (
        <div id={id} className="space-y-2.5 px-3 pb-3 pl-8 text-[12px]">
          <p className="text-fg">{finding.description}</p>
          {finding.evidence.length ? (
            <div>
              <div className="font-medium text-muted">Evidence</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {finding.evidence.map((e, i) => (
                  <li key={i} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <div className="font-medium text-muted">Recommendation</div>
              <p className="mt-0.5">{finding.recommendation}</p>
            </div>
            <div>
              <div className="font-medium text-muted">Trade-off</div>
              <p className="mt-0.5">{finding.tradeoff}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
            <span>
              Confidence: <span className="text-fg">{finding.confidence}</span>
            </span>
            <span>
              Est. token reduction:{' '}
              {finding.estimatedTokenReduction !== null ? (
                <span className="num text-fg">{formatTokens(finding.estimatedTokenReduction)} (estimated)</span>
              ) : (
                <span title="No defensible estimate">—</span>
              )}
            </span>
            {finding.docsUrl ? (
              <a
                href={finding.docsUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-uncached hover:underline"
              >
                Provider docs <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
          </div>
          {finding.requestIds.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted">Affected requests:</span>
              {finding.requestIds.slice(0, 12).map((r) => (
                <Link
                  key={r}
                  to={`/requests/${encodeURIComponent(r)}`}
                  className="num rounded-[4px] border border-border px-1 hover:bg-raised"
                >
                  {shortId(r)}
                </Link>
              ))}
              {finding.requestIds.length > 12 ? (
                <span className="text-muted">+{finding.requestIds.length - 12} more</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};

export const FindingList = ({ findings, empty }: { findings: Finding[]; empty?: string }) =>
  findings.length === 0 ? (
    <p className="p-3 text-[12px] text-muted">{empty ?? 'No findings.'}</p>
  ) : (
    <ul>
      {findings.map((f) => (
        <FindingRow key={f.id} finding={f} />
      ))}
    </ul>
  );
