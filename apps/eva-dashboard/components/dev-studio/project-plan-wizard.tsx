'use client';

import { useState, useCallback, useId } from 'react';
import {
  Sparkles, Loader2, X, Plus, Trash2, ChevronRight,
  Target, Users, Zap, Code2, Check, Pencil,
} from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { ProjectPlan, PlanGoal, PlanSuccessCriterion } from '@/lib/dev-studio-types';
import { TEAM_TIER_AGENTS, AGENT_ROLE_EMOJI } from '@/lib/dev-studio-types';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EditableGoal extends PlanGoal {
  _id: string;
  criteria: Array<PlanSuccessCriterion & { _id: string }>;
}

interface EditablePlan {
  northStar: string;
  teamTier: 'small' | 'medium' | 'large';
  teamTierReason: string;
  agents: string[];
  goals: EditableGoal[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_NAMES: Record<string, string> = {
  project_manager: 'Project Manager',
  architect: 'Arquitecto',
  backend: 'Backend',
  frontend: 'Frontend',
  full_stack: 'Full Stack',
  testing: 'Testing',
  deployment: 'Deployment',
  reviewer: 'Reviewer',
};

const AGENT_RATIONALE: Record<string, string> = {
  project_manager: 'Coordina el equipo y valida que se cumplan los objetivos',
  architect: 'Diseña la arquitectura y toma decisiones técnicas',
  backend: 'Implementa APIs, base de datos y lógica de negocio',
  frontend: 'Construye la interfaz y la experiencia de usuario',
  full_stack: 'Desarrolla frontend + backend en un solo ciclo agéntico',
  testing: 'Escribe y ejecuta tests automatizados de regresión',
  deployment: 'Gestiona CI/CD y el despliegue a producción',
  reviewer: 'Revisa el código antes de fusionar cambios a main',
};

const TIER_LABEL: Record<string, { label: string; color: string }> = {
  small: { label: 'Proyecto pequeño', color: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5' },
  medium: { label: 'Proyecto mediano', color: 'text-amber-400 border-amber-500/20 bg-amber-500/5' },
  large: { label: 'Proyecto grande', color: 'text-red-400 border-red-500/20 bg-red-500/5' },
};

const ANALYZING_MESSAGES = [
  'Analizando complejidad del proyecto…',
  'Calculando equipo mínimo necesario…',
  'Generando objetivos medibles…',
  'Definiendo criterios de validación…',
];

// ── Helper ────────────────────────────────────────────────────────────────────

let _uid = 0;
const uid = () => `w-${++_uid}`;

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[áàäâ]/g, 'a').replace(/[éèëê]/g, 'e').replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o').replace(/[úùüû]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function planToEditable(plan: ProjectPlan): EditablePlan {
  return {
    northStar: plan.northStar,
    teamTier: plan.teamTier,
    teamTierReason: plan.teamTierReason,
    agents: TEAM_TIER_AGENTS[plan.teamTier] ?? ['project_manager', 'full_stack'],
    goals: plan.goals.map((g, gi) => ({
      ...g,
      _id: uid(),
      criteria: (g.successCriteria ?? []).map((c, ci) => ({
        ...c,
        id: c.id ?? `sc-${gi}-${ci}`,
        _id: uid(),
      })),
    })),
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InlineEdit({
  value, onChange, className, placeholder,
}: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }}
        placeholder={placeholder}
        className={cn(
          'bg-transparent border-b border-cyan-500/40 focus:outline-none text-cyan-300',
          className,
        )}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn('group flex items-center gap-1 hover:text-cyan-300 transition-colors text-left', className)}
    >
      <span>{value || placeholder}</span>
      <Pencil className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
    </button>
  );
}

// ── Main Wizard Component ─────────────────────────────────────────────────────

interface ProjectPlanWizardProps {
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function ProjectPlanWizard({ onCreated, onCancel }: ProjectPlanWizardProps) {
  const [step, setStep] = useState<'describe' | 'analyzing' | 'review'>('describe');
  const [description, setDescription] = useState('');
  const [analyzingMsg, setAnalyzingMsg] = useState(0);
  const [plan, setPlan] = useState<EditablePlan | null>(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [repoName, setRepoName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const msgIntervalRef = { current: null as ReturnType<typeof setInterval> | null };

  // ── Step 1 → 2: analyze ────────────────────────────────────────────────────

  async function handleAnalyze(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setError(null);
    setStep('analyzing');

    msgIntervalRef.current = setInterval(() => {
      setAnalyzingMsg((m) => (m + 1) % ANALYZING_MESSAGES.length);
    }, 1400);

    try {
      const result = await devStudioApi.planSession(description.trim());
      const editable = planToEditable(result);
      setPlan(editable);
      const suggested = description.split(/[\n.!?]/)[0].slice(0, 80).trim();
      setProjectTitle(suggested || 'Mi proyecto');
      setRepoName(slugify(suggested || 'mi-proyecto'));
      setStep('review');
    } catch (err) {
      setError((err as Error).message ?? 'Error al analizar el proyecto. Intenta de nuevo.');
      setStep('describe');
    } finally {
      if (msgIntervalRef.current) clearInterval(msgIntervalRef.current);
    }
  }

  // ── Step 3 → create session ────────────────────────────────────────────────

  async function handleCreate() {
    if (!plan || creating) return;
    setCreating(true);
    try {
      const goals = plan.goals.map((g) => ({
        title: g.title,
        description: g.description,
        priority: g.priority,
        successCriteria: g.criteria.map((c) => ({
          id: c.id,
          description: c.description,
          verifiable: c.verifiable,
        })),
      }));

      const session = await devStudioApi.createSession({
        prompt: description,
        title: projectTitle,
        preplan: {
          northStar: plan.northStar,
          teamTier: plan.teamTier,
          teamTierReason: plan.teamTierReason,
          goals,
          autoApprove: true,
        },
      });
      onCreated(session.id);
    } catch (err) {
      setError((err as Error).message ?? 'Error al crear el proyecto.');
    } finally {
      setCreating(false);
    }
  }

  // ── Goal helpers ───────────────────────────────────────────────────────────

  const updateGoalTitle = (id: string, title: string) =>
    setPlan((p) => p && { ...p, goals: p.goals.map((g) => g._id === id ? { ...g, title } : g) });

  const updateGoalDesc = (id: string, description: string) =>
    setPlan((p) => p && { ...p, goals: p.goals.map((g) => g._id === id ? { ...g, description } : g) });

  const removeGoal = (id: string) =>
    setPlan((p) => p && { ...p, goals: p.goals.filter((g) => g._id !== id) });

  const addGoal = () =>
    setPlan((p) => p && {
      ...p,
      goals: [...p.goals, {
        _id: uid(), title: 'Nuevo objetivo', description: '', priority: 50,
        successCriteria: [], criteria: [],
      }],
    });

  const updateCriterion = (goalId: string, cId: string, description: string) =>
    setPlan((p) => p && {
      ...p,
      goals: p.goals.map((g) => g._id !== goalId ? g : {
        ...g,
        criteria: g.criteria.map((c) => c._id === cId ? { ...c, description } : c),
      }),
    });

  const removeCriterion = (goalId: string, cId: string) =>
    setPlan((p) => p && {
      ...p,
      goals: p.goals.map((g) => g._id !== goalId ? g : {
        ...g, criteria: g.criteria.filter((c) => c._id !== cId),
      }),
    });

  const addCriterion = (goalId: string) =>
    setPlan((p) => p && {
      ...p,
      goals: p.goals.map((g) => g._id !== goalId ? g : {
        ...g,
        criteria: [...g.criteria, { _id: uid(), id: uid(), description: '', verifiable: true }],
      }),
    });

  const toggleAgent = (role: string) =>
    setPlan((p) => {
      if (!p) return p;
      const has = p.agents.includes(role);
      if (has && p.agents.filter((a) => a !== 'project_manager').length <= 1) return p;
      return {
        ...p,
        agents: has ? p.agents.filter((a) => a !== role) : [...p.agents, role],
      };
    });

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">

      {/* ── Step indicator ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/80 bg-zinc-950/40">
        {(['describe', 'analyzing', 'review'] as const).map((s, i) => {
          const labels = ['Describir', 'Analizando', 'Revisar plan'];
          const done = step === 'review' && s !== 'review' || step === 'analyzing' && s === 'describe';
          const active = step === s;
          return (
            <div key={s} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-700 shrink-0" />}
              <span className={cn(
                'text-[10px] font-mono uppercase tracking-widest',
                active ? 'text-cyan-400' : done ? 'text-zinc-500' : 'text-zinc-700',
              )}>
                {labels[i]}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Step 1: Describe ──────────────────────────────────────────────── */}
      {step === 'describe' && (
        <form onSubmit={handleAnalyze} className="p-5 space-y-4">
          <div>
            <label className="block text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">
              ¿Qué quieres construir?
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`Describe tu proyecto con el mayor detalle posible.\n\nEj: Un juego de Snake en JavaScript con puntuaciones.\nEj: Una API REST para gestión de inventario con Next.js + Supabase.\nEj: Plataforma SaaS de facturación con Stripe, roles y reportes.`}
              rows={6}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-700 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/40 transition-all"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 font-mono">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!description.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/25 px-4 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-500/25 disabled:opacity-40 transition-all"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Analizar con IA
            </button>
          </div>
        </form>
      )}

      {/* ── Step 2: Analyzing ─────────────────────────────────────────────── */}
      {step === 'analyzing' && (
        <div className="p-8 flex flex-col items-center gap-6">
          <div className="relative">
            <div className="h-12 w-12 rounded-full border border-cyan-500/20 bg-cyan-500/5 flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-cyan-400" />
            </div>
            <Loader2 className="absolute inset-0 h-12 w-12 text-cyan-500/30 animate-spin" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-zinc-200">{ANALYZING_MESSAGES[analyzingMsg]}</p>
            <p className="text-[10px] font-mono text-zinc-600">EVA PM está analizando tu proyecto…</p>
          </div>
          {/* Skeleton cards */}
          <div className="w-full space-y-2.5 mt-2">
            {[90, 70, 80].map((w, i) => (
              <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 animate-pulse">
                <div className={`h-2.5 rounded bg-zinc-800 mb-2`} style={{ width: `${w}%` }} />
                <div className="h-2 rounded bg-zinc-900" style={{ width: `${w - 20}%` }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 3: Review ────────────────────────────────────────────────── */}
      {step === 'review' && plan && (
        <div className="p-5 space-y-5">

          {/* Project title + repo */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                Nombre del proyecto
              </label>
              <InlineEdit
                value={projectTitle}
                onChange={(v) => { setProjectTitle(v); setRepoName(slugify(v)); }}
                placeholder="Nombre del proyecto"
                className="text-sm font-semibold text-zinc-100 w-full"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                Repo sugerido
              </label>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-600 font-mono">github.com/…/</span>
                <InlineEdit
                  value={repoName}
                  onChange={setRepoName}
                  placeholder="nombre-repo"
                  className="text-[11px] font-mono text-cyan-400"
                />
              </div>
            </div>
            <div className="shrink-0 flex items-end pb-0.5">
              <span className={cn(
                'text-[9px] font-mono border rounded px-2 py-0.5',
                TIER_LABEL[plan.teamTier]?.color ?? 'text-zinc-400 border-zinc-700',
              )}>
                {TIER_LABEL[plan.teamTier]?.label ?? plan.teamTier}
              </span>
            </div>
          </div>

          {/* North Star */}
          <div>
            <label className="block text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1.5">
              North Star
            </label>
            <textarea
              value={plan.northStar}
              onChange={(e) => setPlan((p) => p && { ...p, northStar: e.target.value })}
              rows={2}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[12px] text-zinc-300 italic resize-none focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all"
            />
          </div>

          {/* Agents */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest flex items-center gap-1">
                <Users className="h-3 w-3" /> Equipo recomendado ({plan.agents.length} agentes)
              </label>
              <span className="text-[9px] text-zinc-700 font-mono">{plan.teamTierReason}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* Show all possible agents for this tier, plus any extras already selected */}
              {TEAM_TIER_AGENTS[plan.teamTier].map((role) => {
                const active = plan.agents.includes(role);
                const isRequired = role === 'project_manager';
                return (
                  <button
                    key={role}
                    type="button"
                    title={AGENT_RATIONALE[role]}
                    onClick={() => !isRequired && toggleAgent(role)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-medium transition-all',
                      active
                        ? 'border-cyan-500/20 bg-cyan-500/8 text-cyan-300'
                        : 'border-zinc-800 bg-zinc-950/40 text-zinc-600 hover:border-zinc-700',
                      isRequired && 'cursor-default',
                    )}
                  >
                    <span className="text-[13px]">{AGENT_ROLE_EMOJI[role]}</span>
                    <span>{AGENT_NAMES[role]}</span>
                    {active && !isRequired && (
                      <X className="h-2.5 w-2.5 text-zinc-500 hover:text-red-400 ml-0.5" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Goals */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest flex items-center gap-1">
                <Target className="h-3 w-3" /> Objetivos ({plan.goals.length})
              </label>
              <button
                type="button"
                onClick={addGoal}
                className="flex items-center gap-1 text-[9px] text-zinc-600 hover:text-cyan-400 font-mono transition-colors"
              >
                <Plus className="h-2.5 w-2.5" /> agregar objetivo
              </button>
            </div>

            <div className="space-y-3">
              {plan.goals.map((goal, gi) => (
                <div
                  key={goal._id}
                  className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3 space-y-2.5"
                >
                  {/* Goal header */}
                  <div className="flex items-start gap-2">
                    <span className="text-[9px] font-mono text-zinc-700 mt-0.5 shrink-0">
                      {String(gi + 1).padStart(2, '0')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <input
                        value={goal.title}
                        onChange={(e) => updateGoalTitle(goal._id, e.target.value)}
                        className="w-full bg-transparent text-[12px] font-semibold text-zinc-100 focus:outline-none border-b border-transparent focus:border-zinc-700 pb-0.5 transition-colors"
                        placeholder="Título del objetivo"
                      />
                      <input
                        value={goal.description}
                        onChange={(e) => updateGoalDesc(goal._id, e.target.value)}
                        className="w-full mt-1 bg-transparent text-[11px] text-zinc-500 focus:outline-none"
                        placeholder="Descripción breve…"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeGoal(goal._id)}
                      className="shrink-0 p-1 rounded text-zinc-700 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Success criteria ("Go-Alts") */}
                  {(goal.criteria.length > 0 || true) && (
                    <div className="pl-5 space-y-1.5">
                      <p className="text-[8.5px] font-mono text-zinc-700 uppercase tracking-widest mb-1">
                        Criterios de validación
                      </p>
                      {goal.criteria.map((c) => (
                        <div key={c._id} className="flex items-start gap-1.5 group">
                          <Check className="h-2.5 w-2.5 text-emerald-600/50 shrink-0 mt-0.5" />
                          <input
                            value={c.description}
                            onChange={(e) => updateCriterion(goal._id, c._id, e.target.value)}
                            className="flex-1 bg-transparent text-[10px] text-zinc-500 focus:outline-none focus:text-zinc-300 transition-colors"
                            placeholder="Criterio verificable…"
                          />
                          <button
                            type="button"
                            onClick={() => removeCriterion(goal._id, c._id)}
                            className="opacity-0 group-hover:opacity-100 shrink-0 text-zinc-700 hover:text-red-400 transition-all"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addCriterion(goal._id)}
                        className="flex items-center gap-1 text-[9px] text-zinc-700 hover:text-zinc-500 font-mono transition-colors mt-1"
                      >
                        <Plus className="h-2 w-2" /> criterio
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && <p className="text-xs text-red-400 font-mono">{error}</p>}

          {/* Actions */}
          <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
            <button
              type="button"
              onClick={() => { setPlan(null); setStep('describe'); }}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors font-mono"
            >
              ← Volver a editar
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || plan.goals.length === 0}
              className="flex items-center gap-2 rounded-lg bg-cyan-500 px-5 py-2 text-xs font-semibold text-zinc-950 hover:bg-cyan-400 disabled:opacity-40 transition-colors"
            >
              {creating
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Creando…</>
                : <><Zap className="h-3.5 w-3.5" /> Crear proyecto y arrancar</>
              }
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
