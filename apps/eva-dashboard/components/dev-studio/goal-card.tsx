'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GoalStatusBadge } from './session-status-badge';
import type { DevGoal } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';

interface GoalCardProps {
  goal: DevGoal;
  isSelected?: boolean;
  onValidated?: () => void;
}

export function GoalCard({ goal, isSelected, onValidated }: GoalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const score = goal.current_score ?? 0;
  const pct = Math.round(score * 100);

  async function handleValidate() {
    setLoading(true);
    try {
      await devStudioApi.validateGoal(goal.id);
      onValidated?.();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={cn(
      'rounded-xl border bg-white transition-all',
      isSelected ? 'border-blue-300 shadow-md' : 'border-slate-200 hover:border-slate-300',
    )}>
      <div
        className="flex items-center gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="text-slate-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-slate-800 truncate">{goal.title}</span>
            <GoalStatusBadge status={goal.status} />
            {goal.iteration_count > 0 && (
              <span className="text-xs text-slate-400">Iter. {goal.iteration_count}</span>
            )}
          </div>

          {/* Progress bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  pct >= 80 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-400' : 'bg-blue-400',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-slate-500 tabular-nums">{pct}%</span>
          </div>
        </div>

        {goal.status === 'ready_for_validation' && (
          <button
            onClick={(e) => { e.stopPropagation(); handleValidate(); }}
            disabled={loading}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Validando…' : '✓ Validar'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-slate-100 p-4 space-y-3">
          {goal.description && (
            <p className="text-sm text-slate-600">{goal.description}</p>
          )}

          {goal.success_criteria.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-2">Criterios de éxito</p>
              <ul className="space-y-1.5">
                {goal.success_criteria.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <span className={cn(
                      'mt-0.5 flex-shrink-0 rounded-full p-0.5',
                      c.verified ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400',
                    )}>
                      <Check className="h-3 w-3" />
                    </span>
                    <span className={c.verified ? 'text-slate-700 line-through' : 'text-slate-700'}>
                      {c.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {goal.status === 'blocked' && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              Goal bloqueado. Revisa las tareas humanas pendientes.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
