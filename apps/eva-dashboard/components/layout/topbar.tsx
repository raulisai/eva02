'use client';

import { useEffect, useState } from 'react';
import { Activity, Box } from 'lucide-react';
import { LogConsole, LogsButton } from '@/components/debug/log-console';
import { useWs } from '@/hooks/use-ws';
import { cn } from '@/lib/utils';

interface TopbarProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

type CoreHealth = {
  status: 'ok' | string;
  sandbox?: 'pending' | 'ready' | 'no_docker' | 'no_enriched_image' | 'unavailable' | string;
  standby?: boolean;
};

export function Topbar({ title, subtitle, actions }: TopbarProps) {
  const { connected, events } = useWs();
  const [logsOpen, setLogsOpen] = useState(false);
  const [health, setHealth] = useState<CoreHealth | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const base = process.env.NEXT_PUBLIC_EVA_CORE_URL ?? 'http://localhost:3000';

    async function checkHealth() {
      try {
        const res = await fetch(`${base}/health`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as CoreHealth;
        if (!cancelled) {
          setHealth(body);
          setHealthError(false);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setHealthError(true);
        }
      }
    }

    void checkHealth();
    const timer = setInterval(checkHealth, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sandbox = health?.sandbox ?? (healthError ? 'offline' : 'checking');
  const coreOk = health?.status === 'ok' && !healthError;
  const sandboxOk = sandbox === 'ready';
  const sandboxWarn = sandbox === 'pending' || sandbox === 'no_enriched_image' || sandbox === 'checking';

  return (
    <>
      <header className="h-11 border-b border-zinc-800 flex items-center justify-between px-5 flex-shrink-0 bg-zinc-950/80 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="flex-shrink-0 text-sm font-semibold text-zinc-100">{title}</h1>
          {subtitle && <span className="truncate text-xs text-zinc-600 font-mono">{subtitle}</span>}
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 sm:flex">
            <div className="flex items-center gap-1.5" title={coreOk ? 'eva-core healthy' : 'eva-core unavailable'}>
              <Activity className={cn('h-3.5 w-3.5', coreOk ? 'text-emerald-400' : 'text-red-400')} />
              <span className="text-[10px] font-mono text-zinc-600">core</span>
            </div>
            <div className="flex items-center gap-1.5" title={`sandbox: ${sandbox}`}>
              <Box className={cn(
                'h-3.5 w-3.5',
                sandboxOk ? 'text-emerald-400' : sandboxWarn ? 'text-amber-400' : 'text-red-400',
              )} />
              <span className="text-[10px] font-mono text-zinc-600">{sandbox}</span>
            </div>
          </div>

          {/* Event counter */}
          {events.length > 0 && (
            <span className="hidden text-[10px] font-mono text-zinc-600 sm:inline">
              {events.length} events
            </span>
          )}

          <LogsButton count={events.length} onClick={() => setLogsOpen(true)} />

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
      {logsOpen && <LogConsole onClose={() => setLogsOpen(false)} />}
    </>
  );
}
