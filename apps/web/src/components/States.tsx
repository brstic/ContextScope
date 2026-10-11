import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

export const PROXY_URLS = [
  { label: 'OpenAI-compatible', url: 'http://127.0.0.1:3377/openai/v1' },
  { label: 'Anthropic', url: 'http://127.0.0.1:3377/anthropic' },
  { label: 'Gemini', url: 'http://127.0.0.1:3377/gemini' },
];

export const ErrorState = ({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) => {
  const msg =
    error instanceof ApiError
      ? `${error.message}${error.code && !error.message.includes(error.code) ? ` (${error.code})` : ''}`
      : error instanceof Error
        ? error.message
        : 'Something went wrong.';
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-[6px] border border-error/40 bg-error/5 p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-error">
        <AlertTriangle className="size-4" aria-hidden />
        {title ?? 'Could not load data'}
      </div>
      <p className="text-[12px] text-muted">{msg}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RotateCw aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
};

/** Empty state that tells the user how to get data in. */
export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex flex-col gap-3 p-4 text-[13px]">
    <div>
      <p className="font-medium text-fg">{title}</p>
      {children ? <div className="mt-1 text-muted">{children}</div> : null}
    </div>
  </div>
);

export const GetStarted = ({ title = 'No requests captured yet' }: { title?: string }) => (
  <EmptyState title={title}>
    <p>Point your SDK's base URL at the ContextScope proxy, then send a request:</p>
    <ul className="mt-2 space-y-1">
      {PROXY_URLS.map((p) => (
        <li key={p.url} className="flex flex-wrap items-baseline gap-2">
          <span className="w-36 shrink-0 text-muted">{p.label}</span>
          <code className="num break-all rounded-[4px] bg-raised px-1.5 py-0.5 text-fg">{p.url}</code>
        </li>
      ))}
    </ul>
    <p className="mt-2">
      Or explore with synthetic traces:{' '}
      <code className="num rounded-[4px] bg-raised px-1.5 py-0.5 text-fg">contextscope demo</code>
    </p>
  </EmptyState>
);

export const LoadingBlock = ({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) => (
  <div className="space-y-2 p-3" role="status" aria-label={label}>
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className="h-5" style={{ width: `${90 - ((i * 13) % 40)}%` }} />
    ))}
  </div>
);
