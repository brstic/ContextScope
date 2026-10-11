import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoadingBlock } from './components/States';
import { Button } from './components/ui/button';
import { Panel } from './components/ui/panel';
import { TooltipProvider } from './components/ui/tooltip';
import { ApiError, BASE_PATH, getToken, onUnauthorized, setToken } from './lib/api';
import { LiveProvider } from './lib/live';

const OverviewPage = lazy(() => import('./pages/Overview'));
const RequestsPage = lazy(() => import('./pages/Requests'));
const RequestInspectorPage = lazy(() => import('./pages/RequestInspector'));
const SessionsPage = lazy(() => import('./pages/Sessions'));
const SessionDetailPage = lazy(() => import('./pages/SessionDetail'));
const ContextExplorerPage = lazy(() => import('./pages/ContextExplorer'));
const CachePage = lazy(() => import('./pages/Cache'));
const CostsPage = lazy(() => import('./pages/Costs'));
const OptimizationsPage = lazy(() => import('./pages/Optimizations'));
const ComparePage = lazy(() => import('./pages/Compare'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const NotFoundPage = lazy(() => import('./pages/NotFound'));

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });

const TokenScreen = ({ onSubmit }: { onSubmit: (t: string) => void }) => {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4 text-fg">
      <Panel className="w-full max-w-sm p-4">
        <h1 className="text-[16px] font-semibold">Access token required</h1>
        <p className="mt-1 text-[13px] text-muted">
          This ContextScope server is bound to a non-loopback address and requires the token from its config
          (<code className="num">authToken</code> / <code className="num">CONTEXTSCOPE_AUTH_TOKEN</code>). The
          token is kept in this browser's local storage.
        </p>
        <form onSubmit={submit} className="mt-3 space-y-2">
          <label htmlFor="cs-token" className="block text-[12px] text-muted">
            Token
          </label>
          <input
            id="cs-token"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="num h-8 w-full rounded-[4px] border border-border bg-bg px-2 text-[13px]"
          />
          <Button type="submit" variant="default" className="w-full">
            Unlock dashboard
          </Button>
        </form>
      </Panel>
    </div>
  );
};

const AuthGate = ({ children, client }: { children: ReactNode; client: QueryClient }) => {
  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => onUnauthorized(() => setNeedsToken(true)), []);
  if (needsToken) {
    return (
      <TokenScreen
        onSubmit={(t) => {
          setToken(t);
          setNeedsToken(false);
          void client.resetQueries();
        }}
      />
    );
  }
  // key on token so the live stream reconnects with the new credential
  return <LiveProvider key={getToken() ?? 'anon'}>{children}</LiveProvider>;
};

export const AppRoutes = () => (
  <Routes>
    <Route element={<Layout />}>
      <Route index element={<OverviewPage />} />
      <Route path="requests" element={<RequestsPage />} />
      <Route path="requests/:id" element={<RequestInspectorPage />} />
      <Route path="sessions" element={<SessionsPage />} />
      <Route path="sessions/:id" element={<SessionDetailPage />} />
      <Route path="context" element={<ContextExplorerPage />} />
      <Route path="cache" element={<CachePage />} />
      <Route path="costs" element={<CostsPage />} />
      <Route path="optimizations" element={<OptimizationsPage />} />
      <Route path="compare" element={<ComparePage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes>
);

export const App = () => {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={250}>
        <BrowserRouter basename={BASE_PATH || undefined}>
          <AuthGate client={client}>
            <Suspense fallback={<LoadingBlock rows={6} />}>
              <AppRoutes />
            </Suspense>
          </AuthGate>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};
