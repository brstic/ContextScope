import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Database,
  DollarSign,
  GitCompare,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { Suspense, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { LoadingBlock } from './States';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Tooltip } from './ui/tooltip';

export const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/requests', label: 'Live Requests', icon: Activity },
  { to: '/sessions', label: 'Sessions', icon: Users },
  { to: '/context', label: 'Context Explorer', icon: Layers },
  { to: '/cache', label: 'Cache Analyzer', icon: Database },
  { to: '/costs', label: 'Cost Analytics', icon: DollarSign },
  { to: '/optimizations', label: 'Optimizations', icon: Lightbulb },
  { to: '/compare', label: 'Compare', icon: GitCompare },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

const COLLAPSE_KEY = 'cs.sidebar';

const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

const Logo = ({ compact }: { compact?: boolean }) => (
  <span className="flex items-center gap-2 text-[14px] font-semibold text-fg">
    <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden className="shrink-0">
      <rect x="0" y="2" width="6" height="8" fill="var(--uncached)" />
      <rect x="6" y="2" width="7" height="8" fill="var(--cache-read)" />
      <rect x="13" y="2" width="5" height="8" fill="var(--output)" />
      <rect x="9" y="0" width="1" height="12" fill="var(--text)" />
    </svg>
    {compact ? null : <span>ContextScope</span>}
  </span>
);

const NavItems = ({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) => (
  <nav aria-label="Main" className="flex flex-col gap-0.5">
    {NAV.map(({ to, label, icon: Icon, ...rest }) => {
      const link = (
        <NavLink
          key={to}
          to={to}
          end={'end' in rest ? rest.end : false}
          onClick={onNavigate}
          aria-label={collapsed ? label : undefined}
          className={({ isActive }) =>
            cn(
              'flex h-8 items-center gap-2.5 rounded-[4px] px-2 text-[13px] text-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-ring',
              isActive && 'bg-raised text-fg',
              collapsed && 'justify-center px-0',
            )
          }
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {collapsed ? null : <span className="truncate">{label}</span>}
        </NavLink>
      );
      return collapsed ? (
        <Tooltip key={to} content={label} side="right">
          {link}
        </Tooltip>
      ) : (
        link
      );
    })}
  </nav>
);

const LiveIndicator = () => {
  const { status, paused, setPaused, queueDepth, dropped } = useLive();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 15_000,
  });
  const depth = queueDepth ?? health.data?.queue.depth ?? null;
  const drop = dropped ?? health.data?.queue.dropped ?? null;
  const label = paused
    ? 'Paused'
    : status === 'connected'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting'
        : 'Reconnecting';
  const color = paused ? 'var(--muted)' : status === 'connected' ? 'var(--success)' : 'var(--cache-write)';
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px]">
      <span className="inline-flex items-center gap-1.5" role="status" aria-live="polite">
        <span
          className={cn('inline-block size-2 rounded-full', status === 'connected' && !paused && 'cs-pulse')}
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="text-fg">{label}</span>
      </span>
      <Tooltip content={paused ? 'Resume live updates' : 'Pause live updates'}>
        <Button
          variant="ghost"
          size="iconSm"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? 'Resume live updates' : 'Pause live updates'}
        >
          {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        </Button>
      </Tooltip>
      <span className="hidden text-muted md:inline" title="Persistence queue depth / dropped events">
        queue <span className="num text-fg">{depth ?? '—'}</span>
        {' · '}dropped <span className={cn('num', drop ? 'text-error' : 'text-fg')}>{drop ?? '—'}</span>
      </span>
    </div>
  );
};

const ThemeToggle = () => {
  const [theme, , toggle] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip content={`Switch to ${next} theme`}>
      <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Switch to ${next} theme`}>
        {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </Button>
    </Tooltip>
  );
};

const DemoBadge = () => {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 15_000,
  });
  if (!health.data?.demo) return null;
  return (
    <Tooltip content="Synthetic traces generated by `contextscope demo`. Not real traffic.">
      <Badge tone="write" tabIndex={0}>
        Demo data
      </Badge>
    </Tooltip>
  );
};

export const Layout = ({ children }: { children?: ReactNode }) => {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  return (
    <div className="flex min-h-screen w-full bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-[4px] focus:bg-panel focus:px-2 focus:py-1"
      >
        Skip to content
      </a>
      {/* Outer column stretches with the page (background + border); the inner nav stays sticky. */}
      <div
        className={cn(
          'hidden shrink-0 border-r border-border bg-panel md:block',
          collapsed ? 'w-12' : 'w-52',
        )}
      >
        <aside className="sticky top-0 flex h-screen flex-col">
          <div
            className={cn(
              'flex h-11 items-center border-b border-border',
              collapsed ? 'justify-center' : 'px-3',
            )}
          >
            <Logo compact={collapsed} />
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            <NavItems collapsed={collapsed} />
          </div>
          <div className={cn('border-t border-border p-1.5', collapsed && 'flex justify-center')}>
            <Button
              variant="ghost"
              size={collapsed ? 'icon' : 'sm'}
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={collapsed ? '' : 'w-full justify-start'}
            >
              {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
              {collapsed ? null : 'Collapse'}
            </Button>
          </div>
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-border bg-bg/95 px-3 backdrop-blur-sm md:px-4">
          <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open menu"
              onClick={() => setMenuOpen(true)}
            >
              <Menu aria-hidden />
            </Button>
            <DialogContent side="left" aria-describedby={undefined}>
              <DialogTitle className="mb-3">
                <Logo />
              </DialogTitle>
              <NavItems collapsed={false} onNavigate={() => setMenuOpen(false)} />
            </DialogContent>
          </Dialog>
          <span className="md:hidden">
            <Logo compact />
          </span>
          <LiveIndicator />
          <div className="ml-auto flex items-center gap-2">
            <DemoBadge />
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 p-3 md:p-4">
          <Suspense fallback={<LoadingBlock rows={6} label="Loading page" />}>
            {children ?? <Outlet />}
          </Suspense>
        </main>
      </div>
    </div>
  );
};

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
    <div className="min-w-0">
      <h1 className="text-[18px] font-semibold leading-6">{title}</h1>
      {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
  </div>
);
