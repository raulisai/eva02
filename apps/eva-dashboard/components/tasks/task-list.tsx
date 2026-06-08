'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useWs } from '@/hooks/use-ws';
import { StatusBadge, StatusDot } from './status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatCard } from '@/components/shared/stat-card';
import { shortId, age } from '@/lib/utils';
import type { Task, TaskStatus } from '@/lib/types';

interface TaskListProps {
  initialTasks: Task[];
}

export function TaskList({ initialTasks }: TaskListProps) {
  const router = useRouter();
  const { events, taskPatches } = useWs();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // Apply WS patches to task list
  useEffect(() => {
    const latest = events[0];
    if (!latest) return;

    if (latest.type === 'task.created') {
      // Optimistically prepend a skeleton row; full data arrives on next page load
      router.refresh();
      return;
    }

    if (latest.taskId) {
      setTasks(prev =>
        prev.map(t =>
          t.id === latest.taskId
            ? { ...t, status: taskPatches[latest.taskId!] ?? t.status }
            : t,
        ),
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events[0]]);

  // Flash new tasks
  useEffect(() => {
    if (!events[0] || events[0].type !== 'task.created') return;
    const id = events[0].taskId;
    if (!id) return;
    setNewIds(prev => new Set(prev).add(id));
    const t = setTimeout(() => setNewIds(prev => { const s = new Set(prev); s.delete(id); return s; }), 2000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events[0]]);

  const running   = tasks.filter(t => t.status === 'running').length;
  const pending   = tasks.filter(t => t.status === 'pending' || t.status === 'planning').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const failed    = tasks.filter(t => t.status === 'failed').length;

  return (
    <div className="flex flex-col h-full">
      {/* Stats row */}
      <div className="grid grid-cols-4 gap-px border-b border-zinc-800 flex-shrink-0">
        <StatCard label="Running"   value={running}   accent />
        <StatCard label="Queued"    value={pending} />
        <StatCard label="Completed" value={completed} />
        <StatCard label="Failed"    value={failed} />
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[120px_1fr_140px_120px_80px] gap-0 px-4 py-2 border-b border-zinc-800 flex-shrink-0">
        {['ID', 'TITLE', 'STATUS', 'CREATED', 'AGE'].map(h => (
          <span key={h} className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">{h}</span>
        ))}
      </div>

      {/* Rows */}
      <ScrollArea className="flex-1">
        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-zinc-600">
            <p className="text-sm font-mono">No tasks yet</p>
            <p className="text-xs mt-1">POST /tasks to create one</p>
          </div>
        )}

        {tasks.map(task => {
          const liveStatus: TaskStatus = taskPatches[task.id] ?? task.status;
          return (
            <div
              key={task.id}
              data-testid="task-row"
              onClick={() => router.push(`/tasks/${task.id}`)}
              className={`data-row grid grid-cols-[120px_1fr_140px_120px_80px] gap-0 px-4 py-2.5 ${liveStatus === 'running' ? 'running' : ''} ${newIds.has(task.id) ? 'animate-fade-in bg-cyan-500/5' : ''}`}
            >
              <span className="font-mono text-xs text-zinc-500">{shortId(task.id)}</span>
              <span className="text-xs text-zinc-200 truncate pr-4">{task.title}</span>
              <span><StatusBadge status={liveStatus} /></span>
              <span className="font-mono text-xs text-zinc-500">
                {new Date(task.created_at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="font-mono text-xs text-zinc-600">{age(task.created_at)}</span>
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}

export function TaskListSkeleton() {
  return (
    <div className="space-y-px">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="grid grid-cols-[120px_1fr_140px_120px_80px] gap-0 px-4 py-2.5 border-b border-zinc-800/60">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-4 w-24 rounded-sm" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}
