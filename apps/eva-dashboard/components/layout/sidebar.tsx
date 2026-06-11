'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ListTodo, Server, Zap, FileText, ShieldCheck, LogOut, Terminal,
  FlaskConical, Puzzle, Plug, Package, Sparkles, KeyRound, MessageSquare, Fingerprint, Clock, Coins,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { useWs } from '@/hooks/use-ws';

const NAV_GROUPS = [
  {
    label: 'Operations',
    items: [
      { href: '/tasks',     label: 'Tasks',     icon: ListTodo },
      { href: '/nodes',     label: 'Nodes',     icon: Server },
      { href: '/events',    label: 'Events',    icon: Zap },
      { href: '/logs',      label: 'Logs',      icon: FileText },
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck },
      { href: '/jobs',      label: 'Jobs',      icon: Clock },
      { href: '/billing',   label: 'Billing',   icon: Coins },
    ],
  },
  {
    label: 'Agent',
    items: [
      { href: '/playground', label: 'Playground', icon: FlaskConical },
      { href: '/skills',     label: 'Skills',     icon: Puzzle },
      { href: '/mcp',        label: 'MCP',        icon: Plug },
      { href: '/artifacts',  label: 'Artifacts',  icon: Package },
      { href: '/soul',       label: 'Soul',       icon: Sparkles },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings/models',      label: 'Models',      icon: KeyRound },
      { href: '/settings/channels',    label: 'Channels',    icon: MessageSquare },
      { href: '/settings/credentials', label: 'Credentials', icon: Fingerprint },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { connected } = useWs();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  return (
    <aside className="w-52 flex-shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
            <Terminal className="w-3 h-3 text-cyan-400" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-wide text-zinc-100">EVA</p>
            <p className="text-[10px] text-zinc-600 font-mono">v0.1.0</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 px-2 space-y-3 overflow-y-auto" role="navigation">
        {NAV_GROUPS.map(({ label: groupLabel, items }) => (
          <div key={groupLabel} className="space-y-0.5">
            <p className="px-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-zinc-700">
              {groupLabel}
            </p>
            {items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 rounded-sm text-xs font-medium transition-all',
                    active
                      ? 'bg-zinc-800/80 text-zinc-100 border-l-2 border-l-cyan-500'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40 border-l-2 border-l-transparent',
                  )}
                >
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-zinc-800 space-y-2">
        {/* WS connection */}
        <div className="flex items-center gap-2">
          <span className={cn('led', connected ? 'led-running' : 'led-failed')} />
          <span className="text-[10px] font-mono text-zinc-600">
            {connected ? 'CORE LIVE' : 'CORE OFFLINE'}
          </span>
        </div>

        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 text-xs text-zinc-600 hover:text-zinc-300 transition-colors w-full"
        >
          <LogOut className="w-3 h-3" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
