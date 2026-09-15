import { Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  BrainIcon,
  ChartScatterIcon,
  ClipboardCheckIcon,
  GitCompareIcon,
  LayoutDashboardIcon,
  ListIcon,
  LockIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
  WavesIcon,
  WaypointsIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ActionButton } from '@/components/action-button';
import { Skeleton } from '@/components/ui/skeleton';
import { clearToken, requireAuth } from '@/lib/auth';
import { formatCount } from '@/lib/format';
import { useServerStatus } from '@/lib/queries';
import { isDark, setDark } from '@/lib/theme';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: LayoutDashboardIcon },
  { to: '/sessions', label: 'Sessions', icon: ListIcon },
  { to: '/recall', label: 'Recall', icon: SearchIcon },
  { to: '/graph', label: 'Graph', icon: WaypointsIcon },
  { to: '/timeline', label: 'Timeline', icon: WavesIcon },
  { to: '/embeddings', label: 'Embeddings', icon: ChartScatterIcon },
  { to: '/compare', label: 'Compare', icon: GitCompareIcon },
  { to: '/eval', label: 'Eval', icon: ClipboardCheckIcon },
  { to: '/curation', label: 'Curation', icon: SparklesIcon },
  { to: '/health', label: 'Health', icon: ActivityIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

function ThemeToggle() {
  const [dark, setDarkState] = useState(isDark);

  const toggle = () => {
    setDark(!dark);
    setDarkState(!dark);
  };

  return (
    <ActionButton
      variant="ghost"
      size="icon-sm"
      label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggle}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </ActionButton>
  );
}

/** Clears the stored bearer token and brings the token gate back — for shared machines. */
function LockButton() {
  const { data } = useServerStatus();

  if (!data?.authEnabled) {
    return null;
  }

  const lock = () => {
    clearToken();
    requireAuth();
  };

  return (
    <ActionButton variant="ghost" size="icon-sm" label="Lock" hint="Forget the stored token" onClick={lock}>
      <LockIcon />
    </ActionButton>
  );
}

function HeaderStatus() {
  const { data, isPending } = useServerStatus();

  if (isPending) {
    return <Skeleton className="h-4 w-24" />;
  }
  if (!data) {
    return null;
  }
  return (
    <span className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{formatCount(data.engine.turns)}</span> turns in{' '}
      <span className="font-medium text-foreground">{formatCount(data.engine.sessions)}</span> sessions
    </span>
  );
}

function MobileNav() {
  return (
    <nav className="flex items-center gap-1 md:hidden" aria-label="Main">
      <BrainIcon className="mr-1 size-5" aria-hidden />
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          aria-label={label}
          activeOptions={{ exact: to === '/' }}
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          activeProps={{ className: 'rounded-md p-2 bg-accent text-accent-foreground' }}
        >
          <Icon className="size-4" />
        </Link>
      ))}
      <LockButton />
      <ThemeToggle />
    </nav>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2 px-4 py-4 font-semibold">
          <BrainIcon className="size-5" />
          mcp-zeromem
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === '/' }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{
                className:
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm bg-sidebar-accent text-sidebar-accent-foreground font-medium',
              }}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-end gap-1 px-4 py-3">
          <LockButton />
          <ThemeToggle />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-2 border-b px-4 md:justify-end md:px-6">
          <MobileNav />
          <HeaderStatus />
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
