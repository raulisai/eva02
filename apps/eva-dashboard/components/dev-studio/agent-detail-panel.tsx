'use client';

import { useEffect, useState, lazy, Suspense } from 'react';
import { X, GitBranch, CheckCircle2, Clock, MessageSquare, Terminal, ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentRole } from '@/lib/dev-studio-types';
import { AGENT_ROLE_EMOJI } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

// Lazy-load terminal so xterm CSS doesn't block the panel
const AgentTerminal = lazy(() =>
  import('./agent-terminal').then((m) => ({ default: m.AgentTerminal }))
);

const ROLE_LABEL: Record<string, string> = {
  project_manager: 'Project Manager',
  architect: 'Architect',
  frontend: 'Frontend Agent',
  backend: 'Backend Agent',
  testing: 'Testing Agent',
  deployment: 'Deployment Agent',
  reviewer: 'Reviewer / Integrator',
};

const STATUS_COLOR: Record<string, string> = {
  queued: 'text-slate-500',
  assigned: 'text-blue-600',
  running: 'text-emerald-600',
  needs_review: 'text-purple-600',
  approved: 'text-emerald-700',
  merged: 'text-green-700',
  failed: 'text-red-600',
  completed: 'text-emerald-600',
  cancelled: 'text-slate-400',
};

type Tab = 'tasks' | 'logs' | 'comms' | 'terminal';

interface AgentDetailPanelProps {
  sessionId: string;
  role: AgentRole;
  orgToken: string;
  onClose: () => void;
}

export function AgentDetailPanel({ sessionId, role, orgToken, onClose }: AgentDetailPanelProps) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [logs, setLogs] = useState<Record<string, unknown>[]>([]);
  const [tab, setTab] = useState<Tab>('tasks');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  useEffect(() => {
    devStudioApi.getAgentDetail(sessionId, role).then(setDetail);
  }, [sessionId, role]);

  useEffect(() => {
    if (tab !== 'logs') return;
    devStudioApi.getAgentLogs(sessionId, role).then(setLogs);
    const iv = setInterval(() => devStudioApi.getAgentLogs(sessionId, role).then(setLogs), 4000);
    return () => clearInterval(iv);
  }, [sessionId, role, tab]);

  const studioTasks = (detail?.studioTasks as Record<string, unknown>[] | undefined) ?? [];
  const events = (detail?.events as Record<string, unknown>[] | undefined) ?? [];
  const activeTask = detail?.activeBackingTask as Record<string, unknown> | null | undefined;
  const allBacking = (detail?.allBackingTasks as Record<string, unknown>[] | undefined) ?? [];

  const done = studioTasks.filter((t) => ['approved', 'merged', 'completed'].includes(t.status as string));
  const pending = studioTasks.filter((t) => !['approved', 'merged', 'completed', 'failed', 'cancelled'].includes(t.status as string));
  const current = studioTasks.find((t) => ['running', 'assigned'].includes(t.status as string));

  const activeBackingId = activeTask ? (activeTask.id as string) : null;

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'tasks', label: 'Tareas', count: studioTasks.length },
    { key: 'logs', label: 'Logs', count: logs.length },
    { key: 'comms', label: 'Comms', count: events.length },
    { key: 'terminal', label: 'Terminal' },
  ];

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[520px] bg-slate-950 border-l border-slate-700 flex flex-col z-40 shadow-2xl">
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-slate-700 bg-slate-900">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{AGENT_ROLE_EMOJI[role] ?? '🤖'}</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white">{ROLE_LABEL[role] ?? role}</h2>
            {current && (
              <p className="text-xs text-emerald-400 truncate mt-0.5">
                ⚡ {current.title as string}
              </p>
            )}
            {!current && activeTask && (
              <p className="text-xs text-amber-400 mt-0.5 animate-pulse">preparando…</p>
            )}
            {!current && !activeTask && (
              <p className="text-xs text-slate-500 mt-0.5">en espera</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white rounded-lg hover:bg-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quick stats */}
        <div className="flex gap-4 mt-3">
          <Stat label="Hechas" value={done.length} color="text-emerald-400" />
          <Stat label="En curso" value={pending.length} color="text-blue-400" />
          <Stat label="Commits" value={allBacking.filter((b) => b.status === 'completed').length} color="text-purple-400" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-slate-700 shrink-0 bg-slate-900">
        {TABS.map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex-1 px-2 py-2.5 text-xs font-medium border-b-2 transition-colors',
              tab === key
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-500 hover:text-slate-300',
            )}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className="ml-1 text-[10px] text-slate-600">({count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Tasks tab */}
        {tab === 'tasks' && (
          <div className="p-4 space-y-4">
            {current && (
              <Section title="Trabajando ahora" icon={<span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}>
                <TaskCard task={current} highlight />
              </Section>
            )}

            {pending.filter((t) => t !== current).length > 0 && (
              <Section title="Pendientes">
                {pending.filter((t) => t !== current).map((t) => (
                  <TaskCard key={t.id as string} task={t} />
                ))}
              </Section>
            )}

            {done.length > 0 && (
              <Section title={`Completadas (${done.length})`}>
                {done.map((t) => (
                  <TaskCard key={t.id as string} task={t} done />
                ))}
              </Section>
            )}

            {studioTasks.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-8">No hay tareas asignadas aún</p>
            )}
          </div>
        )}

        {/* Logs tab */}
        {tab === 'logs' && (
          <div className="p-2 space-y-1 font-mono text-xs">
            {logs.length === 0 && (
              <p className="text-slate-500 text-center py-8 font-sans">
                {activeBackingId ? 'Cargando logs…' : 'Sin tarea activa — no hay logs'}
              </p>
            )}
            {logs.map((log) => (
              <div
                key={log.id as string}
                className="group rounded px-2 py-1.5 hover:bg-slate-800 cursor-pointer"
                onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id as string)}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-slate-600 text-[10px] shrink-0 w-5 text-right">{log.step as number}</span>
                  <span className={cn('text-[10px] px-1 rounded font-semibold shrink-0', logTypeColor(log.type as string))}>
                    {log.type as string}
                  </span>
                  <span className="text-slate-300 truncate">
                    {truncateLogContent(log.content)}
                  </span>
                  <span className="ml-auto text-slate-600 shrink-0">
                    {expandedLog === log.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </span>
                </div>
                {expandedLog === log.id && (
                  <pre className="mt-1 ml-7 text-slate-400 whitespace-pre-wrap break-all text-[11px] leading-relaxed max-h-60 overflow-y-auto bg-slate-900 rounded p-2">
                    {JSON.stringify(log.content, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Comms tab */}
        {tab === 'comms' && (
          <div className="p-4 space-y-2">
            {events.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-8">Sin comunicaciones registradas</p>
            )}
            {events.map((ev) => (
              <div key={ev.id as string} className="flex gap-3 items-start">
                <div className="mt-0.5 w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center shrink-0 text-xs">
                  {ev.actor === role ? '→' : '←'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-cyan-400">{ev.actor as string}</span>
                    <span className="text-[10px] text-slate-600">
                      {formatDistanceToNow(new Date(ev.created_at as string), { addSuffix: true, locale: es })}
                    </span>
                  </div>
                  {Boolean(ev.message) && (
                    <p className="text-sm text-slate-300 mt-0.5">{ev.message as string}</p>
                  )}
                  <p className="text-[10px] text-slate-600 mt-0.5">{ev.event_type as string}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Terminal tab */}
        {tab === 'terminal' && (
          <div className="p-4">
            {!activeBackingId && (
              <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 text-center">
                <Terminal className="h-8 w-8 text-slate-600 mx-auto mb-3" />
                <p className="text-sm text-slate-500">
                  No hay sandbox activo para este agente en este momento.
                </p>
                <p className="text-xs text-slate-600 mt-1">
                  El sandbox se crea cuando el agente ejecuta una tarea.
                </p>
              </div>
            )}
            {activeBackingId && (
              <Suspense fallback={
                <div className="h-80 rounded-xl border border-slate-700 bg-slate-900 flex items-center justify-center text-slate-500 text-sm">
                  Cargando terminal…
                </div>
              }>
                <AgentTerminal
                  taskId={activeBackingId}
                  orgToken={orgToken}
                />
              </Suspense>
            )}
            <div className="mt-3 space-y-1">
              <p className="text-xs text-slate-600 font-mono">
                task_id: <span className="text-slate-400">{activeBackingId ?? 'ninguno'}</span>
              </p>
              <p className="text-xs text-slate-600">
                Estás conectado al sandbox Docker del agente. Tienes acceso completo a <code className="text-cyan-400">/work</code>.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer — commits / backing tasks */}
      {allBacking.length > 0 && tab !== 'terminal' && (
        <div className="shrink-0 border-t border-slate-700 bg-slate-900 px-4 py-3">
          <p className="text-[10px] font-medium text-slate-500 mb-2">HISTORIAL DE EJECUCIONES</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {allBacking.slice(0, 8).map((bt) => (
              <div key={bt.id as string} className="shrink-0 rounded-lg bg-slate-800 px-2 py-1.5 text-[10px]">
                <div className={cn('font-medium', STATUS_COLOR[bt.status as string] ?? 'text-slate-400')}>
                  {bt.status as string}
                </div>
                <div className="text-slate-600 mt-0.5">
                  {formatDistanceToNow(new Date(bt.created_at as string), { addSuffix: true, locale: es })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <div className={cn('text-xl font-bold tabular-nums', color)}>{value}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{title}</span>
      </div>
      {children}
    </div>
  );
}

function TaskCard({ task, highlight, done }: { task: Record<string, unknown>; highlight?: boolean; done?: boolean }) {
  const [open, setOpen] = useState(highlight ?? false);
  const criteria = (task.acceptance_criteria as unknown[]) ?? [];

  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5 cursor-pointer transition-colors',
        highlight ? 'border-emerald-700 bg-emerald-900/20' : done ? 'border-slate-700 bg-slate-900/40' : 'border-slate-700 bg-slate-900',
      )}
      onClick={() => setOpen((o) => !o)}
    >
      <div className="flex items-start gap-2">
        {done ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
        ) : highlight ? (
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mt-1 shrink-0" />
        ) : (
          <Clock className="h-3.5 w-3.5 text-slate-500 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-200 leading-snug">{task.title as string}</p>
          {Boolean(task.branch_name) && (
            <div className="flex items-center gap-1 mt-1">
              <GitBranch className="h-3 w-3 text-slate-500" />
              <span className="text-[10px] font-mono text-slate-400">{task.branch_name as string}</span>
            </div>
          )}
        </div>
        <span className={cn('text-[10px] font-medium shrink-0', STATUS_COLOR[task.status as string] ?? 'text-slate-500')}>
          {task.status as string}
        </span>
      </div>

      {open && criteria.length > 0 && (
        <div className="mt-2 ml-5 space-y-1">
          <p className="text-[10px] text-slate-500 uppercase tracking-wide">Criterios</p>
          {criteria.map((c, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-slate-400">
              <span className="text-slate-600 shrink-0">·</span>
              <span>{typeof c === 'string' ? c : (c as Record<string, unknown>).description as string}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function logTypeColor(type: string): string {
  if (type === 'thought') return 'bg-purple-900 text-purple-300';
  if (type === 'tool_call') return 'bg-blue-900 text-blue-300';
  if (type === 'tool_result') return 'bg-cyan-900 text-cyan-300';
  if (type === 'error') return 'bg-red-900 text-red-300';
  if (type === 'final') return 'bg-emerald-900 text-emerald-300';
  return 'bg-slate-800 text-slate-400';
}

function truncateLogContent(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 80);
  if (typeof content === 'object' && content !== null) {
    const c = content as Record<string, unknown>;
    return (c.text ?? c.output ?? c.content ?? JSON.stringify(content)).toString().slice(0, 80);
  }
  return String(content ?? '').slice(0, 80);
}
