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
      'rounded-md border bg-zinc-900/60 transition-all',
      isSelected ? 'border-cyan-500/30' : 'border-zinc-800 hover:border-zinc-700',
    )}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}>
        <span className="text-zinc-700 shrink-0">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-200 truncate">{goal.title}</span>
            <GoalStatusBadge status={goal.status} />
            {goal.iteration_count > 0 && (
              <span className="text-[10px] font-mono text-zinc-600">iter.{goal.iteration_count}</span>
            )}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-0.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  pct >= 80 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-400' : 'bg-cyan-500',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-zinc-600 tabular-nums">{pct}%</span>
          </div>
        </div>

        {goal.status === 'ready_for_validation' && (
          <button onClick={(e) => { e.stopPropagation(); handleValidate(); }} disabled={loading}
            className="shrink-0 rounded border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-mono text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors">
            {loading ? '…' : '✓ Validar'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-3">
          {goal.description && (
            <p className="text-xs text-zinc-500">{goal.description}</p>
          )}

          {goal.success_criteria.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-700">Criterios</p>
              <ul className="space-y-1">
                {goal.success_criteria.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-xs">
                    <span className={cn(
                      'mt-0.5 shrink-0 rounded p-0.5',
                      c.verified ? 'text-emerald-500' : 'text-zinc-700',
                    )}>
                      <Check className="h-3 w-3" />
                    </span>
                    <span className={c.verified ? 'text-zinc-600 line-through' : 'text-zinc-400'}>
                      {c.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {goal.status === 'blocked' && (
            <div className="flex items-start gap-2 rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Goal bloqueado — revisa tareas humanas pendientes.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
