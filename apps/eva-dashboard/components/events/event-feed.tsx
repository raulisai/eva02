'use client';

import { useWs } from '@/hooks/use-ws';
import { ScrollArea } from '@/components/ui/scroll-area';
import { shortId } from '@/lib/utils';

const EVENT_COLOR: Record<string, string> = {
  'task.created':   'text-blue-400',
  'task.started':   'text-cyan-400',
  'task.completed': 'text-emerald-400',
  'task.failed':    'text-red-400',
  'task.cancelled': 'text-zinc-500',
};

function EventRow({ type, taskId, payload, ts }: {
  type: string; taskId?: string; payload: Record<string, unknown>; ts: number;
}) {
  const color = EVENT_COLOR[type] ?? 'text-zinc-400';
  return (
    <div className="event-new grid grid-cols-[90px_180px_120px_1fr] gap-2 px-4 py-2 border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
      <span className="font-mono text-[10px] text-zinc-600 tabular-nums">
        {new Date(ts).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
      <span className={`font-mono text-xs ${color}`}>{type}</span>
      <span className="font-mono text-[10px] text-zinc-500">{taskId ? shortId(taskId) : '—'}</span>
      <span className="font-mono text-[10px] text-zinc-600 truncate">
        {JSON.stringify(payload)}
      </span>
    </div>
  );
}

export function EventFeed({ limit = 200 }: { limit?: number }) {
  const { events, connected } = useWs();
  const visible = events.slice(0, limit);

  return (
    <div className="h-full flex flex-col">
      {/* Column headers */}
      <div className="grid grid-cols-[90px_180px_120px_1fr] gap-2 px-4 py-2 border-b border-zinc-800 flex-shrink-0">
        {['TIME', 'EVENT', 'TASK ID', 'PAYLOAD'].map(h => (
          <span key={h} className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">{h}</span>
        ))}
      </div>

      <ScrollArea className="flex-1">
        {!connected && visible.length === 0 && (
          <div className="flex items-center justify-center h-32 text-zinc-700 font-mono text-xs">
            Waiting for Core connection…
          </div>
        )}
        {connected && visible.length === 0 && (
          <div className="flex items-center justify-center h-32 text-zinc-700 font-mono text-xs">
            Stream live — no events yet
          </div>
        )}
        {visible.map((ev, i) => (
          <EventRow
            key={`${ev.ts}-${i}`}
            type={ev.type}
            taskId={ev.taskId}
            payload={ev.payload}
            ts={ev.ts}
          />
        ))}
      </ScrollArea>

      <div className="px-4 py-2 border-t border-zinc-800 flex-shrink-0 flex items-center gap-2">
        <span className={`led ${connected ? 'led-running' : 'led-failed'}`} />
        <span className="text-[10px] font-mono text-zinc-600">
          {connected ? `${visible.length} events buffered` : 'disconnected'}
        </span>
      </div>
    </div>
  );
}
