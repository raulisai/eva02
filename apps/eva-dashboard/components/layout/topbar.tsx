'use client';

import { useWs } from '@/hooks/use-ws';
import { cn } from '@/lib/utils';

interface TopbarProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function Topbar({ title, subtitle, actions }: TopbarProps) {
  const { connected, events } = useWs();

  return (
    <header className="h-11 border-b border-zinc-800 flex items-center justify-between px-5 flex-shrink-0 bg-zinc-950/80 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-zinc-100">{title}</h1>
        {subtitle && <span className="text-xs text-zinc-600 font-mono">{subtitle}</span>}
      </div>

      <div className="flex items-center gap-4">
        {/* Event counter */}
        {events.length > 0 && (
          <span className="text-[10px] font-mono text-zinc-600">
            {events.length} events
          </span>
        )}

        {/* WS status */}
        <div className="flex items-center gap-1.5">
          <span className={cn('led flex-shrink-0', connected ? 'led-running' : 'led-failed')} />
          <span className="text-[10px] font-mono text-zinc-600 hidden sm:inline">
            {connected ? 'live' : 'disconnected'}
          </span>
        </div>

        {actions}
      </div>
    </header>
  );
}
