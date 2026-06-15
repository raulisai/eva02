'use client';

import { cn } from '@/lib/utils';
import type { DevSessionStatus, DevGoalStatus } from '@/lib/dev-studio-types';

const SESSION_COLORS: Record<string, string> = {
  idea_intake:                   'text-zinc-500 bg-zinc-900 border-zinc-800',
  planning:                      'text-amber-400 bg-amber-500/10 border-amber-500/20',
  awaiting_goals_approval:       'text-amber-400 bg-amber-500/10 border-amber-500/20',
  awaiting_architecture_approval:'text-amber-400 bg-amber-500/10 border-amber-500/20',
  running:                       'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  waiting_for_human_setup:       'text-orange-400 bg-orange-500/10 border-orange-500/20',
  waiting_for_human_secret:      'text-orange-400 bg-orange-500/10 border-orange-500/20',
  waiting_for_human_review:      'text-orange-400 bg-orange-500/10 border-orange-500/20',
  waiting_for_human_validation:  'text-orange-400 bg-orange-500/10 border-orange-500/20',
  paused:                        'text-zinc-400 bg-zinc-800/50 border-zinc-700',
  ready_for_release:             'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  completed:                     'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  failed:                        'text-red-400 bg-red-500/10 border-red-500/20',
  cancelled:                     'text-zinc-600 bg-zinc-900 border-zinc-800',
};

const SESSION_LABEL: Record<string, string> = {
  idea_intake:                   'Idea',
  planning:                      'Planificando',
  awaiting_goals_approval:       'Aprobación goals',
  awaiting_architecture_approval:'Aprobación arq.',
  running:                       'Ejecutando',
  waiting_for_human_setup:       'Setup pendiente',
  waiting_for_human_secret:      'Credenciales',
  waiting_for_human_review:      'Revisión',
  waiting_for_human_validation:  'Validación',
  paused:                        'Pausado',
  ready_for_release:             'Para release',
  completed:                     'Completado',
  failed:                        'Fallido',
  cancelled:                     'Cancelado',
};

const GOAL_COLORS: Record<string, string> = {
  draft:       'text-zinc-500 bg-zinc-900 border-zinc-800',
  approved:    'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  in_progress: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  completed:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  validated:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  failed:      'text-red-400 bg-red-500/10 border-red-500/20',
};

const GOAL_LABEL: Record<string, string> = {
  draft:       'Borrador',
  approved:    'Aprobado',
  in_progress: 'En curso',
  completed:   'Completado',
  validated:   'Validado',
  failed:      'Fallido',
};

export function SessionStatusBadge({ status }: { status: DevSessionStatus | string }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono',
      SESSION_COLORS[status] ?? 'text-zinc-500 bg-zinc-900 border-zinc-800',
    )}>
      {SESSION_LABEL[status] ?? status}
    </span>
  );
}

export function GoalStatusBadge({ status }: { status: DevGoalStatus | string }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono',
      GOAL_COLORS[status] ?? 'text-zinc-500 bg-zinc-900 border-zinc-800',
    )}>
      {GOAL_LABEL[status] ?? status}
    </span>
  );
}
