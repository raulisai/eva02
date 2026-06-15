'use client';

import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import type { DevEvent } from '@/lib/dev-studio-types';
import { cn } from '@/lib/utils';

const EVENT_ICON: Record<string, string> = {
  'session.running': '🚀',
  'session.goals_complete': '🎉',
  'session.steered': '🎯',
  'goals.awaiting_approval': '⏳',
  'dev.goals.approved': '✅',
  'iteration.started': '▶',
  'iteration.completed': '✓',
  'iteration.evaluated': '📊',
  'tasks.created': '📋',
  'task.started': '⚡',
  'task.completed': '✓',
  'task.failed': '✗',
  'agent.blocked': '🚧',
  'goal.ready_for_validation': '🔍',
  'orchestrator.tick': '🔄',
};

function getEventColor(eventType: string): string {
  if (eventType.includes('failed') || eventType.includes('blocked')) return 'text-red-500 bg-red-50';
  if (eventType.includes('completed') || eventType.includes('verified') || eventType.includes('approved')) return 'text-emerald-600 bg-emerald-50';
  if (eventType.includes('started') || eventType.includes('running')) return 'text-blue-600 bg-blue-50';
  if (eventType.includes('human') || eventType.includes('awaiting') || eventType.includes('waiting')) return 'text-amber-600 bg-amber-50';
  return 'text-slate-600 bg-slate-50';
}

interface SessionTimelineProps {
  events: DevEvent[];
}

export function SessionTimeline({ events }: SessionTimelineProps) {
  const sorted = [...events].reverse(); // chronological order

  return (
    <div className="space-y-1">
      {sorted.map((event) => (
        <div key={event.id} className="flex gap-3 items-start group">
          <div className={cn(
            'mt-0.5 flex-shrink-0 rounded-full w-6 h-6 flex items-center justify-center text-xs',
            getEventColor(event.event_type),
          )}>
            {EVENT_ICON[event.event_type] ?? '·'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs font-mono text-slate-400">
                {formatDistanceToNow(new Date(event.created_at), { addSuffix: true, locale: es })}
              </span>
              <span className="text-xs font-medium text-slate-500">{event.event_type}</span>
            </div>
            {event.message && (
              <p className="text-sm text-slate-700 mt-0.5 line-clamp-2 group-hover:line-clamp-none">
                {event.message}
              </p>
            )}
          </div>
        </div>
      ))}
      {sorted.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-4">No hay eventos aún</p>
      )}
    </div>
  );
}
