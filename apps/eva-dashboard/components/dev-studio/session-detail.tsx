'use client';

import { useState, useEffect, useCallback } from 'react';
import { Play, Pause, X, Send, RefreshCw, GitBranch } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type {
  DevSession, DevGoal, DevHumanTask, DevAgent,
  DevMergeProposal, DevEvent, DevIteration,
} from '@/lib/dev-studio-types';
import { useAuthToken } from '@/hooks/use-auth-token';
import { SessionStatusBadge } from './session-status-badge';
import { GoalCard } from './goal-card';
import { HumanTaskPanel } from './human-task-panel';
import { SessionTimeline } from './session-timeline';
import { MergeProposalPanel } from './merge-proposal-panel';
import { AgentFlowDiagram } from './agent-flow-diagram';

interface SessionDetailProps {
  session: DevSession;
  onUpdate?: (s: DevSession) => void;
}

type Tab = 'diagram' | 'goals' | 'timeline' | 'tasks';

export function SessionDetail({ session: initial, onUpdate }: SessionDetailProps) {
  const [session, setSession] = useState<DevSession>(initial);
  const [goals, setGoals] = useState<DevGoal[]>([]);
  const [humanTasks, setHumanTasks] = useState<DevHumanTask[]>([]);
  const [agents, setAgents] = useState<DevAgent[]>([]);
  const [proposals, setProposals] = useState<DevMergeProposal[]>([]);
  const [events, setEvents] = useState<DevEvent[]>([]);
  const [iterations, setIterations] = useState<DevIteration[]>([]);
  const [tab, setTab] = useState<Tab>('diagram');
  const [steerText, setSteerText] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedGoals, setSelectedGoals] = useState<Set<string>>(new Set());
  const orgToken = useAuthToken();

  const refresh = useCallback(async () => {
    const [g, ht, ag, mp, ev, it] = await Promise.all([
      devStudioApi.listGoals(session.id),
      devStudioApi.listHumanTasks(session.id),
      devStudioApi.listAgents(session.id),
      devStudioApi.listMergeProposals(session.id),
      devStudioApi.listEvents(session.id, 50),
      devStudioApi.listIterations(session.id),
    ]);
    setGoals(g); setHumanTasks(ht); setAgents(ag);
    setProposals(mp); setEvents(ev); setIterations(it);
    const updated = await devStudioApi.getSession(session.id);
    setSession(updated);
    onUpdate?.(updated);
  }, [session.id, onUpdate]);

  useEffect(() => {
    refresh();
    const isActive = ['running', 'planning', 'awaiting_goals_approval', 'awaiting_architecture_approval'].includes(session.status);
    if (!isActive) return;
    const interval = setInterval(refresh, 8000);
    return () => clearInterval(interval);
  }, [refresh, session.status]);

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
    } finally { setLoading(false); }
  }

  async function handleApproveGoals() {
    if (selectedGoals.size === 0) return;
    setLoading(true);
    try {
      await devStudioApi.approveGoals(session.id, Array.from(selectedGoals));
      setSelectedGoals(new Set());
      await refresh();
    } finally { setLoading(false); }
  }

  async function handleSteer(e: React.FormEvent) {
    e.preventDefault();
    if (!steerText.trim()) return;
    await devStudioApi.steerSession(session.id, steerText);
    setSteerText('');
  }

  const pendingHumanTasks = humanTasks.filter((t) => ['pending', 'waiting_user', 'submitted'].includes(t.status));
  const pendingMerges = proposals.filter((p) => p.status === 'pending');
  const currentIteration = iterations.find((i) => i.id === session.current_iteration_id);
  const isTerminal = ['completed', 'cancelled', 'failed'].includes(session.status);

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'diagram', label: 'Equipo' },
    { key: 'goals',   label: 'Goals',    badge: goals.length || undefined },
    { key: 'timeline',label: 'Timeline' },
    { key: 'tasks',   label: 'Tareas' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-950 px-5 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-sm font-semibold text-zinc-100 truncate">{session.title}</h1>
              <SessionStatusBadge status={session.status} />
            </div>
            {session.north_star && (
              <p className="mt-0.5 text-[11px] text-zinc-600 italic truncate">"{session.north_star}"</p>
            )}
            {currentIteration && (
              <p className="mt-0.5 text-[10px] text-zinc-700 font-mono truncate">
                {currentIteration.title}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button onClick={refresh} className="p-1.5 rounded text-zinc-700 hover:text-zinc-400 hover:bg-zinc-800 transition-colors" title="Refrescar">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>

            {session.status === 'idea_intake' && (
              <button onClick={() => handleAction('start')} disabled={loading}
                className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] font-medium bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors">
                <Play className="h-3 w-3" /> Iniciar
              </button>
            )}
            {session.status === 'running' && (
              <button onClick={() => handleAction('pause')} disabled={loading}
                className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] font-medium border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 transition-colors">
                <Pause className="h-3 w-3" /> Pausar
              </button>
            )}
            {session.status === 'paused' && (
              <button onClick={() => handleAction('resume')} disabled={loading}
                className="flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors">
                <Play className="h-3 w-3" /> Reanudar
              </button>
            )}
            {!isTerminal && (
              <button onClick={() => handleAction('cancel')} disabled={loading}
                className="p-1.5 rounded text-zinc-700 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Cancelar">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Approval banner */}
        {session.status === 'awaiting_goals_approval' && goals.length > 0 && (
          <div className="mt-2 flex items-center gap-3 rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <p className="text-[11px] text-amber-400 flex-1">Selecciona los goals a aprobar</p>
            <button onClick={() => setSelectedGoals(new Set<string>(goals.map((g) => g.id)))}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">Todos</button>
            <button onClick={handleApproveGoals} disabled={loading || selectedGoals.size === 0}
              className="rounded px-2.5 py-1 text-[11px] font-medium bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40 transition-colors">
              Aprobar ({selectedGoals.size})
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-0 mt-3 border-b border-zinc-800 -mb-px">
          {TABS.map(({ key, label, badge }) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-[11px] font-mono border-b-2 transition-colors relative ${
                tab === key ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-zinc-600 hover:text-zinc-400'
              }`}>
              {label}
              {badge !== undefined && (
                <span className="ml-1 text-[9px] text-zinc-700">({badge})</span>
              )}
              {key === 'goals' && (pendingHumanTasks.length > 0 || pendingMerges.length > 0) && (
                <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-orange-500" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'diagram' && (
          <div className="p-4">
            <AgentFlowDiagram
              agents={agents}
              sessionId={session.id}
              orgToken={orgToken ?? ''}
              sessionStatus={session.status}
            />

            {/* Steer input below diagram */}
            {['running', 'paused'].includes(session.status) && (
              <form onSubmit={handleSteer} className="mt-4 flex gap-2">
                <input
                  type="text"
                  value={steerText}
                  onChange={(e) => setSteerText(e.target.value)}
                  placeholder="Instrucción al equipo (mid-loop steer)…"
                  className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                />
                <button type="submit" disabled={!steerText.trim()}
                  className="rounded border border-zinc-700 px-3 py-2 text-zinc-400 hover:text-cyan-400 hover:border-cyan-500/40 disabled:opacity-40 transition-colors">
                  <Send className="h-3.5 w-3.5" />
                </button>
              </form>
            )}
          </div>
        )}

        {tab === 'goals' && (
          <div className="p-4 space-y-3">
            <HumanTaskPanel tasks={pendingHumanTasks} onUpdated={refresh} />
            <MergeProposalPanel proposals={proposals} onUpdated={refresh} />

            {goals.map((goal) => (
              <div key={goal.id} className="relative"
                onClick={() => {
                  if (session.status === 'awaiting_goals_approval') {
                    setSelectedGoals((s) => {
                      const n = new Set(s); n.has(goal.id) ? n.delete(goal.id) : n.add(goal.id); return n;
                    });
                  }
                }}>
                {session.status === 'awaiting_goals_approval' && (
                  <div className={`absolute left-2 top-3.5 z-10 h-3 w-3 rounded border ${
                    selectedGoals.has(goal.id) ? 'border-cyan-500 bg-cyan-500' : 'border-zinc-700 bg-zinc-900'
                  }`} />
                )}
                <div className={session.status === 'awaiting_goals_approval' ? 'pl-7' : ''}>
                  <GoalCard goal={goal} isSelected={goal.id === session.current_goal_id} onValidated={refresh} />
                </div>
              </div>
            ))}
            {goals.length === 0 && (
              <p className="text-xs text-zinc-700 text-center py-8">
                {['planning', 'idea_intake'].includes(session.status) ? 'Generando goals…' : 'Sin goals'}
              </p>
            )}
          </div>
        )}

        {tab === 'timeline' && (
          <div className="p-4">
            <SessionTimeline events={events} />
          </div>
        )}

        {tab === 'tasks' && (
          <div className="p-4">
            <StudioTasksTab sessionId={session.id} />
          </div>
        )}
      </div>

      {/* Branch footer */}
      {session.session_branch && (
        <div className="shrink-0 border-t border-zinc-800 px-5 py-2 flex items-center gap-2">
          <GitBranch className="h-3 w-3 text-zinc-700" />
          <span className="text-[10px] font-mono text-zinc-700">{session.session_branch}</span>
        </div>
      )}
    </div>
  );
}

function StudioTasksTab({ sessionId }: { sessionId: string }) {
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    devStudioApi.listTasks(sessionId).then(setTasks);
  }, [sessionId]);

  const STATUS_COLOR: Record<string, string> = {
    queued:       'text-zinc-500 border-zinc-800',
    assigned:     'text-cyan-400 border-cyan-500/20',
    running:      'text-amber-400 border-amber-500/20',
    needs_review: 'text-purple-400 border-purple-500/20',
    approved:     'text-emerald-400 border-emerald-500/20',
    merged:       'text-emerald-400 border-emerald-500/20',
    failed:       'text-red-400 border-red-500/20',
    cancelled:    'text-zinc-700 border-zinc-800',
  };

  return (
    <div className="space-y-1.5">
      {tasks.map((t) => (
        <div key={t.id as string} className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-zinc-200 truncate">{t.title as string}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-mono text-zinc-600">{t.role as string}</span>
              {Boolean(t.branch_name) && (
                <span className="text-[10px] font-mono text-zinc-700 truncate">{t.branch_name as string}</span>
              )}
            </div>
          </div>
          <span className={`text-[10px] font-mono border rounded px-1.5 py-0.5 ${STATUS_COLOR[t.status as string] ?? 'text-zinc-600 border-zinc-800'}`}>
            {t.status as string}
          </span>
        </div>
      ))}
      {tasks.length === 0 && (
        <p className="text-xs text-zinc-700 text-center py-8">Sin tareas técnicas</p>
      )}
    </div>
  );
}
