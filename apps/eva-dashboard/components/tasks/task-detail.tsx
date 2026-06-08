'use client';

import { useTaskEvents, useLiveStatus } from '@/hooks/use-ws';
import { StatusBadge } from './status-badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { shortId, age } from '@/lib/utils';
import type { Task } from '@/lib/types';

interface TaskDetailProps {
  task: Task;
}

export function TaskDetail({ task }: TaskDetailProps) {
  const liveStatus = useLiveStatus(task.id) ?? task.status;
  const taskEvents = useTaskEvents(task.id);

  return (
    <div className="grid grid-rows-[auto_1fr] h-full gap-0">
      {/* Header */}
      <div className="panel m-4 p-4 flex-shrink-0">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <p className="font-mono text-[10px] text-zinc-600 mb-1">{task.id}</p>
            <h2 className="text-base font-semibold text-zinc-100">{task.title}</h2>
            {task.description && (
              <p className="text-sm text-zinc-400 mt-1">{task.description}</p>
            )}
          </div>
          <StatusBadge status={liveStatus} />
        </div>

        <div className="grid grid-cols-3 gap-4 pt-3 border-t border-zinc-800">
          {[
            { label: 'Created',   value: new Date(task.created_at).toLocaleString() },
            { label: 'Started',   value: task.started_at ? new Date(task.started_at).toLocaleString() : '—' },
            { label: 'Age',       value: age(task.created_at) },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">{label}</p>
              <p className="text-xs font-mono text-zinc-300 mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Body: metadata + event stream */}
      <div className="grid grid-cols-2 gap-4 px-4 pb-4 min-h-0">
        {/* Metadata / result */}
        <div className="panel flex flex-col min-h-0">
          <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest px-3 py-2 border-b border-zinc-800 flex-shrink-0">
            Metadata
          </p>
          <ScrollArea className="flex-1 p-3">
            <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-all">
              {JSON.stringify(task.metadata, null, 2)}
            </pre>
            {task.result && (
              <>
                <p className="text-[10px] font-mono text-emerald-600 mt-4 mb-1 uppercase tracking-widest">Result</p>
                <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap break-all">
                  {JSON.stringify(task.result, null, 2)}
                </pre>
              </>
            )}
            {task.error && (
              <>
                <p className="text-[10px] font-mono text-red-600 mt-4 mb-1 uppercase tracking-widest">Error</p>
                <pre className="text-xs font-mono text-red-400 whitespace-pre-wrap break-all">
                  {task.error}
                </pre>
              </>
            )}
          </ScrollArea>
        </div>

        {/* Live event log for this task */}
        <div className="panel flex flex-col min-h-0">
          <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest px-3 py-2 border-b border-zinc-800 flex-shrink-0">
            Live events
            {taskEvents.length > 0 && (
              <span className="ml-2 text-cyan-500">{taskEvents.length}</span>
            )}
          </p>
          <ScrollArea className="flex-1 p-3">
            {taskEvents.length === 0 ? (
              <p className="text-xs text-zinc-700 font-mono">Waiting for events…</p>
            ) : (
              <div className="space-y-2">
                {taskEvents.map((ev, i) => (
                  <div key={i} className="event-new">
                    <p className="font-mono text-[10px] text-zinc-600">
                      {new Date(ev.ts).toLocaleTimeString()}
                    </p>
                    <p className="font-mono text-xs text-cyan-400">{ev.type}</p>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
