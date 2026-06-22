'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { DevAgent, AgentRole, FlowState, FlowHandoff } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';
import { AgentDetailPanel } from './agent-detail-panel';
import { cn } from '@/lib/utils';
import {
  Briefcase,
  Network,
  Database,
  Monitor,
  FlaskConical,
  Rocket,
  Users,
  User,
  Wrench,
  AlertTriangle,
} from 'lucide-react';

// ── Role metadata ─────────────────────────────────────────────────────────────
const ROLE_META: Record<string, { label: string; tier: number; icon: React.ComponentType<{ className?: string }> }> = {
  project_manager: { label: 'Project Manager', tier: 0, icon: Briefcase },
  architect:       { label: 'Architect',        tier: 1, icon: Network   },
  backend:         { label: 'Backend',          tier: 2, icon: Database  },
  frontend:        { label: 'Frontend',         tier: 2, icon: Monitor   },
  full_stack:      { label: 'Full Stack',       tier: 2, icon: Wrench    },
  testing:         { label: 'Testing',          tier: 3, icon: FlaskConical },
  deployment:      { label: 'Deployment',       tier: 3, icon: Rocket    },
  reviewer:        { label: 'Reviewer',         tier: 4, icon: Users     },
  human:           { label: 'Humano',           tier: 5, icon: User      },
};

const ROLE_THEME: Record<string, { color: string; iconBg: string; glow: string; border: string; text: string }> = {
  project_manager: { color: '#10b981', iconBg: 'bg-emerald-500/10 text-emerald-400', glow: 'shadow-[0_0_20px_-3px_rgba(16,185,129,0.3)]',   border: 'border-emerald-500/25', text: 'text-emerald-400' },
  architect:       { color: '#a855f7', iconBg: 'bg-purple-500/10 text-purple-400',   glow: 'shadow-[0_0_20px_-3px_rgba(168,85,247,0.3)]',   border: 'border-purple-500/25',  text: 'text-purple-400'  },
  backend:         { color: '#3b82f6', iconBg: 'bg-blue-500/10 text-blue-400',       glow: 'shadow-[0_0_20px_-3px_rgba(59,130,246,0.3)]',    border: 'border-blue-500/25',    text: 'text-blue-400'    },
  frontend:        { color: '#ec4899', iconBg: 'bg-pink-500/10 text-pink-400',       glow: 'shadow-[0_0_20px_-3px_rgba(236,72,153,0.3)]',    border: 'border-pink-500/25',    text: 'text-pink-400'    },
  full_stack:      { color: '#14b8a6', iconBg: 'bg-teal-500/10 text-teal-400',       glow: 'shadow-[0_0_20px_-3px_rgba(20,184,166,0.3)]',    border: 'border-teal-500/25',    text: 'text-teal-400'    },
  testing:         { color: '#10b981', iconBg: 'bg-emerald-500/10 text-emerald-400', glow: 'shadow-[0_0_20px_-3px_rgba(16,185,129,0.3)]',    border: 'border-emerald-500/25', text: 'text-emerald-400' },
  deployment:      { color: '#f97316', iconBg: 'bg-orange-500/10 text-orange-400',   glow: 'shadow-[0_0_20px_-3px_rgba(249,115,22,0.3)]',    border: 'border-orange-500/25',  text: 'text-orange-400'  },
  reviewer:        { color: '#f59e0b', iconBg: 'bg-amber-500/10 text-amber-400',     glow: 'shadow-[0_0_20px_-3px_rgba(245,158,11,0.3)]',    border: 'border-amber-500/25',   text: 'text-amber-400'   },
  human:           { color: '#2563eb', iconBg: 'bg-blue-500/10 text-blue-400',       glow: 'shadow-[0_0_20px_-3px_rgba(37,99,235,0.3)]',     border: 'border-blue-500/25',    text: 'text-blue-400'    },
};

// ── Dynamic layout computation ────────────────────────────────────────────────
const SVG_W_MIN = 1000;
const SVG_H = 480;
const NODE_W = 176;
const NODE_H = 92;
const COL_GAP = 26;   // minimum horizontal gap between adjacent tier columns
const MARGIN_X = 104; // horizontal inset from the canvas edge to the outer node centers

function computeLayout(visibleRoles: string[]): {
  positions: Record<string, { cx: number; cy: number }>;
  svgW: number;
  svgH: number;
} {
  const tierMap: Record<number, string[]> = {};
  for (const role of visibleRoles) {
    const tier = ROLE_META[role]?.tier ?? 99;
    (tierMap[tier] = tierMap[tier] ?? []).push(role);
  }
  const sortedTiers = Object.keys(tierMap).map(Number).sort((a, b) => a - b);
  const cols = sortedTiers.length;

  const positions: Record<string, { cx: number; cy: number }> = {};

  // Columns = tiers (horizontal), agents within a tier spread vertically.
  // Column spacing is clamped to NODE_W + COL_GAP so two adjacent columns can
  // never overlap; when the team is large the canvas widens (and the whole SVG
  // scales down to fit its container) instead of letting nodes collide.
  const minTierW = NODE_W + COL_GAP;
  const usableW = SVG_W_MIN - MARGIN_X * 2;
  const idealTierW = cols > 1 ? usableW / (cols - 1) : 0;
  const tierW = Math.max(idealTierW, minTierW);
  const svgW = Math.max(SVG_W_MIN, MARGIN_X * 2 + (cols - 1) * tierW);
  const startX = cols > 1 ? (svgW - (cols - 1) * tierW) / 2 : svgW / 2;

  sortedTiers.forEach((tier, idx) => {
    const roles = tierMap[tier];
    const cx = cols > 1 ? startX + idx * tierW : svgW / 2;

    const n = roles.length;
    // Spread vertically: center around SVG_H / 2
    const maxSpread = n > 1 ? Math.min(125, (SVG_H - NODE_H - 60) / (n - 1)) : 0;
    const startY = SVG_H / 2 - (maxSpread * (n - 1)) / 2;

    roles.forEach((role, i) => {
      positions[role] = { cx, cy: startY + i * maxSpread };
    });
  });

  return { positions, svgW, svgH: SVG_H };
}

// ── Edge computation ──────────────────────────────────────────────────────────
// `back` = a reverse/report edge (drawn dashed, curved to the side) so the graph
// reads as bidirectional communication, not a one-way pipeline.
type EdgeDef = { from: string; to: string; label?: string; curved?: boolean; back?: boolean };

function computeEdges(visible: Set<string>, assigner: string): EdgeDef[] {
  const has = (r: string) => visible.has(r);
  const DEV: string[] = ['backend', 'frontend', 'full_stack', 'testing', 'deployment'];
  const edges: EdgeDef[] = [];

  // PM ↔ Architect (bidirectional: assigns work, architect reports back).
  if (has('project_manager') && has('architect')) {
    edges.push({ from: 'project_manager', to: 'architect', label: 'asigna iteración' });
    edges.push({ from: 'architect', to: 'project_manager', back: true, curved: true, label: 'reporta' });
  }

  // The assigner (architect, or PM when there's no architect) → each dev role.
  const devs = DEV.filter(has);
  if (has(assigner)) {
    for (const r of devs) edges.push({ from: assigner, to: r });
    if (devs.length === 0) {
      if (has('reviewer')) edges.push({ from: assigner, to: 'reviewer' });
      else if (has('human')) edges.push({ from: assigner, to: 'human' });
    }
  }

  // Cross-dev collaboration.
  if (has('backend') && has('testing'))      edges.push({ from: 'backend', to: 'testing' });
  if (has('frontend') && has('testing'))     edges.push({ from: 'frontend', to: 'testing' });
  if (has('full_stack') && has('testing'))   edges.push({ from: 'full_stack', to: 'testing' });
  if (has('backend') && has('deployment'))   edges.push({ from: 'backend', to: 'deployment' });
  if (has('full_stack') && has('deployment')) edges.push({ from: 'full_stack', to: 'deployment' });

  // Dev → reviewer or human (whoever closes the loop).
  const exitTarget = has('reviewer') ? 'reviewer' : has('human') ? 'human' : null;
  if (exitTarget) {
    for (const r of DEV) if (has(r) && r !== exitTarget) edges.push({ from: r, to: exitTarget });
  }

  // Reviewer output.
  if (has('reviewer')) {
    if (has('human'))           edges.push({ from: 'reviewer', to: 'human', label: 'feedback' });
    if (has('project_manager')) edges.push({ from: 'reviewer', to: 'project_manager', back: true, curved: true });
  }

  // Deduplicate by from|to.
  const seen = new Set<string>();
  return edges.filter(({ from, to }) => {
    const k = `${from}|${to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function getAdjustedPoints(
  f: { cx: number; cy: number },
  t: { cx: number; cy: number },
  curved?: boolean,
): { sx: number; sy: number; ex: number; ey: number } {
  const halfW = NODE_W / 2; // 88
  const halfH = NODE_H / 2; // 46
  const arrowPadding = 6;

  if (curved) {
    // Reverse edge bows upward: start from top center, end at top center of target
    const sx = f.cx;
    const sy = f.cy - halfH;
    const ex = t.cx;
    const ey = t.cy - halfH - arrowPadding;
    return { sx, sy, ex, ey };
  }

  const dx = t.cx - f.cx;

  // Forward edge (left to right)
  if (dx > 0) {
    const sx = f.cx + halfW;
    const sy = f.cy;
    const ex = t.cx - halfW - arrowPadding;
    const ey = t.cy;
    return { sx, sy, ex, ey };
  } else {
    // Fallback
    const sx = f.cx - halfW;
    const sy = f.cy;
    const ex = t.cx + halfW + arrowPadding;
    const ey = t.cy;
    return { sx, sy, ex, ey };
  }
}

function edgePath(
  f: { cx: number; cy: number },
  t: { cx: number; cy: number },
  curved?: boolean,
): string {
  const { sx, sy, ex, ey } = getAdjustedPoints(f, t, curved);
  if (curved) {
    const bowHeight = 120;
    return `M ${sx} ${sy} C ${sx - 30} ${sy - bowHeight} ${ex + 30} ${ey - bowHeight} ${ex} ${ey}`;
  }
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2 + (ex - sx) * 0.04;
  return `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
}

function labelMidpoint(
  f: { cx: number; cy: number },
  t: { cx: number; cy: number },
  curved?: boolean,
): { x: number; y: number } {
  const { sx, sy, ex, ey } = getAdjustedPoints(f, t, curved);
  if (curved) {
    return { x: (sx + ex) / 2, y: (sy + ey) / 2 - 80 };
  }
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2 + (ex - sx) * 0.04;
  return { x: mx, y: my - 10 };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtAgo(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// ── Component ─────────────────────────────────────────────────────────────────
interface AgentFlowDiagramProps {
  agents: DevAgent[];
  sessionId: string;
  orgToken: string;
  sessionStatus: string;
}

export function AgentFlowDiagram({ agents, sessionId, orgToken, sessionStatus }: AgentFlowDiagramProps) {
  const [selectedRole, setSelectedRole] = useState<AgentRole | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);

  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(sessionStatus);

  // Poll live flow state (current task per agent, last instruction per edge, stuck).
  useEffect(() => {
    let alive = true;
    const load = () => devStudioApi.getFlowState(sessionId).then((f) => { if (alive) setFlow(f); }).catch(() => {});
    load();
    const iv = setInterval(load, isActive ? 3000 : 8000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, isActive]);

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.role, a])), [agents]);
  const flowMap = useMemo(
    () => new Map((flow?.agents ?? []).map((a) => [a.role, a])),
    [flow],
  );
  const handoffMap = useMemo(() => {
    const m = new Map<string, FlowHandoff>();
    for (const h of flow?.handoffs ?? []) m.set(`${h.from}|${h.to}`, h);
    return m;
  }, [flow]);

  const assigner = flow?.assigner ?? (agentMap.has('architect') ? 'architect' : 'project_manager');

  const visibleRoles = useMemo(() => {
    const roles = new Set(['human', ...agents.map((a) => a.role)]);
    return Array.from(roles);
  }, [agents]);

  const visibleSet = useMemo(() => new Set(visibleRoles), [visibleRoles]);

  const { positions, svgW, svgH } = useMemo(() => computeLayout(visibleRoles), [visibleRoles]);
  const edges = useMemo(() => computeEdges(visibleSet, assigner), [visibleSet, assigner]);

  const agentRunning = useCallback((role: string) => {
    if (role === 'human') return true;
    return (agentMap.get(role)?.status ?? 'idle') === 'running';
  }, [agentMap]);

  // Empty state before agents are registered
  if (visibleRoles.length <= 1) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 py-20">
        <div className="text-center space-y-2">
          <div className="text-3xl">🤖</div>
          <p className="text-xs text-zinc-600 font-mono">Los agentes aparecerán cuando empiece la primera iteración</p>
        </div>
      </div>
    );
  }

  const stuck = flow?.stuck ?? null;
  const stuckRole = stuck?.role ?? null;

  return (
    <div className="relative">
      {/* Stuck banner — surfaces exactly where the flow is blocked. */}
      {stuck && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 text-xs">
            <span className="text-amber-300 font-semibold">
              {ROLE_META[stuck.role]?.label ?? stuck.role} — {stuck.reason}
            </span>
            {stuck.sinceMs != null && (
              <span className="text-amber-500/70 ml-1.5 font-mono">hace {fmtAgo(stuck.sinceMs)}</span>
            )}
            {stuck.taskTitle && (
              <p className="text-zinc-400 mt-0.5 truncate">en: {stuck.taskTitle}</p>
            )}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-white/5 bg-[#070a13]/60 backdrop-blur-md overflow-hidden p-2">
        <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ maxHeight: '560px' }}>
          <defs>
            <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L6,3 z" fill="#1e293b" />
            </marker>
            <marker id="arr-on" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L6,3 z" fill="#22d3ee" />
            </marker>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <style>{`
              @keyframes flow { to { stroke-dashoffset: -16; } }
              .flowing { animation: flow 0.8s linear infinite; stroke-dasharray: 6 4; }
            `}</style>
          </defs>

          {/* Outer boundary */}
          <rect x="15" y="16" width={svgW - 30} height={svgH - 32} rx="16"
            fill="none" stroke="#1e293b" strokeWidth="1" strokeDasharray="6 4" opacity="0.3" />

          {/* Dynamic edges */}
          {edges.map(({ from, to, label, curved, back }) => {
            const fp = positions[from];
            const tp = positions[to];
            if (!fp || !tp) return null;
            const handoff = handoffMap.get(`${from}|${to}`);
            const recentMs = handoff?.at ? Date.now() - new Date(handoff.at).getTime() : Infinity;
            const handoffRecent = recentMs < 45_000;
            const active = isActive && (agentRunning(from) || agentRunning(to) || handoffRecent);
            const lp = labelMidpoint(fp, tp, curved);

            // Prefer the real last instruction as the edge label.
            const instruction = handoff?.instruction ? truncate(handoff.instruction, 30) : null;
            const edgeLabel = instruction ?? label;
            const ago = handoff?.at ? fmtAgo(recentMs) : '';
            const pathD = edgePath(fp, tp, curved);

            return (
              <g key={`${from}→${to}`}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={active ? '#22d3ee' : '#1e293b'}
                  strokeWidth={active ? 2 : 1}
                  className={active ? 'flowing' : undefined}
                  markerEnd={active ? 'url(#arr-on)' : 'url(#arr)'}
                  opacity={active ? 0.95 : back ? 0.3 : 0.5}
                  strokeDasharray={back && !active ? '4 3' : undefined}
                  filter={active ? 'url(#glow)' : undefined}
                />
                {active && (
                  <g filter="url(#glow)">
                    <circle r="4.5" fill="#ffffff">
                      <animateMotion dur="2.5s" repeatCount="indefinite" path={pathD} />
                    </circle>
                  </g>
                )}
                {edgeLabel && (
                  <g>
                    {instruction && (
                      <title>{`${handoff?.from} → ${handoff?.to}: ${handoff?.instruction}${ago ? ` (hace ${ago})` : ''}`}</title>
                    )}
                    <text x={lp.x} y={lp.y} textAnchor="middle" fontSize="9.5"
                      fill={active ? '#67e8f9' : '#64748b'} className="select-none font-mono">
                      {edgeLabel}
                    </text>
                    {instruction && ago && (
                      <text x={lp.x} y={lp.y + 11} textAnchor="middle" fontSize="8"
                        fill="#475569" className="select-none font-mono">
                        hace {ago}
                      </text>
                    )}
                  </g>
                )}
              </g>
            );
          })}

          {/* Dynamic nodes */}
          {visibleRoles.map((id) => {
            const pos = positions[id];
            if (!pos) return null;
            const { cx, cy } = pos;
            const meta = ROLE_META[id];
            if (!meta) return null;
            const IconComponent = meta.icon;
            const theme = ROLE_THEME[id] ?? ROLE_THEME.backend!;
            const agent = agentMap.get(id);
            const fstate = flowMap.get(id);
            const status = id === 'human' ? 'active' : (agent?.status ?? 'idle');
            const isWorking = agentRunning(id);
            const isBlocked = status === 'blocked';
            const isStuck = stuckRole === id;
            const selected = selectedRole === id;
            const clickable = id !== 'human';

            const displayStatus = id === 'human' ? 'Activo'
              : status === 'running' ? 'Trabajando'
              : status === 'blocked' ? 'Bloqueado'
              : status === 'completed' ? 'Completado'
              : status === 'failed' ? 'Fallido'
              : 'En espera';

            const taskTitle = id === 'human' ? null : fstate?.currentTaskTitle ?? null;

            let borderClass = 'border-zinc-800/80';
            let textStatusClass = 'text-zinc-500';
            if (isStuck) { borderClass = 'border-amber-500/50'; textStatusClass = 'text-amber-400'; }
            else if (id === 'human') { borderClass = 'border-blue-500/25'; textStatusClass = 'text-emerald-400'; }
            else if (isWorking) { borderClass = theme.border; textStatusClass = theme.text; }
            else if (isBlocked) { borderClass = 'border-red-500/25'; textStatusClass = 'text-red-400'; }
            else if (status === 'completed') { borderClass = 'border-emerald-500/20'; textStatusClass = 'text-emerald-500'; }

            return (
              <g key={id} transform={`translate(${cx}, ${cy})`}>
                {isWorking && (
                  <g>
                    {/* Inner glowing pulse outline */}
                    <rect
                      x={-NODE_W / 2 - 5}
                      y={-NODE_H / 2 - 5}
                      width={NODE_W + 10}
                      height={NODE_H + 10}
                      rx="16"
                      fill="none"
                      stroke={theme.color}
                      strokeWidth="2"
                      opacity="0.6"
                    >
                      <animate attributeName="opacity" values="0.7;0.2;0.7" dur="2s" repeatCount="indefinite" />
                      <animate attributeName="stroke-width" values="1.5;4;1.5" dur="2s" repeatCount="indefinite" />
                    </rect>
                    {/* Expanding outer ripple */}
                    <rect
                      x={-NODE_W / 2 - 5}
                      y={-NODE_H / 2 - 5}
                      width={NODE_W + 10}
                      height={NODE_H + 10}
                      rx="16"
                      fill="none"
                      stroke={theme.color}
                      strokeWidth="1"
                      opacity="0.2"
                    >
                      <animate attributeName="width" values={`${NODE_W + 10};${NODE_W + 28};${NODE_W + 10}`} dur="2s" repeatCount="indefinite" />
                      <animate attributeName="height" values={`${NODE_H + 10};${NODE_H + 28};${NODE_H + 10}`} dur="2s" repeatCount="indefinite" />
                      <animate attributeName="x" values={`${-NODE_W / 2 - 5};${-NODE_W / 2 - 14};${-NODE_W / 2 - 5}`} dur="2s" repeatCount="indefinite" />
                      <animate attributeName="y" values={`${-NODE_H / 2 - 5};${-NODE_H / 2 - 14};${-NODE_H / 2 - 5}`} dur="2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" repeatCount="indefinite" />
                    </rect>
                  </g>
                )}
                <foreignObject
                  x={-NODE_W / 2}
                  y={-NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  className="overflow-visible"
                >
                  <div
                    onClick={() => clickable && setSelectedRole(selected ? null : id as AgentRole)}
                    className={cn(
                      'relative flex flex-col rounded-xl border bg-[#090d16]/95 p-2.5 shadow-lg backdrop-blur-md transition-all select-none h-full',
                      clickable ? 'cursor-pointer' : '',
                      borderClass,
                      selected ? 'ring-1 ring-cyan-400 border-cyan-400' : 'hover:border-zinc-700',
                      isWorking ? theme.glow : '',
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform',
                        id === 'human' ? 'bg-blue-500/10 text-blue-400' : theme.iconBg,
                        selected ? 'scale-95' : '',
                      )}>
                        <IconComponent className="h-[18px] w-[18px]" />
                      </div>
                      <div className="flex flex-col min-w-0 leading-tight flex-1">
                        <span className="text-[11px] font-semibold text-zinc-100 truncate">{meta.label}</span>
                        <span className={cn('text-[9px] font-medium font-mono mt-0.5 flex items-center gap-1', textStatusClass)}>
                          {displayStatus}
                          {isStuck && fstate?.stuckMs != null && (
                            <span className="text-amber-500/80">· ⏱ {fmtAgo(fstate.stuckMs)}</span>
                          )}
                        </span>
                      </div>
                    </div>
                    {/* Current task — what this agent is working on right now. */}
                    {taskTitle ? (
                      <div className="mt-1.5 flex items-start gap-1 border-t border-zinc-800/70 pt-1">
                        <span className={cn('mt-1 h-1 w-1 rounded-full shrink-0', isWorking ? 'bg-cyan-400' : 'bg-zinc-600')} />
                        <span className="text-[9px] text-zinc-400 leading-snug line-clamp-2" title={taskTitle}>
                          {taskTitle}
                        </span>
                      </div>
                    ) : id !== 'human' ? (
                      <div className="mt-1.5 border-t border-zinc-800/70 pt-1">
                        <span className="text-[9px] text-zinc-600 italic">sin tarea asignada</span>
                      </div>
                    ) : null}
                    {isBlocked && (
                      <div className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-950 border border-red-500/30 text-[9px] shadow-sm">
                        🔒
                      </div>
                    )}
                    {isWorking && (
                      <div className="absolute -top-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-cyan-950 border border-cyan-500/50 shadow-[0_0_8px_rgba(34,211,238,0.5)] animate-fade-in">
                        <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                      </div>
                    )}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-3 text-center">
        <p className="text-[10px] text-zinc-500 font-mono tracking-wide">
          Las flechas muestran la última instrucción entre agentes · clic en un agente → tareas · logs · terminal
        </p>
      </div>

      {selectedRole && (
        <AgentDetailPanel
          sessionId={sessionId}
          role={selectedRole}
          orgToken={orgToken}
          onClose={() => setSelectedRole(null)}
        />
      )}
    </div>
  );
}
