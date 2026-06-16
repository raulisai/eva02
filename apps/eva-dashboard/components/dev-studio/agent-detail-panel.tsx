'use client';

import { useEffect, useState, lazy, Suspense } from 'react';
import { X, GitBranch, CheckCircle2, Clock, Terminal, ChevronDown, ChevronRight } from 'lucide-react';
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
  queued: 'text-zinc-500',
  assigned: 'text-blue-400',
  running: 'text-emerald-400',
  needs_review: 'text-purple-400',
  approved: 'text-emerald-400',
  merged: 'text-green-400',
  failed: 'text-red-400',
  completed: 'text-emerald-400',
  cancelled: 'text-zinc-600',
};

const AGENT_STATUS_LABEL: Record<string, string> = {
  idle: 'En espera',
  running: 'Trabajando',
  blocked: 'Bloqueado',
  completed: 'Completado',
  failed: 'Fallido',
  rate_limited: 'Rate limited',
  quota_exhausted: 'Sin quota',
  waiting_for_dependency: 'Esperando dependencia',
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

  // Poll detail every 4s so status/tasks stay live
  useEffect(() => {
    let alive = true;
    const load = () => devStudioApi.getAgentDetail(sessionId, role).then((d) => { if (alive) setDetail(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, role]);

  useEffect(() => {
    if (tab !== 'logs') return;
    let alive = true;
    const load = () => devStudioApi.getAgentLogs(sessionId, role).then((l) => { if (alive) setLogs(l); }).catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, role, tab]);

  const agent = detail?.agent as Record<string, unknown> | null | undefined;
  const studioTasks = (detail?.studioTasks as Record<string, unknown>[] | undefined) ?? [];
  const events = (detail?.events as Record<string, unknown>[] | undefined) ?? [];
  const activeTask = detail?.activeBackingTask as Record<string, unknown> | null | undefined;
  const allBacking = (detail?.allBackingTasks as Record<string, unknown>[] | undefined) ?? [];

  const done = studioTasks.filter((t) => ['approved', 'merged', 'completed'].includes(t.status as string));
  const failed = studioTasks.filter((t) => ['failed', 'cancelled'].includes(t.status as string));
  const pending = studioTasks.filter((t) => !['approved', 'merged', 'completed', 'failed', 'cancelled'].includes(t.status as string));
  const current = studioTasks.find((t) => ['running', 'assigned'].includes(t.status as string));

  const activeBackingId = activeTask ? (activeTask.id as string) : null;
  const agentStatus = (agent?.status as string) ?? 'idle';

  // Latest tool/step from logs for the live "qué está haciendo ahora"
  const lastStep = logs.length > 0 ? logs[logs.length - 1] : null;

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'tasks', label: 'Tareas', count: studioTasks.length },
    { key: 'logs', label: 'Logs', count: logs.length },
    { key: 'comms', label: 'Comms', count: events.length },
    { key: 'terminal', label: 'Terminal' },
  ];

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[520px] bg-zinc-950 border-l border-zinc-800 flex flex-col z-40 shadow-2xl">
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{AGENT_ROLE_EMOJI[role] ?? '🤖'}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">{ROLE_LABEL[role] ?? role}</h2>
              <span className={cn(
                'text-[10px] font-mono px-1.5 py-0.5 rounded border',
                agentStatus === 'running' ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5'
                : agentStatus === 'blocked' || agentStatus === 'failed' ? 'border-red-500/30 text-red-400 bg-red-500/5'
                : agentStatus === 'completed' ? 'border-emerald-500/20 text-emerald-500 bg-emerald-500/5'
                : 'border-zinc-700 text-zinc-500',
              )}>
                {AGENT_STATUS_LABEL[agentStatus] ?? agentStatus}
              </span>
            </div>
            {current ? (
              <p className="text-xs text-emerald-400 truncate mt-0.5">⚡ {current.title as string}</p>
            ) : activeTask ? (
              <p className="text-xs text-amber-400 mt-0.5">preparando…</p>
            ) : (
              <p className="text-xs text-zinc-600 mt-0.5">sin tarea activa</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded-lg hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Live step indicator */}
        {agentStatus === 'running' && lastStep && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="text-[10px] font-mono text-zinc-500 shrink-0">paso {lastStep.step as number}</span>
            <span className="text-[11px] text-zinc-300 truncate font-mono">{stepSummary(lastStep.content)}</span>
          </div>
        )}

        {/* Quick stats */}
        <div className="flex gap-5 mt-3">
          <Stat label="Hechas" value={done.length} color="text-emerald-400" />
          <Stat label="Pendientes" value={pending.length} color="text-blue-400" />
          <Stat label="Fallidas" value={failed.length} color="text-red-400" />
          <Stat label="Ejecuciones" value={allBacking.length} color="text-purple-400" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-zinc-800 shrink-0 bg-zinc-900">
        {TABS.map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex-1 px-2 py-2.5 text-xs font-medium border-b-2 transition-colors',
              tab === key
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-zinc-500 hover:text-zinc-300',
            )}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className="ml-1 text-[10px] text-zinc-600">({count})</span>
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

            {failed.length > 0 && (
              <Section title={`Fallidas (${failed.length})`}>
                {failed.map((t) => (
                  <TaskCard key={t.id as string} task={t} failed />
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
              <p className="text-sm text-zinc-600 text-center py-8">No hay tareas asignadas aún</p>
            )}
          </div>
        )}

        {/* Logs tab */}
        {tab === 'logs' && (
          <div className="p-2 space-y-1 font-mono text-xs">
            {logs.length === 0 && (
              <p className="text-zinc-600 text-center py-8 font-sans">
                {activeBackingId ? 'Cargando logs…' : 'Sin ejecución registrada — no hay logs todavía'}
              </p>
            )}
            {logs.map((log) => (
              <div
                key={log.id as string}
                className="group rounded px-2 py-1.5 hover:bg-zinc-900 cursor-pointer"
                onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id as string)}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-zinc-700 text-[10px] shrink-0 w-5 text-right">{log.step as number}</span>
                  <span className={cn('text-[10px] px-1 rounded font-semibold shrink-0', logTypeColor(log.type as string))}>
                    {log.type as string}
                  </span>
                  <span className="text-zinc-300 truncate">
                    {stepSummary(log.content)}
                  </span>
                  <span className="ml-auto text-zinc-700 shrink-0">
                    {expandedLog === log.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </span>
                </div>
                {expandedLog === log.id && (
                  <pre className="mt-1 ml-7 text-zinc-400 whitespace-pre-wrap break-all text-[11px] leading-relaxed max-h-72 overflow-y-auto bg-zinc-900 rounded p-2 border border-zinc-800">
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
              <p className="text-sm text-zinc-600 text-center py-8">Sin eventos registrados</p>
            )}
            {events.map((ev) => (
              <div key={ev.id as string} className="flex gap-3 items-start">
                <div className="mt-0.5 w-6 h-6 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0 text-[10px] text-zinc-500">
                  →
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-cyan-400">{ev.event_type as string}</span>
                    <span className="text-[10px] text-zinc-700">
                      {formatDistanceToNow(new Date(ev.created_at as string), { addSuffix: true, locale: es })}
                    </span>
                  </div>
                  {Boolean(ev.message) && (
                    <p className="text-xs text-zinc-400 mt-0.5">{ev.message as string}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Terminal tab */}
        {tab === 'terminal' && (
          <div className="p-4">
            {!activeBackingId && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center">
                <Terminal className="h-8 w-8 text-zinc-700 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No hay sandbox activo para este agente ahora mismo.</p>
                <p className="text-xs text-zinc-600 mt-1">El sandbox se crea cuando el agente ejecuta una tarea.</p>
              </div>
            )}
            {activeBackingId && (
              <Suspense fallback={
                <div className="h-80 rounded-lg border border-zinc-800 bg-zinc-900 flex items-center justify-center text-zinc-500 text-sm">
                  Cargando terminal…
                </div>
              }>
                <AgentTerminal taskId={activeBackingId} orgToken={orgToken} />
              </Suspense>
            )}
            <div className="mt-3 space-y-1">
              <p className="text-xs text-zinc-600 font-mono">
                task_id: <span className="text-zinc-400">{activeBackingId ?? 'ninguno'}</span>
              </p>
              <p className="text-xs text-zinc-600">
                Conectado al sandbox Docker del agente. Acceso completo a <code className="text-cyan-400">/work</code>.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer — execution history */}
      {allBacking.length > 0 && tab !== 'terminal' && (
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-4 py-3">
          <p className="text-[10px] font-medium text-zinc-600 mb-2 uppercase tracking-widest">Historial de ejecuciones</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {allBacking.slice(0, 8).map((bt) => (
              <div key={bt.id as string} className="shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[10px]">
                <div className={cn('font-medium', STATUS_COLOR[bt.status as string] ?? 'text-zinc-500')}>
                  {bt.status as string}
                </div>
                <div className="text-zinc-700 mt-0.5">
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
      <div className={cn('text-lg font-bold tabular-nums', color)}>{value}</div>
      <div className="text-[10px] text-zinc-600">{label}</div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{title}</span>
      </div>
      {children}
    </div>
  );
}

function TaskCard({ task, highlight, done, failed }: { task: Record<string, unknown>; highlight?: boolean; done?: boolean; failed?: boolean }) {
  const [open, setOpen] = useState(highlight ?? false);
  const criteria = (task.acceptance_criteria as unknown[]) ?? [];
  const resultSummary = task.result_summary as string | undefined;

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 cursor-pointer transition-colors',
        highlight ? 'border-emerald-500/30 bg-emerald-500/5'
        : failed ? 'border-red-500/20 bg-red-500/5'
        : done ? 'border-zinc-800 bg-zinc-900/40'
        : 'border-zinc-800 bg-zinc-900',
      )}
      onClick={() => setOpen((o) => !o)}
    >
      <div className="flex items-start gap-2">
        {done ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />
        ) : highlight ? (
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mt-1 shrink-0" />
        ) : failed ? (
          <X className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
        ) : (
          <Clock className="h-3.5 w-3.5 text-zinc-600 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-200 leading-snug">{task.title as string}</p>
          {Boolean(task.branch_name) && (
            <div className="flex items-center gap-1 mt-1">
              <GitBranch className="h-3 w-3 text-zinc-600" />
              <span className="text-[10px] font-mono text-zinc-500">{task.branch_name as string}</span>
            </div>
          )}
        </div>
        <span className={cn('text-[10px] font-mono shrink-0', STATUS_COLOR[task.status as string] ?? 'text-zinc-500')}>
          {task.status as string}
        </span>
      </div>

      {open && (
        <div className="mt-2 ml-5 space-y-2">
          {criteria.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wide">Criterios</p>
              {criteria.map((c, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-zinc-400">
                  <span className="text-zinc-700 shrink-0">·</span>
                  <span>{typeof c === 'string' ? c : (c as Record<string, unknown>).description as string}</span>
                </div>
              ))}
            </div>
          )}
          {resultSummary && (
            <div className="space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wide">Resultado</p>
              <p className="text-xs text-zinc-400 whitespace-pre-wrap break-words">{resultSummary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function logTypeColor(type: string): string {
  if (type === 'thought') return 'bg-purple-500/15 text-purple-300';
  if (type === 'tool_call') return 'bg-blue-500/15 text-blue-300';
  if (type === 'tool_result') return 'bg-cyan-500/15 text-cyan-300';
  if (type === 'error') return 'bg-red-500/15 text-red-300';
  if (type === 'final') return 'bg-emerald-500/15 text-emerald-300';
  if (type === 'steer') return 'bg-amber-500/15 text-amber-300';
  if (type === 'input') return 'bg-orange-500/15 text-orange-300';
  return 'bg-zinc-800 text-zinc-400';
}

/** Human-readable one-line summary of a task_events payload. */
function stepSummary(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content.slice(0, 90);
  if (typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.tool === 'string') {
      const args = c.args ? JSON.stringify(c.args).slice(0, 60) : '';
      return `${c.tool}(${args})`;
    }
    if (typeof c.thought === 'string') return c.thought.slice(0, 90);
    if (typeof c.message === 'string') return c.message.slice(0, 90);
    const fallback = (c.text ?? c.output ?? c.content);
    if (fallback != null) return String(fallback).slice(0, 90);
    return JSON.stringify(content).slice(0, 90);
  }
  return String(content).slice(0, 90);
}
