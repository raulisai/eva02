'use client';

import { cn } from '@/lib/utils';
import type { DevSessionStatus, DevGoalStatus } from '@/lib/dev-studio-types';
import { SESSION_STATUS_LABEL, GOAL_STATUS_LABEL } from '@/lib/dev-studio-types';

const SESSION_STATUS_COLOR: Record<DevSessionStatus, string> = {
  idea_intake: 'bg-slate-100 text-slate-700',
  planning: 'bg-blue-100 text-blue-700',
  awaiting_goals_approval: 'bg-amber-100 text-amber-700',
  awaiting_architecture_approval: 'bg-amber-100 text-amber-700',
  running: 'bg-emerald-100 text-emerald-700',
  waiting_for_human_setup: 'bg-orange-100 text-orange-700',
  waiting_for_human_secret: 'bg-orange-100 text-orange-700',
  waiting_for_human_review: 'bg-orange-100 text-orange-700',
  waiting_for_human_validation: 'bg-orange-100 text-orange-700',
  paused: 'bg-slate-100 text-slate-600',
  blocked: 'bg-red-100 text-red-700',
  ready_for_release: 'bg-purple-100 text-purple-700',
  ready_for_deploy: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

const GOAL_STATUS_COLOR: Record<DevGoalStatus, string> = {
  proposed: 'bg-slate-100 text-slate-600',
  approved: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-emerald-100 text-emerald-700',
  blocked: 'bg-red-100 text-red-700',
  needs_user_decision: 'bg-amber-100 text-amber-700',
  ready_for_validation: 'bg-purple-100 text-purple-700',
  validated: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  paused: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-slate-100 text-slate-500',
};

export function SessionStatusBadge({ status }: { status: DevSessionStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', SESSION_STATUS_COLOR[status])}>
      {status === 'running' && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
      {SESSION_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function GoalStatusBadge({ status }: { status: DevGoalStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', GOAL_STATUS_COLOR[status])}>
      {GOAL_STATUS_LABEL[status] ?? status}
    </span>
  );
}
