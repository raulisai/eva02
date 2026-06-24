'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import {
  Play,
  Pause,
  X,
  Send,
  RefreshCw,
  GitBranch,
  ChevronDown,
  Target,
  Activity,
  Cpu,
  Layers,
  AlertTriangle,
  Eye,
  EyeOff,
  CheckCircle,
  ClipboardList,
  User,
  Users,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type {
  DevSession,
  DevGoal,
  DevHumanTask,
  DevAgent,
  DevMergeProposal,
  DevEvent,
  DevIteration,
  FlowState,
} from '@/lib/dev-studio-types';
import { useAuthToken } from '@/hooks/use-auth-token';
import { SessionStatusBadge } from './session-status-badge';
import { SessionTimeline } from './session-timeline';
import { MergeProposalPanel } from './merge-proposal-panel';
import { AgentFlowDiagram } from './agent-flow-diagram';
import { TaskDetailPanel } from './task-detail-panel';
import { cn } from '@/lib/utils';

const ROLE_DISPLAY: Record<string, string> = {
  project_manager: 'PM', architect: 'Architect', backend: 'Backend',
  frontend: 'Frontend', full_stack: 'Full Stack', testing: 'Testing',
  deployment: 'Deployment', reviewer: 'Reviewer',
};

interface SessionDetailProps {
  session: DevSession;
  onUpdate?: (s: DevSession) => void;
}

export function SessionDetail({ session: initial, onUpdate }: SessionDetailProps) {
  const router = useRouter();
  const [session, setSession] = useState<DevSession>(initial);
  const [sessions, setSessions] = useState<DevSession[]>([]);
  const [goals, setGoals] = useState<DevGoal[]>([]);
  const [humanTasks, setHumanTasks] = useState<DevHumanTask[]>([]);
  const [agents, setAgents] = useState<DevAgent[]>([]);
  const [proposals, setProposals] = useState<DevMergeProposal[]>([]);
  const [events, setEvents] = useState<DevEvent[]>([]);
  const [iterations, setIterations] = useState<DevIteration[]>([]);
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [selectedGoals, setSelectedGoals] = useState<Set<string>>(new Set());
  const [bottomView, setBottomView] = useState<'dashboard' | 'timeline' | 'all_tasks'>('dashboard');
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [submittingTaskId, setSubmittingTaskId] = useState<string | null>(null);
  const [taskResponses, setTaskResponses] = useState<Record<string, string>>({});
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
  const [selectedTask, setSelectedTask] = useState<Record<string, unknown> | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [unsticking, setUnsticking] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState<'all' | 'active' | 'pending'>('all');

  const orgToken = useAuthToken();

  const refresh = useCallback(async () => {
    try {
      const [g, ht, ag, mp, ev, it, tk, sList, fl] = await Promise.all([
        devStudioApi.listGoals(session.id),
        devStudioApi.listHumanTasks(session.id),
        devStudioApi.listAgents(session.id),
        devStudioApi.listMergeProposals(session.id),
        devStudioApi.listEvents(session.id, 50),
        devStudioApi.listIterations(session.id),
        devStudioApi.listTasks(session.id),
        devStudioApi.listSessions(),
        devStudioApi.getFlowState(session.id).catch(() => null),
      ]);
      setGoals(g);
      setHumanTasks(ht);
      setAgents(ag);
      setProposals(mp);
      setEvents(ev);
      setIterations(it);
      setTasks(tk);
      setSessions(sList);
      if (fl) setFlow(fl);
      
      const updated = await devStudioApi.getSession(session.id);
      setSession(updated);
      onUpdate?.(updated);
    } catch (err) {
      console.error('Error refreshing dev studio session detail', err);
    }
  }, [session.id, onUpdate]);

  // Slow poll as a fallback; real-time updates come from the WebSocket below.
  useEffect(() => {
    refresh();
    const isActive = ['running', 'planning', 'awaiting_goals_approval', 'awaiting_architecture_approval'].includes(session.status);
    if (!isActive) return;
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh, session.status]);

  // Push: refresh on dev.* events for this session instead of relying on polling.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!orgToken) return;
    const coreUrl = process.env.NEXT_PUBLIC_CORE_URL ?? 'http://localhost:3000';
    const socket: Socket = io(`${coreUrl}/eva`, { auth: { token: orgToken }, transports: ['websocket'] });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void refreshRef.current(); }, 300);
    };

    const DEV_EVENTS = [
      'dev.session.updated', 'dev.iteration.updated', 'dev.tasks.created',
      'dev.task.started', 'dev.task.completed', 'dev.task.failed',
      'dev.agent.machine', 'dev.human_task.created', 'dev.human_task.verified',
      'dev.goal.ready_for_validation', 'dev.goals_complete',
    ];
    const onEvent = (msg: { payload?: { sessionId?: string } }) => {
      // Only react to events for this session (events are org-scoped, multi-session).
      if (!msg?.payload?.sessionId || msg.payload.sessionId === session.id) debouncedRefresh();
    };
    DEV_EVENTS.forEach((t) => socket.on(t, onEvent));

    return () => {
      if (timer) clearTimeout(timer);
      DEV_EVENTS.forEach((t) => socket.off(t, onEvent));
      socket.disconnect();
    };
  }, [orgToken, session.id]);

  async function handleAction(action: 'start' | 'pause' | 'resume' | 'cancel') {
    setLoading(true);
    try {
      if (action === 'start') await devStudioApi.startSession(session.id);
      else if (action === 'pause') await devStudioApi.pauseSession(session.id);
      else if (action === 'resume') await devStudioApi.resumeSession(session.id);
      else if (action === 'cancel') {
        if (!confirm('¿Cancelar esta sesión?')) return;
        await devStudioApi.cancelSession(session.id);
      }
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleApproveGoals() {
    if (selectedGoals.size === 0) return;
    setLoading(true);
    try {
      await devStudioApi.approveGoals(session.id, Array.from(selectedGoals));
      setSelectedGoals(new Set());
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleSteer(e: React.FormEvent) {
    e.preventDefault();
    if (!steerText.trim()) return;
    await devStudioApi.steerSession(session.id, steerText);
    setSteerText('');
  }

  // Submit human tasks directly in the checklist for high productivity
  async function handleSubmitHumanTask(taskId: string) {
    const responseText = taskResponses[taskId];
    if (!responseText?.trim()) return;
    setSubmittingTaskId(taskId);
    try {
      await devStudioApi.submitHumanTask(taskId, { value: responseText }, responseText);
      await devStudioApi.verifyHumanTask(taskId);
      setTaskResponses((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      await refresh();
    } catch (err) {
      console.error('Failed to submit human task', err);
    } finally {
      setSubmittingTaskId(null);
    }
  }

  const pendingHumanTasks = humanTasks.filter((t) => ['pending', 'waiting_user', 'submitted'].includes(t.status));
  const pendingMerges = proposals.filter((p) => p.status === 'pending');
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(session.status);

  // Stats Calculations
  const activeGoalsCount = goals.filter((g) => ['in_progress', 'approved', 'proposed', 'ready_for_validation'].includes(g.status)).length || 0;
  
  const activeTasksCount = tasks.filter((t) => ['running', 'assigned'].includes(t.status as string)).length;
  const pendingTasksCount = tasks.filter((t) => ['queued', 'pending'].includes(t.status as string)).length;
  
  const { calculatedTokens, tokensIsEstimate } = useMemo(() => {
    const metaTokens = session.metadata?.tokens_used || session.metadata?.total_tokens;
    if (typeof metaTokens === 'number') {
      if (metaTokens > 1000000) return { calculatedTokens: `${(metaTokens / 1000000).toFixed(1)}M`, tokensIsEstimate: false };
      if (metaTokens > 1000) return { calculatedTokens: `${(metaTokens / 1000).toFixed(0)}k`, tokensIsEstimate: false };
      return { calculatedTokens: metaTokens.toString(), tokensIsEstimate: false };
    }
    if (tasks.length === 0 && iterations.length === 0) return { calculatedTokens: '—', tokensIsEstimate: true };
    const estimated = (iterations.length * 380000) + (tasks.length * 90000) + 180000;
    return { calculatedTokens: `~${(estimated / 1000000).toFixed(1)}M`, tokensIsEstimate: true };
  }, [session.metadata, tasks.length, iterations.length]);

  const avgProgress = useMemo(() => {
    if (goals.length === 0) return 0;
    const completedGoals = goals.filter((g) => ['completed', 'validated'].includes(g.status)).length;
    const workingGoals = goals.filter((g) => g.status === 'in_progress').length;
    const scoreSum = goals.reduce((acc, g) => acc + (g.current_score ?? 0), 0);
    const avg = scoreSum / goals.length;
    const calc = Math.round(avg * 100);
    if (calc === 0 && (completedGoals > 0 || workingGoals > 0)) {
      return Math.round(((completedGoals + workingGoals * 0.5) / goals.length) * 100);
    }
    return Math.min(Math.max(calc, 0), 100);
  }, [goals]);

  // Project progress ring config
  const radius = 12;
  const strokeWidth = 2.5;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (avgProgress / 100) * circumference;

  return (
    <div className="flex flex-col h-full bg-[#03060f] text-zinc-100 overflow-y-auto">
      {/* ── Top Bar / Header ────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-white/5 bg-[#070a13]/70 backdrop-blur-md px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Title and Dropdown */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 border border-cyan-500/20 shadow-[0_0_15px_-3px_rgba(34,211,238,0.2)]">
              <Layers className="h-[18px] w-[18px] text-cyan-400" />
            </div>
            <div>
              <h1 className="text-[13px] font-bold tracking-wide text-zinc-100 uppercase">EVA Development Studio</h1>
              <p className="text-[10px] text-zinc-500 font-mono">Autonomic Agent Orchestrator</p>
            </div>
          </div>

          {/* Session Switcher Dropdown */}
          {sessions.length > 0 && (
            <div className="relative ml-2">
              <select
                value={session.id}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) router.push(`/dev-studio/sessions/${id}`);
                }}
                className="bg-[#0b1224]/80 text-zinc-100 text-[11px] font-semibold rounded-lg border border-white/5 pl-3 pr-8 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-500/30 cursor-pointer appearance-none shadow-inner"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-2.5 flex items-center pointer-events-none text-zinc-400">
                <ChevronDown className="h-3.5 w-3.5" />
              </div>
            </div>
          )}
        </div>

        {/* Dynamic KPI Stats Widgets */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* Goals KPI */}
          <div className="flex flex-col rounded-xl border border-white/5 bg-[#0b1224]/40 p-2.5 min-w-[105px] h-[52px] justify-between">
            <div className="flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">Goals</span>
            </div>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-sm font-bold text-zinc-100">{activeGoalsCount}</span>
              <span className="text-[9px] text-emerald-400 font-medium">activos</span>
            </div>
          </div>

          {/* Active Tasks KPI */}
          <button
            onClick={() => { setBottomView('all_tasks'); setTaskStatusFilter('active'); }}
            className="flex flex-col rounded-xl border border-white/5 bg-[#0b1224]/40 p-2.5 min-w-[125px] h-[52px] justify-between relative overflow-hidden hover:border-blue-500/30 hover:bg-blue-500/5 transition-all text-left"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">Tareas ejec.</span>
              </div>
              <svg className="w-10 h-3 text-blue-400/70" viewBox="0 0 60 16" fill="none">
                <path d="M0 8h12l3-6 4 12 3-8 3 4 5-2 2 4h16" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="flowing" />
              </svg>
            </div>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-sm font-bold text-zinc-100">{activeTasksCount}</span>
              <span className="text-[9px] text-blue-400 font-medium">activas</span>
            </div>
          </button>

          {/* Tokens KPI */}
          <div className="flex flex-col rounded-xl border border-white/5 bg-[#0b1224]/40 p-2.5 min-w-[115px] h-[52px] justify-between">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-purple-400 shrink-0" />
              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">Tokens usados</span>
            </div>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-sm font-bold text-zinc-100">{calculatedTokens}</span>
              <span className="text-[9px] text-purple-400 font-medium">{tokensIsEstimate ? 'estimado' : 'real'}</span>
            </div>
          </div>

          {/* Progress KPI */}
          <div className="flex items-center rounded-xl border border-white/5 bg-[#0b1224]/40 p-2 px-3 gap-2.5 h-[52px]">
            {/* Circle progress ring */}
            <div className="relative flex items-center justify-center">
              <svg className="w-8 h-8 -rotate-90 text-emerald-400" viewBox="0 0 32 32">
                <circle cx="16" cy="16" r={radius} stroke="#1e293b" strokeWidth={strokeWidth} fill="transparent" />
                <circle
                  cx="16"
                  cy="16"
                  r={radius}
                  stroke="currentColor"
                  strokeWidth={strokeWidth}
                  fill="transparent"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute text-[8px] font-bold text-zinc-300 font-mono">
                {avgProgress}%
              </div>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[8.5px] font-mono text-zinc-500 uppercase tracking-wider">Progreso del proyecto</span>
              <span className="text-[10px] font-semibold text-emerald-400 mt-0.5">en curso</span>
            </div>
          </div>

          {/* Global Operations controls */}
          <div className="flex items-center gap-1.5 border-l border-white/10 pl-3">
            <button
              onClick={refresh}
              className="p-1.5 rounded-lg border border-white/5 bg-[#0b1224]/40 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Refrescar"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>

            {session.status === 'idea_intake' && (
              <button
                onClick={() => handleAction('start')}
                disabled={loading}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-all"
              >
                <Play className="h-3 w-3" /> Iniciar
              </button>
            )}
            {session.status === 'running' && (
              <button
                onClick={() => handleAction('pause')}
                disabled={loading}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold border border-zinc-700/80 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-all"
              >
                <Pause className="h-3 w-3" /> Pausar
              </button>
            )}
            {session.status === 'paused' && (
              <button
                onClick={() => handleAction('resume')}
                disabled={loading}
                className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-all"
              >
                <Play className="h-3 w-3" /> Reanudar
              </button>
            )}
            {!isTerminal && (
              <button
                onClick={() => handleAction('cancel')}
                disabled={loading}
                className="p-1.5 rounded-lg border border-white/5 bg-[#0b1224]/40 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Cancelar sesión"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Main Workspace ──────────────────────────────────────────────────── */}
      <main className="flex-1 p-6 space-y-6">
        
        {/* Approvals / Warning banners */}
        {session.status === 'awaiting_goals_approval' && goals.length > 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 shadow-[0_0_20px_-3px_rgba(245,158,11,0.15)]">
            <AlertTriangle className="h-[18px] w-[18px] text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-semibold text-zinc-200">Aprobación de objetivos requerida</h4>
              <p className="text-[10px] text-zinc-500 mt-0.5">Selecciona y aprueba la lista de objetivos para que el equipo comience a ejecutar.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedGoals(new Set<string>(goals.map((g) => g.id)))}
                className="text-[10px] font-mono text-zinc-400 hover:text-zinc-200 transition-colors px-2 py-1"
              >
                Seleccionar todos
              </button>
              <button
                onClick={handleApproveGoals}
                disabled={loading || selectedGoals.size === 0}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40 transition-all"
              >
                Aprobar ({selectedGoals.size})
              </button>
            </div>
          </div>
        )}

        {pendingMerges.length > 0 && (
          <div className="animate-fade-in">
            <MergeProposalPanel proposals={pendingMerges} onUpdated={refresh} />
          </div>
        )}

        {/* ── Stuck alert banner — shown when flow.stuck has a reason ─────── */}
        {flow?.stuck && session.status === 'running' && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 shadow-[0_0_24px_-4px_rgba(239,68,68,0.2)]">
            <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5 animate-pulse" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-xs font-bold text-red-300">
                  Sesión atascada — {flow.stuck.reason}
                </h4>
                {flow.stuck.role !== 'human' && (
                  <span className="text-[9px] font-mono bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded uppercase">
                    {ROLE_DISPLAY[flow.stuck.role] ?? flow.stuck.role}
                  </span>
                )}
                {flow.stuck.sinceMs != null && (
                  <span className="text-[9px] font-mono text-red-500/70">
                    {Math.round(flow.stuck.sinceMs / 60000)}m sin avance
                  </span>
                )}
              </div>
              {flow.stuck.taskTitle && (
                <p className="text-[10px] text-zinc-500 mt-0.5 truncate">
                  Tarea: &ldquo;{flow.stuck.taskTitle}&rdquo;
                </p>
              )}
              {(flow.stuck as { lastError?: string | null }).lastError && (
                <p className="text-[10px] font-mono text-red-400/80 mt-1 line-clamp-2">
                  {(flow.stuck as { lastError: string }).lastError}
                </p>
              )}
            </div>
            {flow.stuck.role !== 'human' && (
              <button
                onClick={async () => {
                  setUnsticking(true);
                  try {
                    const r = await devStudioApi.unstickSession(session.id);
                    await refresh();
                    if (r.requeued === 0) alert('No hay tareas atascadas que re-encolar en este momento.');
                  } finally {
                    setUnsticking(false);
                  }
                }}
                disabled={unsticking}
                className="shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 disabled:opacity-40 transition-all"
              >
                {unsticking
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Desatascando…</>
                  : <><RotateCcw className="h-3.5 w-3.5" /> Desatacar sesión</>}
              </button>
            )}
          </div>
        )}

        {/* 1. Flow Diagram Container (Center) */}
        <section className="relative">
          <AgentFlowDiagram
            agents={agents}
            sessionId={session.id}
            orgToken={orgToken ?? ''}
            sessionStatus={session.status}
            onAgentDeleted={refresh}
          />

          {/* Steer command form below diagram */}
          {['running', 'paused'].includes(session.status) && (
            <form onSubmit={handleSteer} className="mt-4 flex gap-2 max-w-2xl mx-auto">
              <input
                type="text"
                value={steerText}
                onChange={(e) => setSteerText(e.target.value)}
                placeholder="Instrucción al equipo (mid-loop steer)…"
                className="flex-1 rounded-lg border border-white/5 bg-[#0b1224]/60 backdrop-blur-md px-3.5 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-all"
              />
              <button
                type="submit"
                disabled={!steerText.trim()}
                className="rounded-lg border border-white/5 bg-[#0b1224]/60 text-zinc-400 hover:text-cyan-400 hover:border-cyan-500/30 disabled:opacity-40 px-3.5 py-2 transition-all"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          )}
        </section>

        {/* Toggle bar to swap bottom view between Dashboard, Timeline and Technical Tasks */}
        <div className="flex items-center justify-between border-b border-white/5 pb-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Panel de Control</span>
          <div className="flex items-center gap-1 bg-zinc-950/80 rounded-lg p-0.5 border border-white/5">
            <button
              onClick={() => setBottomView('dashboard')}
              className={cn(
                "px-2.5 py-1 text-[10px] font-mono rounded-md transition-all",
                bottomView === 'dashboard' ? "bg-[#0b1224] text-cyan-400 border border-white/5" : "text-zinc-600 hover:text-zinc-400"
              )}
            >
              Principal
            </button>
            <button
              onClick={() => setBottomView('timeline')}
              className={cn(
                "px-2.5 py-1 text-[10px] font-mono rounded-md transition-all",
                bottomView === 'timeline' ? "bg-[#0b1224] text-cyan-400 border border-white/5" : "text-zinc-600 hover:text-zinc-400"
              )}
            >
              Timeline
            </button>
            <button
              onClick={() => setBottomView('all_tasks')}
              className={cn(
                "px-2.5 py-1 text-[10px] font-mono rounded-md transition-all",
                bottomView === 'all_tasks' ? "bg-[#0b1224] text-cyan-400 border border-white/5" : "text-zinc-600 hover:text-zinc-400"
              )}
            >
              Tareas
            </button>
          </div>
        </div>

        {/* Bottom panels rendering */}
        {bottomView === 'dashboard' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            
            {/* COLUMN 1: Goals */}
            <div className="rounded-2xl border border-white/5 bg-[#070a13]/40 backdrop-blur-md p-4 flex flex-col justify-between min-h-[180px]">
              <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400">
                  <Target className="h-3.5 w-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">Goals</h3>
              </div>

              <div className="flex-1 py-3 space-y-3.5 overflow-y-auto max-h-[160px] pr-1">
                {goals.map((goal) => {
                  const score = goal.current_score ?? 0;
                  const pct = Math.round(score * 100);
                  const isCompleted = ['completed', 'validated'].includes(goal.status);
                  const isExpanded = expandedGoalId === goal.id;

                  return (
                    <div
                      key={goal.id}
                      className={cn(
                        "group flex flex-col rounded-lg p-1.5 transition-all",
                        session.status === 'awaiting_goals_approval' ? "cursor-pointer hover:bg-zinc-800/10" : ""
                      )}
                      onClick={() => {
                        if (session.status === 'awaiting_goals_approval') {
                          setSelectedGoals((s) => {
                            const n = new Set(s);
                            n.has(goal.id) ? n.delete(goal.id) : n.add(goal.id);
                            return n;
                          });
                        } else {
                          setExpandedGoalId(isExpanded ? null : goal.id);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        {/* Checkbox for goals approval */}
                        {session.status === 'awaiting_goals_approval' && (
                          <div className={cn(
                            "h-3 w-3 shrink-0 rounded border transition-colors mr-1",
                            selectedGoals.has(goal.id) ? "border-cyan-500 bg-cyan-500" : "border-zinc-700 bg-zinc-900"
                          )} />
                        )}
                        
                        <span className="text-[11px] font-medium text-zinc-200 truncate flex-1 leading-normal">
                          {goal.title}
                        </span>

                        <span className="text-[9px] font-mono text-zinc-500 tabular-nums shrink-0">
                          {pct}%
                        </span>

                        {/* LED status indicator */}
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0 ml-1.5 shadow-sm",
                          isCompleted ? "bg-emerald-500 shadow-emerald-500/30" : 
                          ['in_progress', 'approved', 'proposed'].includes(goal.status) ? "bg-cyan-400 shadow-cyan-400/30" :
                          "bg-zinc-600"
                        )} />
                      </div>

                      {/* Custom compact progress bar */}
                      <div className="mt-2 w-full h-0.5 rounded-full bg-zinc-900 overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            isCompleted ? "bg-emerald-500" : pct >= 40 ? "bg-amber-400" : "bg-cyan-500"
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      {/* Expanded Criteria */}
                      {isExpanded && goal.success_criteria && (
                        <div className="mt-2 pl-2 border-l border-white/5 space-y-1 py-1 animate-fade-in text-[10px] text-zinc-500 leading-normal">
                          {goal.description && <p className="mb-1.5 italic text-zinc-400">{goal.description}</p>}
                          {goal.success_criteria.map((c) => (
                            <div key={c.id} className="flex items-start gap-1">
                              <span className={c.verified ? "text-emerald-400" : "text-zinc-600"}>
                                {c.verified ? '✓' : '·'}
                              </span>
                              <span className={cn(c.verified ? "text-zinc-400 line-through" : "")}>{c.description}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {goals.length === 0 && (
                  <p className="text-[11px] text-zinc-700 text-center py-6">
                    {['planning', 'idea_intake'].includes(session.status) ? 'Generando objetivos…' : 'Sin objetivos definidos'}
                  </p>
                )}
              </div>
            </div>

            {/* COLUMN 2: Tareas principales */}
            <div className="rounded-2xl border border-white/5 bg-[#070a13]/40 backdrop-blur-md p-4 flex flex-col justify-between min-h-[180px]">
              <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
                  <Activity className="h-3.5 w-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">Tareas principales</h3>
              </div>

              <div className="flex-1 flex items-center justify-center py-4 gap-12">
                <button
                  onClick={() => { setBottomView('all_tasks'); setTaskStatusFilter('active'); }}
                  className="flex flex-col items-center hover:opacity-70 transition-opacity"
                >
                  <span className="text-4xl font-extrabold text-blue-400 font-mono tracking-tight">
                    {activeTasksCount}
                  </span>
                  <span className="text-[9.5px] font-mono text-zinc-500 uppercase tracking-wider mt-1">
                    activas
                  </span>
                </button>
                <div className="h-8 w-px bg-white/5" />
                <button
                  onClick={() => { setBottomView('all_tasks'); setTaskStatusFilter('pending'); }}
                  className="flex flex-col items-center hover:opacity-70 transition-opacity"
                >
                  <span className="text-4xl font-extrabold text-zinc-400 font-mono tracking-tight">
                    {pendingTasksCount}
                  </span>
                  <span className="text-[9.5px] font-mono text-zinc-500 uppercase tracking-wider mt-1">
                    pendientes
                  </span>
                </button>
              </div>

              <button
                onClick={() => { setBottomView('all_tasks'); setTaskStatusFilter('all'); }}
                className="text-[9.5px] text-center text-zinc-600 hover:text-zinc-400 font-mono transition-colors"
              >
                {tasks.length} tareas técnicas registradas en total
              </button>
            </div>

            {/* COLUMN 3: Tareas del humano */}
            <div className="rounded-2xl border border-white/5 bg-[#070a13]/40 backdrop-blur-md p-4 flex flex-col justify-between min-h-[180px]">
              <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
                  <User className="h-3.5 w-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-100">Tareas del humano</h3>
              </div>

              <div className="flex-1 py-3 space-y-2.5 overflow-y-auto max-h-[160px] pr-1">
                {pendingHumanTasks.map((task) => {
                  const isExpanded = expandedTaskId === task.id;
                  const isSubmitted = task.status === 'submitted';
                  
                  // Compute a priority label based on sensitivity
                  const priority = task.sensitive ? 'Alta' : 'Media';
                  const priorityColor = task.sensitive ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-orange-500/10 text-orange-400 border-orange-500/20';

                  return (
                    <div key={task.id} className="group border-b border-white/5 pb-2 last:border-b-0">
                      <div
                        className="flex items-start gap-2.5 cursor-pointer"
                        onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                      >
                        <div className="h-3.5 w-3.5 rounded border border-zinc-700 bg-zinc-950 flex items-center justify-center shrink-0 mt-0.5 group-hover:border-zinc-500 transition-colors">
                          {isSubmitted && <span className="text-[8px] text-cyan-400">✓</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className={cn("text-[11px] font-medium block leading-normal", isSubmitted ? "text-zinc-500 line-through" : "text-zinc-200")}>
                            {task.title}
                          </span>
                        </div>
                        <span className={cn("text-[9px] font-mono border rounded px-1.5 py-0.5 shrink-0 select-none", priorityColor)}>
                          {priority}
                        </span>
                      </div>

                      {/* Expanded Task Completion Input */}
                      {isExpanded && !isSubmitted && (
                        <div className="mt-2.5 pl-6 space-y-2 animate-fade-in">
                          {task.description && <p className="text-[10px] text-zinc-500 leading-normal">{task.description}</p>}
                          {task.required_output && <p className="text-[9.5px] text-cyan-500/80 font-mono">Requerido: {task.required_output}</p>}
                          
                          <div className="relative">
                            <textarea
                              value={taskResponses[task.id] ?? ''}
                              onChange={(e) => setTaskResponses({ ...taskResponses, [task.id]: e.target.value })}
                              placeholder={task.sensitive ? '(Ingresa credencial/valor sensible)' : 'Escribe tu respuesta…'}
                              rows={2}
                              className="w-full rounded-lg border border-white/5 bg-zinc-950 px-3 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-700 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/30 transition-all"
                              style={task.sensitive && !showSensitive[task.id] ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                            />
                            {task.sensitive && (
                              <button
                                type="button"
                                onClick={() => setShowSensitive({ ...showSensitive, [task.id]: !showSensitive[task.id] })}
                                className="absolute right-2 top-2 text-zinc-600 hover:text-zinc-400"
                              >
                                {showSensitive[task.id] ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                              </button>
                            )}
                          </div>
                          <div className="flex justify-end">
                            <button
                              onClick={() => handleSubmitHumanTask(task.id)}
                              disabled={submittingTaskId === task.id || !(taskResponses[task.id] ?? '').trim()}
                              className="rounded-lg bg-cyan-500/10 border border-cyan-500/20 px-2.5 py-1 text-[10px] font-mono text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors"
                            >
                              {submittingTaskId === task.id ? 'Enviando…' : 'Entregar y continuar'}
                            </button>
                          </div>
                        </div>
                      )}
                      
                      {isExpanded && isSubmitted && (
                        <div className="mt-2 pl-6 text-[10px] text-zinc-500 flex items-center gap-1.5 animate-fade-in">
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                          Enviado — esperando verificación
                        </div>
                      )}
                    </div>
                  );
                })}

                {pendingHumanTasks.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-6 text-center">
                    <CheckCircle className="h-5 w-5 text-emerald-500/20 mb-1" />
                    <p className="text-[11px] text-zinc-600 font-mono">Sin tareas pendientes</p>
                  </div>
                )}
              </div>
              
              <div className="text-[9.5px] text-center text-emerald-400 font-mono select-none">
                ✓ Todo al día
              </div>
            </div>
            
          </div>
        )}

        {/* Alternate bottom view: Timeline logs */}
        {bottomView === 'timeline' && (
          <div className="rounded-2xl border border-white/5 bg-[#070a13]/40 backdrop-blur-md p-4">
            <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-4">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-[18px] w-[18px] text-cyan-400" />
                <h3 className="text-xs font-semibold text-zinc-100">Línea de tiempo de eventos</h3>
              </div>
              <span className="text-[9px] font-mono text-zinc-500">{events.length} eventos recientes</span>
            </div>
            <div className="max-h-[300px] overflow-y-auto pr-1">
              <SessionTimeline events={events} />
            </div>
          </div>
        )}

        {/* Alternate bottom view: All technical tasks list */}
        {bottomView === 'all_tasks' && (
          <div className="rounded-2xl border border-white/5 bg-[#070a13]/40 backdrop-blur-md p-4">
            <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-4">
              <div className="flex items-center gap-2">
                <Activity className="h-[18px] w-[18px] text-cyan-400" />
                <h3 className="text-xs font-semibold text-zinc-100">Registro de tareas de agentes</h3>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 bg-zinc-950/80 rounded-lg p-0.5 border border-white/5">
                  {(['all', 'active', 'pending'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setTaskStatusFilter(f)}
                      className={cn(
                        'px-2 py-0.5 text-[9px] font-mono rounded-md transition-all',
                        taskStatusFilter === f ? 'bg-[#0b1224] text-cyan-400 border border-white/5' : 'text-zinc-600 hover:text-zinc-400',
                      )}
                    >
                      {f === 'all' ? 'todas' : f === 'active' ? 'activas' : 'pendientes'}
                    </button>
                  ))}
                </div>
                <span className="text-[9px] font-mono text-zinc-500">{tasks.length} tareas técnicas</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[300px] overflow-y-auto pr-1">
              {tasks.filter((t: any) => {
                if (taskStatusFilter === 'active') return ['running', 'assigned'].includes(t.status as string);
                if (taskStatusFilter === 'pending') return ['queued', 'pending'].includes(t.status as string);
                return true;
              }).map((t: any) => {
                const statusColor: Record<string, string> = {
                  queued:       'text-zinc-500 border-zinc-800 bg-zinc-900/10',
                  assigned:     'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
                  running:      'text-amber-400 border-amber-500/20 bg-amber-500/5',
                  needs_review: 'text-purple-400 border-purple-500/20 bg-purple-500/5',
                  approved:     'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
                  merged:       'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
                  failed:       'text-red-400 border-red-500/20 bg-red-500/5',
                  cancelled:    'text-zinc-700 border-zinc-800 bg-zinc-950',
                };

                const status = t.status as string;
                const isFailedOrCancelled = ['failed', 'cancelled'].includes(status);
                const isActive = ['running', 'assigned'].includes(status);

                // Check if this task is the stuck one
                const stuckAgent = flow?.stuck;
                const isStuck = stuckAgent && stuckAgent.taskTitle === (t.title as string);

                // Resolve assigned agent name
                const assignedAgent = t.assigned_agent_id
                  ? agents.find((a) => a.id === t.assigned_agent_id)
                  : agents.find((a) => a.role === (t.role as string));
                const agentName = assignedAgent?.name ?? (ROLE_DISPLAY[t.role as string] ?? t.role);

                // Collaborators: other unique roles active in the same iteration
                const collaboratorNames: string[] = t.iteration_id
                  ? tasks
                      .filter((other: any) => other.iteration_id === t.iteration_id && other.role !== t.role)
                      .reduce((acc: string[], other: any) => {
                        const role = other.role as string;
                        if (role && !acc.includes(role)) acc.push(role);
                        return acc;
                      }, [])
                      .slice(0, 3)
                      .map((role: string) => agents.find((a) => a.role === role)?.name ?? ROLE_DISPLAY[role] ?? role)
                  : [];

                return (
                  <div
                    key={t.id as string}
                    className={cn(
                      'group flex flex-col rounded-lg border bg-[#090d16]/40 p-3 transition-all cursor-pointer',
                      isStuck ? 'border-amber-500/30 hover:border-amber-500/50' : 'border-white/5 hover:border-zinc-700',
                    )}
                    onClick={() => setSelectedTask(t)}
                  >
                    <div className="flex items-start gap-3 justify-between">
                      <div className="min-w-0 flex-1 leading-snug">
                        <p className="text-[11px] font-semibold text-zinc-200 truncate">{t.title as string}</p>

                        {/* Blocking hint */}
                        {isStuck && stuckAgent && (
                          <div className="flex items-center gap-1 mt-1">
                            <AlertTriangle className="h-2.5 w-2.5 text-amber-400 shrink-0" />
                            <span className="text-[9px] text-amber-400 font-mono truncate">
                              {stuckAgent.reason}
                              {stuckAgent.sinceMs != null && ` · ${Math.round(stuckAgent.sinceMs / 60000)}m`}
                            </span>
                          </div>
                        )}

                        {/* Assigned to */}
                        <div className="flex items-center gap-1 mt-1.5">
                          <User className="h-2.5 w-2.5 text-cyan-500/70 shrink-0" />
                          <span className="text-[9.5px] text-cyan-400/80 font-medium truncate">{agentName}</span>
                        </div>

                        {/* Working with collaborators */}
                        {collaboratorNames.length > 0 && (
                          <div className="flex items-center gap-1 mt-1">
                            <Users className="h-2.5 w-2.5 text-zinc-600 shrink-0" />
                            <span className="text-[9px] text-zinc-500 font-mono truncate">
                              con {collaboratorNames.join(', ')}
                            </span>
                          </div>
                        )}

                        {/* Role + branch */}
                        <div className="flex items-center gap-1.5 mt-1 font-mono text-[9px] text-zinc-600">
                          <span className="uppercase tracking-wider">{ROLE_DISPLAY[t.role as string] ?? t.role}</span>
                          {t.branch_name && <span className="text-zinc-700">· {t.branch_name as string}</span>}
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <span className={cn('text-[9px] font-mono border rounded px-1.5 py-0.5 capitalize select-none', statusColor[status] ?? 'text-zinc-400 border-zinc-800 bg-zinc-900/20')}>
                          {status}
                        </span>

                        {/* Action buttons — visible on hover */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {isFailedOrCancelled && (
                            <button
                              title="Reintentar"
                              onClick={async (e) => {
                                e.stopPropagation();
                                await devStudioApi.retryTask(t.id as string);
                                await refresh();
                              }}
                              className="p-1 rounded text-zinc-600 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors"
                            >
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          )}
                          <button
                            title="Eliminar tarea"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!confirm(`¿Eliminar "${t.title}"?`)) return;
                              setDeletingTaskId(t.id as string);
                              try {
                                await devStudioApi.deleteTask(t.id as string);
                                await refresh();
                              } finally {
                                setDeletingTaskId(null);
                              }
                            }}
                            disabled={deletingTaskId === t.id}
                            className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Inline result summary for failed tasks */}
                    {status === 'failed' && t.result_summary && (
                      <p className="mt-2 text-[9.5px] text-red-400/80 font-mono line-clamp-2 border-t border-red-500/10 pt-1.5">
                        {t.result_summary as string}
                      </p>
                    )}
                  </div>
                );
              })}

              {tasks.filter((t: any) => {
                if (taskStatusFilter === 'active') return ['running', 'assigned'].includes(t.status as string);
                if (taskStatusFilter === 'pending') return ['queued', 'pending'].includes(t.status as string);
                return true;
              }).length === 0 && (
                <div className="col-span-2 text-center py-8">
                  <p className="text-xs text-zinc-600 font-mono">
                    {taskStatusFilter === 'all' ? 'Sin tareas técnicas disponibles' :
                     taskStatusFilter === 'active' ? 'Sin tareas activas en este momento' :
                     'Sin tareas pendientes'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {/* ── Branch Footer ───────────────────────────────────────────────────── */}
      {session.session_branch && (
        <footer className="shrink-0 border-t border-white/5 bg-[#070a13]/70 backdrop-blur-md px-6 py-2 flex items-center gap-2 select-none">
          <GitBranch className="h-3.5 w-3.5 text-zinc-600" />
          <span className="text-[9.5px] font-mono text-zinc-600 uppercase tracking-wide">Branch:</span>
          <span className="text-[10px] font-mono text-cyan-400/80">{session.session_branch}</span>
        </footer>
      )}

      {/* ── Task Detail Panel ────────────────────────────────────────────────── */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          sessionId={session.id}
          stuckInfo={flow?.stuck ?? null}
          onClose={() => setSelectedTask(null)}
          onRetry={() => { void refresh(); }}
          onDelete={() => { void refresh(); }}
        />
      )}
    </div>
  );
}
