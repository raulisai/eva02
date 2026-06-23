'use client';

import { useEffect, useState, lazy, Suspense } from 'react';
import {
  X, GitBranch, CheckCircle2, Clock, Terminal,
  ChevronDown, ChevronRight, Eye, EyeOff, Check, Star, Wrench,
} from 'lucide-react';
import type { AgentRole, ClaudeAuthOption } from '@/lib/dev-studio-types';
import { AGENT_ROLE_EMOJI } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

// Lazy-load terminal so xterm CSS doesn't block the panel
const AgentTerminal = lazy(() =>
  import('./agent-terminal').then((m) => ({ default: m.AgentTerminal }))
);

/** Roles that run Claude Code inside their Docker machine */
const CODE_ROLES = new Set(['backend', 'frontend', 'full_stack', 'testing']);

const ROLE_LABEL: Record<string, string> = {
  project_manager: 'Project Manager',
  architect: 'Architect',
  frontend: 'Frontend Agent',
  backend: 'Backend Agent',
  full_stack: 'Full Stack Agent',
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
  const [liveSteps, setLiveSteps] = useState<Record<string, unknown>[]>([]);
  const [tab, setTab] = useState<Tab>('tasks');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Poll agent detail every 4 s
  useEffect(() => {
    let alive = true;
    const load = () => devStudioApi.getAgentDetail(sessionId, role)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => {});
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, role]);

  // Always poll last 5 steps for the live activity indicator (independent of tab)
  useEffect(() => {
    let alive = true;
    const load = () => devStudioApi.getAgentLogs(sessionId, role, 5)
      .then((l) => { if (alive) setLiveSteps(l); })
      .catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, role]);

  // Poll full logs only when that tab is open
  useEffect(() => {
    if (tab !== 'logs') return;
    let alive = true;
    const load = () => devStudioApi.getAgentLogs(sessionId, role)
      .then((l) => { if (alive) setLogs(l); })
      .catch(() => {});
    load();
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, role, tab]);

  const agent = detail?.agent as Record<string, unknown> | null | undefined;
  const studioTasks = (detail?.studioTasks as Record<string, unknown>[] | undefined) ?? [];
  const events = (detail?.events as Record<string, unknown>[] | undefined) ?? [];
  const activeTask = detail?.activeBackingTask as Record<string, unknown> | null | undefined;
  const allBacking = (detail?.allBackingTasks as Record<string, unknown>[] | undefined) ?? [];
  const machine = detail?.machine as {
    key: string | null; image: string | null; defaultImage: string | null;
    tooling: string | null; containerName: string | null; up: boolean; runtime: string | null;
    authOk: boolean | null; authError: string | null;
  } | undefined;

  const isCodeRole = CODE_ROLES.has(role);

  const done = studioTasks.filter((t) => ['approved', 'merged', 'completed'].includes(t.status as string));
  const failed = studioTasks.filter((t) => ['failed', 'cancelled'].includes(t.status as string));
  const pending = studioTasks.filter((t) => !['approved', 'merged', 'completed', 'failed', 'cancelled'].includes(t.status as string));
  const current = studioTasks.find((t) => ['running', 'assigned'].includes(t.status as string));

  const activeBackingId = activeTask ? (activeTask.id as string) : null;
  const agentStatus = (agent?.status as string) ?? 'idle';

  // Latest live step from always-on poll
  const lastLiveStep = liveSteps.length > 0 ? liveSteps[liveSteps.length - 1] : null;
  // Last tool call in recent steps (most informative for "doing now")
  const lastToolCall = [...liveSteps].reverse().find((s) => s.type === 'tool_call');
  const liveActivity = lastToolCall ?? lastLiveStep;

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

        {/* Live activity indicator */}
        {agentStatus === 'running' && liveActivity && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="text-[10px] font-mono text-zinc-500 shrink-0 uppercase tracking-widest">
              {liveActivity.type === 'tool_call' ? 'usando' : 'paso'} {liveActivity.step as number}
            </span>
            <span className="text-[11px] text-emerald-300 truncate font-mono">
              {stepSummary(liveActivity.content)}
            </span>
          </div>
        )}

        {/* Quick stats */}
        <div className="flex gap-5 mt-3">
          <Stat label="Hechas" value={done.length} color="text-emerald-400" />
          <Stat label="Pendientes" value={pending.length} color="text-blue-400" />
          <Stat label="Fallidas" value={failed.length} color="text-red-400" />
          <Stat label="Ejecuciones" value={allBacking.length} color="text-purple-400" />
        </div>

        {/* Machine section */}
        {machine && (
          <div className="mt-3 space-y-2">
            {/* Row 1: container status + image */}
            <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
              <span className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                machine.up ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600',
              )} />
              <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                {machine.up ? 'activa' : 'apagada'}
              </span>
              <span className="text-[11px] font-mono text-zinc-300 truncate" title={machine.image ?? undefined}>
                {machine.image ?? machine.defaultImage ?? 'eva-agent-base'}
              </span>
            </div>

            {/* Row 2: tools pills */}
            {machine.tooling && (
              <div className="flex flex-wrap items-center gap-1 px-0.5">
                <Wrench className="h-2.5 w-2.5 text-zinc-600 shrink-0" />
                {machine.tooling.split(' · ').map((tool) => (
                  <span
                    key={tool.trim()}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-900/60 text-zinc-400"
                  >
                    {tool.trim()}
                  </span>
                ))}
              </div>
            )}

            {/* Row 3: Claude Code auth status (code roles only) */}
            {isCodeRole && (
              <>
                <div className={cn(
                  'flex items-center gap-2.5 rounded-md border px-2.5 py-2',
                  machine.authOk === true
                    ? 'border-emerald-500/20 bg-emerald-500/5'
                    : machine.authOk === false
                    ? 'border-red-500/20 bg-red-500/5'
                    : 'border-zinc-800 bg-zinc-950',
                )}>
                  <span className="text-sm shrink-0">🤖</span>
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-[11px] font-medium',
                      machine.authOk === true ? 'text-emerald-400'
                      : machine.authOk === false ? 'text-red-400'
                      : 'text-zinc-500',
                    )}>
                      {machine.authOk === true
                        ? 'Claude Code conectado'
                        : machine.authOk === false
                        ? 'Token inválido'
                        : 'Claude Code no configurado'}
                    </p>
                    {machine.authError && (
                      <p className="text-[9px] text-zinc-600 truncate mt-0.5" title={machine.authError}>
                        {machine.authError}
                      </p>
                    )}
                  </div>
                  {machine.authOk !== true && !connecting && (
                    <button
                      onClick={() => setConnecting(true)}
                      className="shrink-0 text-[10px] font-mono px-2.5 py-1 rounded border border-cyan-500/40 text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 transition-colors"
                    >
                      {machine.authOk === false ? 'Reconectar' : 'Conectar'}
                    </button>
                  )}
                  {machine.authOk === true && (
                    <span className="shrink-0 text-[10px] font-mono text-emerald-400">🔑</span>
                  )}
                </div>

                {/* Inline Claude Code connect form */}
                {connecting && (
                  <ConnectClaudeCodeForm
                    sessionId={sessionId}
                    onSuccess={() => {
                      setConnecting(false);
                      devStudioApi.getAgentDetail(sessionId, role).then(setDetail).catch(() => {});
                    }}
                    onCancel={() => setConnecting(false)}
                  />
                )}
              </>
            )}
          </div>
        )}
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
        {tab === 'terminal' && (() => {
          const terminalTarget = activeBackingId ?? (machine?.up ? machine.key : null);
          return (
            <div className="p-4">
              {!terminalTarget && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center">
                  <Terminal className="h-8 w-8 text-zinc-700 mx-auto mb-3" />
                  <p className="text-sm text-zinc-500">La máquina de este agente todavía no está levantada.</p>
                  <p className="text-xs text-zinc-600 mt-1 mb-3">Se levanta automáticamente cuando el agente se registra en la iteración.</p>
                  <button
                    onClick={() => {
                      setBooting(true);
                      devStudioApi.bootAgentMachine(sessionId, role)
                        .catch(() => {})
                        .finally(() => {
                          setBooting(false);
                          devStudioApi.getAgentDetail(sessionId, role).then(setDetail).catch(() => {});
                        });
                    }}
                    disabled={booting}
                    className="text-xs px-3 py-1.5 rounded-md border border-cyan-500/30 text-cyan-300 bg-cyan-500/5 hover:bg-cyan-500/10 disabled:opacity-50"
                  >
                    {booting ? 'Levantando…' : 'Levantar máquina ahora'}
                  </button>
                </div>
              )}
              {terminalTarget && (
                <Suspense fallback={
                  <div className="h-80 rounded-lg border border-zinc-800 bg-zinc-900 flex items-center justify-center text-zinc-500 text-sm">
                    Cargando terminal…
                  </div>
                }>
                  <AgentTerminal taskId={terminalTarget} orgToken={orgToken} />
                </Suspense>
              )}
              <div className="mt-3 space-y-1">
                <p className="text-xs text-zinc-600 font-mono">
                  imagen: <span className="text-cyan-400">{machine?.image ?? machine?.defaultImage ?? '—'}</span>
                </p>
                <p className="text-xs text-zinc-600 font-mono">
                  contenedor: <span className="text-zinc-400">{machine?.containerName ?? 'ninguno'}</span>
                </p>
                <p className="text-xs text-zinc-600">
                  Conectado a la máquina Docker dedicada del agente. Acceso completo a <code className="text-cyan-400">/work</code>.
                </p>
              </div>
            </div>
          );
        })()}
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

// ── Inline Claude Code connect form ───────────────────────────────────────────

const FALLBACK_AUTH_OPTIONS: ClaudeAuthOption[] = [
  {
    method: 'oauth',
    label: 'Token de suscripción (OAuth)',
    description: 'Usa tu plan Max/Pro ya contratado. No paga por token.',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    recommended: true,
    hint: 'Genera el token con `claude setup-token` y pégalo aquí.',
  },
  {
    method: 'api_key',
    label: 'API key de Anthropic',
    description: 'Pay-per-token con una API key (sk-ant-…).',
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'Crea una key en console.anthropic.com → API Keys.',
  },
  {
    method: 'org',
    label: 'Credencial de la organización',
    description: 'Token OAuth compartido a nivel organización.',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    hint: 'Token OAuth de la cuenta de la organización.',
  },
];

function ConnectClaudeCodeForm({
  sessionId,
  onSuccess,
  onCancel,
}: {
  sessionId: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [options, setOptions] = useState<ClaudeAuthOption[]>(FALLBACK_AUTH_OPTIONS);
  const [method, setMethod] = useState<string>('oauth');
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    devStudioApi.getClaudeCodeOptions()
      .then((r) => {
        if (r.options?.length) {
          setOptions(r.options);
          const rec = r.options.find((o) => o.recommended);
          if (rec) setMethod(rec.method);
        }
      })
      .catch(() => {});
  }, []);

  const selected = options.find((o) => o.method === method);

  async function submit() {
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await devStudioApi.saveClaudeCodeCredential(sessionId, method, token.trim());
      onSuccess();
    } catch (e) {
      setError((e as Error).message || 'No se pudo guardar la credencial');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-cyan-500/20 bg-cyan-500/5 px-3 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-zinc-200">Conectar Claude Code</p>
        <button onClick={onCancel} className="text-zinc-600 hover:text-zinc-400">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Method selector */}
      <div className="space-y-1.5">
        {options.map((opt) => {
          const active = opt.method === method;
          return (
            <button
              key={opt.method}
              type="button"
              onClick={() => setMethod(opt.method)}
              className={cn(
                'w-full text-left rounded border px-2.5 py-2 transition-colors',
                active ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn(
                  'flex h-3 w-3 items-center justify-center rounded-full border shrink-0',
                  active ? 'border-cyan-400 bg-cyan-400' : 'border-zinc-700',
                )}>
                  {active && <Check className="h-2 w-2 text-zinc-950" />}
                </span>
                <span className="text-[11px] font-medium text-zinc-200">{opt.label}</span>
                {opt.recommended && (
                  <span className="ml-auto flex items-center gap-0.5 text-[9px] font-mono text-amber-400">
                    <Star className="h-2.5 w-2.5 fill-amber-400" /> recomendado
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-500 mt-0.5 pl-5">{opt.description}</p>
            </button>
          );
        })}
      </div>

      {/* Token input */}
      <div className="space-y-1.5">
        {selected?.hint && (
          <p className="text-[10px] text-zinc-600 font-mono">{selected.hint}</p>
        )}
        <div className="relative">
          <input
            type={show ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder={method === 'api_key' ? 'sk-ant-…' : 'token de Claude Code'}
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 pr-8 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1.5 text-zinc-600 hover:text-zinc-400"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <p className="text-[9px] text-zinc-700">
          El token se guarda cifrado y se inyecta en la máquina del agente en runtime. EVA nunca lo muestra.
        </p>
      </div>

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <button
        onClick={submit}
        disabled={loading || !token.trim()}
        className="w-full rounded border border-cyan-500/20 bg-cyan-500/10 py-1.5 text-xs font-mono text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors"
      >
        {loading ? 'Conectando…' : 'Conectar Claude Code'}
      </button>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

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
