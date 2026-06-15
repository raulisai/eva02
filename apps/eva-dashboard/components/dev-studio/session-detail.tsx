'use client';

import { useState, useEffect, useCallback } from 'react';
import { Play, Pause, X, Send, RefreshCw, GitBranch } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type {
  DevSession, DevGoal, DevHumanTask, DevAgent,
  DevMergeProposal, DevEvent, DevIteration,
} from '@/lib/dev-studio-types';
import { SESSION_STATUS_LABEL } from '@/lib/dev-studio-types';
import { SessionStatusBadge } from './session-status-badge';
import { GoalCard } from './goal-card';
import { HumanTaskPanel } from './human-task-panel';
import { AgentTeam } from './agent-team';
import { SessionTimeline } from './session-timeline';
import { MergeProposalPanel } from './merge-proposal-panel';

interface SessionDetailProps {
  session: DevSession;
  onUpdate?: (s: DevSession) => void;
}

export function SessionDetail({ session: initial, onUpdate }: SessionDetailProps) {
  const [session, setSession] = useState<DevSession>(initial);
  const [goals, setGoals] = useState<DevGoal[]>([]);
  const [humanTasks, setHumanTasks] = useState<DevHumanTask[]>([]);
  const [agents, setAgents] = useState<DevAgent[]>([]);
  const [proposals, setProposals] = useState<DevMergeProposal[]>([]);
  const [events, setEvents] = useState<DevEvent[]>([]);
  const [iterations, setIterations] = useState<DevIteration[]>([]);
  const [tab, setTab] = useState<'overview' | 'timeline' | 'tasks'>('overview');
  const [steerText, setSteerText] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedGoals, setSelectedGoals] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const [g, ht, ag, mp, ev, it] = await Promise.all([
      devStudioApi.listGoals(session.id),
      devStudioApi.listHumanTasks(session.id),
      devStudioApi.listAgents(session.id),
      devStudioApi.listMergeProposals(session.id),
      devStudioApi.listEvents(session.id, 50),
      devStudioApi.listIterations(session.id),
    ]);
    setGoals(g);
    setHumanTasks(ht);
    setAgents(ag);
    setProposals(mp);
    setEvents(ev);
    setIterations(it);

    const updated = await devStudioApi.getSession(session.id);
    setSession(updated);
    onUpdate?.(updated);
  }, [session.id, onUpdate]);

  useEffect(() => {
    refresh();
    // Poll every 8 seconds while session is active
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
        if (!confirm('¿Cancelar esta sesión de desarrollo?')) return;
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

  const pendingHumanTasks = humanTasks.filter((t) => ['pending', 'waiting_user', 'submitted'].includes(t.status));
  const pendingMerges = proposals.filter((p) => p.status === 'pending');
  const currentIteration = iterations.find((i) => i.id === session.current_iteration_id);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-lg font-semibold text-slate-900 truncate">{session.title}</h1>
              <SessionStatusBadge status={session.status} />
            </div>
            {session.north_star && (
              <p className="mt-1 text-sm text-slate-600 italic">"{session.north_star}"</p>
            )}
            {currentIteration && (
              <p className="mt-1 text-xs text-slate-400">
                {currentIteration.title} — {currentIteration.objective.slice(0, 100)}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={refresh}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              title="Refrescar"
            >
              <RefreshCw className="h-4 w-4" />
            </button>

            {session.status === 'idea_intake' && (
              <button
                onClick={() => handleAction('start')}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                Iniciar
              </button>
            )}
            {session.status === 'running' && (
              <button
                onClick={() => handleAction('pause')}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Pause className="h-3.5 w-3.5" />
                Pausar
              </button>
            )}
            {session.status === 'paused' && (
              <button
                onClick={() => handleAction('resume')}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                Reanudar
              </button>
            )}
            {!['completed', 'cancelled', 'failed'].includes(session.status) && (
              <button
                onClick={() => handleAction('cancel')}
                disabled={loading}
                className="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50"
                title="Cancelar sesión"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4 border-b border-slate-100">
          {(['overview', 'timeline', 'tasks'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                tab === t
                  ? 'border-blue-500 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === 'overview' ? 'Resumen' : t === 'timeline' ? 'Timeline' : 'Tareas'}
              {t === 'overview' && pendingHumanTasks.length > 0 && (
                <span className="ml-1.5 rounded-full bg-orange-500 text-white text-xs px-1.5">
                  {pendingHumanTasks.length}
                </span>
              )}
              {t === 'overview' && pendingMerges.length > 0 && (
                <span className="ml-1.5 rounded-full bg-blue-500 text-white text-xs px-1.5">
                  {pendingMerges.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {tab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main column */}
            <div className="lg:col-span-2 space-y-6">
              {/* Goals approval banner */}
              {session.status === 'awaiting_goals_approval' && goals.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-amber-800">
                      Selecciona los goals a aprobar
                    </p>
                    <button
                      onClick={handleApproveGoals}
                      disabled={loading || selectedGoals.size === 0}
                      className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      Aprobar seleccionados ({selectedGoals.size})
                    </button>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => setSelectedGoals(new Set<string>(goals.map((g) => g.id)))} className="text-blue-600 hover:underline">
                      Seleccionar todos
                    </button>
                    <span className="text-slate-400">·</span>
                    <button onClick={() => setSelectedGoals(new Set())} className="text-slate-500 hover:underline">
                      Limpiar
                    </button>
                  </div>
                </div>
              )}

              {/* Goals */}
              {goals.length > 0 && (
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-slate-700">
                    Goals ({goals.length})
                  </h2>
                  {goals.map((goal) => (
                    <div
                      key={goal.id}
                      className="relative"
                      onClick={() => {
                        if (session.status === 'awaiting_goals_approval') {
                          setSelectedGoals((s) => {
                            const n = new Set(s);
                            n.has(goal.id) ? n.delete(goal.id) : n.add(goal.id);
                            return n;
                          });
                        }
                      }}
                    >
                      {session.status === 'awaiting_goals_approval' && (
                        <div className={`absolute left-2 top-4 z-10 h-4 w-4 rounded border-2 ${
                          selectedGoals.has(goal.id)
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-slate-300 bg-white'
                        }`} />
                      )}
                      <div className={session.status === 'awaiting_goals_approval' ? 'pl-8' : ''}>
                        <GoalCard
                          goal={goal}
                          isSelected={goal.id === session.current_goal_id}
                          onValidated={refresh}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Human tasks */}
              <HumanTaskPanel tasks={pendingHumanTasks} onUpdated={refresh} />

              {/* Merge proposals */}
              <MergeProposalPanel proposals={proposals} onUpdated={refresh} />

              {/* Steer session */}
              {['running', 'paused'].includes(session.status) && (
                <form onSubmit={handleSteer} className="space-y-2">
                  <label className="text-xs font-medium text-slate-500">
                    Dar instrucción al equipo (mid-loop steer)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={steerText}
                      onChange={(e) => setSteerText(e.target.value)}
                      placeholder="Ej: Cambia el stack de auth a NextAuth…"
                      className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                    <button
                      type="submit"
                      disabled={!steerText.trim()}
                      className="rounded-lg bg-slate-800 px-3 py-2 text-white hover:bg-slate-900 disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Team */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Equipo</h3>
                <AgentTeam agents={agents} />
              </div>

              {/* Branch info */}
              {session.session_branch && (
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <GitBranch className="h-4 w-4" />
                    <span className="font-mono text-xs">{session.session_branch}</span>
                  </div>
                </div>
              )}

              {/* Recent events snippet */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-700">Actividad reciente</h3>
                  <button
                    onClick={() => setTab('timeline')}
                    className="text-xs text-blue-500 hover:underline"
                  >
                    Ver todo
                  </button>
                </div>
                <SessionTimeline events={events.slice(0, 8)} />
              </div>
            </div>
          </div>
        )}

        {tab === 'timeline' && (
          <div className="max-w-2xl">
            <SessionTimeline events={events} />
          </div>
        )}

        {tab === 'tasks' && (
          <StudioTasksTab sessionId={session.id} />
        )}
      </div>
    </div>
  );
}

function StudioTasksTab({ sessionId }: { sessionId: string }) {
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    devStudioApi.listTasks(sessionId).then(setTasks);
  }, [sessionId]);

  const STATUS_COLOR: Record<string, string> = {
    queued: 'bg-slate-100 text-slate-600',
    assigned: 'bg-blue-100 text-blue-700',
    running: 'bg-amber-100 text-amber-700',
    needs_review: 'bg-purple-100 text-purple-700',
    approved: 'bg-emerald-100 text-emerald-700',
    merged: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-slate-100 text-slate-500',
  };

  return (
    <div className="space-y-2">
      {tasks.map((t) => (
        <div key={t.id as string} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{t.title as string}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-slate-400">{t.role as string}</span>
              {(t.branch_name as string) && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="text-xs font-mono text-slate-400 truncate">{t.branch_name as string}</span>
                </>
              )}
            </div>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[t.status as string] ?? 'bg-slate-100 text-slate-600'}`}>
            {t.status as string}
          </span>
        </div>
      ))}
      {tasks.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-8">No hay tareas técnicas aún</p>
      )}
    </div>
  );
}
