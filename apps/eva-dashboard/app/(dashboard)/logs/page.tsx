'use client';

import { useState } from 'react';
import { useWs } from '@/hooks/use-ws';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Topbar } from '@/components/layout/topbar';

type LogLevel = 'all' | 'info' | 'warn' | 'error';

const LEVEL_MAP: Record<string, LogLevel> = {
  'task.failed':    'error',
  'task.created':   'info',
  'task.started':   'info',
  'task.completed': 'info',
  'task.cancelled': 'warn',
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  all:   'text-zinc-400',
  info:  'text-blue-400',
  warn:  'text-amber-400',
  error: 'text-red-400',
};

export default function LogsPage() {
  const { events } = useWs();
  const [level, setLevel] = useState<LogLevel>('all');
  const [search, setSearch] = useState('');

  const logs = events
    .map(ev => ({
      ts: ev.ts,
      level: LEVEL_MAP[ev.type] ?? 'info',
      message: `[${ev.type}]${ev.taskId ? ` task=${ev.taskId.slice(0, 8)}` : ''} ${JSON.stringify(ev.payload)}`,
    }))
    .filter(l => level === 'all' || l.level === level)
    .filter(l => !search || l.message.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <Topbar title="Logs" subtitle="real-time · from WebSocket" />

      {/* Filter bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 flex-shrink-0 bg-zinc-950">
        {(['all', 'info', 'warn', 'error'] as LogLevel[]).map(l => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={`text-[10px] font-mono uppercase px-2 py-1 rounded-sm transition-colors ${level === l ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-600 hover:text-zinc-300'}`}
          >
            {l}
          </button>
        ))}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="filter…"
          className="ml-auto bg-zinc-900 border border-zinc-800 rounded-sm px-3 py-1 text-xs font-mono text-zinc-300 placeholder-zinc-700 focus:outline-none focus:border-zinc-600 w-48"
        />
      </div>

      {/* Terminal output */}
      <ScrollArea className="flex-1 bg-zinc-950">
        <div className="p-4 font-mono space-y-0.5">
          {logs.length === 0 && (
            <span className="text-zinc-700 text-xs">No logs match filter. Waiting for events…</span>
          )}
          {logs.map((log, i) => (
            <div key={i} className="flex gap-3 text-xs hover:bg-zinc-900/50 px-1 rounded transition-colors">
              <span className="text-zinc-700 tabular-nums flex-shrink-0 w-24">
                {new Date(log.ts).toLocaleTimeString()}
              </span>
              <span className={`uppercase flex-shrink-0 w-8 ${LEVEL_COLOR[log.level]}`}>
                {log.level.slice(0, 4)}
              </span>
              <span className="text-zinc-300 break-all">{log.message}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </>
  );
}
