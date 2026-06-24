'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, RotateCcw, Trash2, AlertTriangle, CheckCircle, Clock, Loader2 } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import { cn } from '@/lib/utils';

const ROLE_DISPLAY: Record<string, string> = {
  project_manager: 'PM', architect: 'Architect', backend: 'Backend',
  frontend: 'Frontend', full_stack: 'Full Stack', testing: 'Testing',
  deployment: 'Deployment', reviewer: 'Reviewer',
};

const STATUS_COLOR: Record<string, string> = {
  queued:       'text-zinc-500 bg-zinc-900/30 border-zinc-800',
  assigned:     'text-cyan-400 bg-cyan-500/5 border-cyan-500/20',
  running:      'text-amber-400 bg-amber-500/5 border-amber-500/20',
  needs_review: 'text-purple-400 bg-purple-500/5 border-purple-500/20',
  approved:     'text-emerald-400 bg-emerald-500/5 border-emerald-500/20',
  merged:       'text-emerald-400 bg-emerald-500/5 border-emerald-500/20',
  failed:       'text-red-400 bg-red-500/5 border-red-500/20',
  cancelled:    'text-zinc-700 bg-zinc-950 border-zinc-900',
};

const EVENT_COLOR: Record<string, string> = {
  'task.completed':   'text-emerald-400',
  'task.started':     'text-cyan-400',
  'task.failed':      'text-red-400',
  'agent.blocked':    'text-orange-400',
};

interface TaskDetailPanelProps {
  task: Record<string, unknown>;
  sessionId: string;
  stuckInfo?: { role: string; reason: string; sinceMs: number | null; taskTitle: string | null } | null;
  onClose: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

export function TaskDetailPanel({ task, sessionId, stuckInfo, onClose, onRetry, onDelete }: TaskDetailPanelProps) {
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const taskId = task.id as string;
  const status = task.status as string;
  const isFailedOrCancelled = ['failed', 'cancelled'].includes(status);
  const isActive = ['running', 'assigned'].includes(status);

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const ev = await devStudioApi.listTaskEvents(taskId);
      setEvents(ev);
    } catch {
      // silently ignore
    } finally {
      setLoadingEvents(false);
    }
  }, [taskId]);

  useEffect(() => {
    void loadEvents();
    if (!isActive) return;
    const iv = setInterval(loadEvents, 4000);
    return () => clearInterval(iv);
  }, [loadEvents, isActive]);

  async function handleRetry() {
    setRetrying(true);
    try {
      await devStudioApi.retryTask(taskId);
      onRetry();
      onClose();
    } finally {
      setRetrying(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await devStudioApi.deleteTask(taskId);
      onDelete();
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  const isTaskStuck = stuckInfo?.taskTitle === task.title;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end" onClick={onClose}>
      <div
        className="relative h-full w-full max-w-lg bg-[#050810] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-white/5 px-5 py-4 flex items-start justify-between gap-3 bg-[#070a13]/80">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={cn('text-[9px] font-mono border rounded px-1.5 py-0.5 capitalize', STATUS_COLOR[status] ?? 'text-zinc-400 border-zinc-800')}>
                {status}
              </span>
              <span className="text-[9px] font-mono text-zinc-600 uppercase">
                {ROLE_DISPLAY[task.role as string] ?? (task.role as string)}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-zinc-100 leading-snug">{task.title as string}</h2>
            {Boolean(task.branch_name) && (
              <p className="text-[9px] font-mono text-cyan-500/60 mt-1">🌿 {task.branch_name as string}</p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Blocking info */}
        {isTaskStuck && stuckInfo && (
          <div className="shrink-0 mx-4 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs">
              <p className="text-amber-300 font-semibold">Atascado — {stuckInfo.reason}</p>
              {stuckInfo.sinceMs != null && (
                <p className="text-amber-500/70 font-mono text-[10px] mt-0.5">
                  hace {Math.round(stuckInfo.sinceMs / 60000)}m sin progreso
                </p>
              )}
            </div>
          </div>
        )}

        {/* Result summary */}
        {Boolean(task.result_summary) && (
          <div className={cn(
            'shrink-0 mx-4 mt-4 rounded-lg border px-3 py-2.5 text-xs leading-snug',
            status === 'failed' ? 'border-red-500/20 bg-red-500/5 text-red-300' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300',
          )}>
            <p className="font-mono text-[9px] mb-1 opacity-60">{status === 'failed' ? 'ERROR' : 'RESULTADO'}</p>
            <p>{task.result_summary as string}</p>
          </div>
        )}

        {/* Acceptance criteria */}
        {Array.isArray(task.acceptance_criteria) && (task.acceptance_criteria as unknown[]).length > 0 && (
          <div className="shrink-0 mx-4 mt-3 space-y-1">
            <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider mb-1.5">Criterios de aceptación</p>
            {(task.acceptance_criteria as unknown[]).map((c, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px] text-zinc-500">
                <CheckCircle className="h-3 w-3 shrink-0 mt-0.5 text-zinc-700" />
                <span>{typeof c === 'string' ? c : (c as Record<string, string>).description}</span>
              </div>
            ))}
          </div>
        )}

        {/* Events log */}
        <div className="flex-1 overflow-y-auto px-4 py-3 mt-2 min-h-0">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider">Eventos de ejecución</p>
            <button onClick={loadEvents} disabled={loadingEvents} className="text-zinc-600 hover:text-zinc-400 transition-colors">
              <RefreshCw className={cn('h-3 w-3', loadingEvents && 'animate-spin')} />
            </button>
          </div>

          {loadingEvents && events.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 text-zinc-700 animate-spin" />
            </div>
          )}

          {!loadingEvents && events.length === 0 && (
            <p className="text-[10px] text-zinc-700 text-center py-8 font-mono">
              {isActive ? 'Esperando eventos…' : 'Sin eventos registrados para esta tarea'}
            </p>
          )}

          <div className="space-y-2">
            {events.map((ev: Record<string, unknown>, i) => {
              const evType = ev.event_type as string ?? '';
              const colorClass = EVENT_COLOR[evType] ?? 'text-zinc-500';
              const msg = ev.message as string ?? (ev.payload as Record<string, unknown>)?.text as string ?? '';
              const ts = ev.created_at ? new Date(ev.created_at as string).toLocaleTimeString() : '';

              return (
                <div key={(ev.id as string) ?? i} className="flex gap-2 text-[10px] font-mono">
                  <span className="text-zinc-700 shrink-0 tabular-nums">{ts}</span>
                  <span className={cn('shrink-0', colorClass)}>{evType}</span>
                  {msg && <span className="text-zinc-500 truncate">{msg}</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions footer */}
        <div className="shrink-0 border-t border-white/5 px-4 py-3 flex items-center justify-between bg-[#070a13]/60">
          <div className="flex items-center gap-2">
            {isFailedOrCancelled && (
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-all"
              >
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                Reintentar tarea
              </button>
            )}
            {isActive && (
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-amber-400">
                <Clock className="h-3 w-3 animate-pulse" />
                En ejecución…
              </div>
            )}
          </div>

          <button
            onClick={handleDelete}
            disabled={deleting}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all',
              confirmDelete
                ? 'bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30'
                : 'bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-red-400 hover:border-red-500/30',
            )}
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            {confirmDelete ? '¿Confirmar eliminación?' : 'Eliminar'}
          </button>
        </div>
      </div>
    </div>
  );
}
