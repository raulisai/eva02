'use client';

import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import type { DevEvent } from '@/lib/dev-studio-types';
import { cn } from '@/lib/utils';

const EVENT_ICON: Record<string, string> = {
  'session.running':        '▶',
  'session.goals_complete': '✦',
  'session.steered':        '◎',
  'goals.awaiting_approval':'◌',
  'dev.goals.approved':     '✓',
  'iteration.started':      '▷',
  'iteration.completed':    '◆',
  'iteration.evaluated':    '◈',
  'tasks.created':          '⊞',
  'task.started':           '⚡',
  'task.completed':         '◉',
  'task.failed':            '✗',
  'agent.blocked':          '⊘',
  'goal.ready_for_validation':'◎',
  'orchestrator.tick':      '·',
};

function eventColor(type: string): { dot: string; text: string } {
  if (type.includes('failed') || type.includes('blocked') || type.includes('error'))
    return { dot: 'bg-red-500', text: 'text-red-400' };
  if (type.includes('completed') || type.includes('verified') || type.includes('approved'))
    return { dot: 'bg-emerald-500', text: 'text-emerald-400' };
  if (type.includes('started') || type.includes('running'))
    return { dot: 'bg-cyan-500', text: 'text-cyan-400' };
  if (type.includes('human') || type.includes('awaiting') || type.includes('waiting'))
    return { dot: 'bg-orange-500', text: 'text-orange-400' };
  return { dot: 'bg-zinc-700', text: 'text-zinc-500' };
}

export function SessionTimeline({ events }: { events: DevEvent[] }) {
  const sorted = [...events].reverse();

  return (
    <div className="space-y-0">
      {sorted.map((event, i) => {
        const { dot, text } = eventColor(event.event_type);
        const isLast = i === sorted.length - 1;
        return (
          <div key={event.id} className="flex gap-3 group">
            {/* Spine */}
            <div className="flex flex-col items-center shrink-0">
              <div className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', dot)} />
              {!isLast && <div className="w-px flex-1 bg-zinc-800 mt-1" />}
            </div>

            {/* Content */}
            <div className={cn('flex-1 min-w-0 pb-3', isLast ? '' : '')}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={cn('text-[10px] font-mono', text)}>
                  {EVENT_ICON[event.event_type] ?? '·'} {event.event_type}
                </span>
                <span className="text-[10px] text-zinc-700 ml-auto shrink-0">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true, locale: es })}
                </span>
              </div>
              {event.message && (
                <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2 group-hover:line-clamp-none">
                  {event.message}
                </p>
              )}
            </div>
          </div>
        );
      })}
      {sorted.length === 0 && (
        <p className="text-xs text-zinc-700 text-center py-8">Sin eventos aún</p>
      )}
    </div>
  );
}
