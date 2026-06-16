'use client';

import { useState, useCallback, useMemo } from 'react';
import type { DevAgent, AgentRole } from '@/lib/dev-studio-types';
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
} from 'lucide-react';

// ── Role metadata ─────────────────────────────────────────────────────────────
const ROLE_META: Record<string, { label: string; tier: number; icon: React.ComponentType<{ className?: string }> }> = {
  project_manager: { label: 'Project Manager', tier: 0, icon: Briefcase },
  architect:       { label: 'Architect',        tier: 1, icon: Network   },
  backend:         { label: 'Backend',          tier: 2, icon: Database  },
  frontend:        { label: 'Frontend',         tier: 2, icon: Monitor   },
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
  testing:         { color: '#10b981', iconBg: 'bg-emerald-500/10 text-emerald-400', glow: 'shadow-[0_0_20px_-3px_rgba(16,185,129,0.3)]',    border: 'border-emerald-500/25', text: 'text-emerald-400' },
  deployment:      { color: '#f97316', iconBg: 'bg-orange-500/10 text-orange-400',   glow: 'shadow-[0_0_20px_-3px_rgba(249,115,22,0.3)]',    border: 'border-orange-500/25',  text: 'text-orange-400'  },
  reviewer:        { color: '#f59e0b', iconBg: 'bg-amber-500/10 text-amber-400',     glow: 'shadow-[0_0_20px_-3px_rgba(245,158,11,0.3)]',    border: 'border-amber-500/25',   text: 'text-amber-400'   },
  human:           { color: '#2563eb', iconBg: 'bg-blue-500/10 text-blue-400',       glow: 'shadow-[0_0_20px_-3px_rgba(37,99,235,0.3)]',     border: 'border-blue-500/25',    text: 'text-blue-400'    },
};

// ── Dynamic layout computation ────────────────────────────────────────────────
const SVG_W = 1000;
const TIER_H = 152;
const START_Y = 72;
const NODE_W = 170;
const NODE_H = 64;

function computeLayout(visibleRoles: string[]): {
  positions: Record<string, { cx: number; cy: number }>;
  svgH: number;
} {
  const tierMap: Record<number, string[]> = {};
  for (const role of visibleRoles) {
    const tier = ROLE_META[role]?.tier ?? 99;
    (tierMap[tier] = tierMap[tier] ?? []).push(role);
  }
  const sortedTiers = Object.keys(tierMap).map(Number).sort((a, b) => a - b);
  const svgH = START_Y + sortedTiers.length * TIER_H + 56;

  const positions: Record<string, { cx: number; cy: number }> = {};
  sortedTiers.forEach((tier, idx) => {
    const roles = tierMap[tier];
    const cy = START_Y + idx * TIER_H + TIER_H / 2;
    const n = roles.length;
    const maxSpread = n > 1 ? Math.min(280, (SVG_W - NODE_W - 80) / (n - 1)) : 0;
    const startX = SVG_W / 2 - maxSpread * (n - 1) / 2;
    roles.forEach((role, i) => {
      positions[role] = { cx: startX + i * maxSpread, cy };
    });
  });

  return { positions, svgH };
}

// ── Edge computation ──────────────────────────────────────────────────────────
type EdgeDef = { from: string; to: string; label?: string; curved?: boolean };

function computeEdges(visible: Set<string>): EdgeDef[] {
  const has = (r: string) => visible.has(r);
  const EXEC: string[] = ['backend', 'frontend', 'testing', 'deployment'];
  const edges: EdgeDef[] = [];

  // PM → first subordinate tier
  if (has('project_manager')) {
    if (has('architect')) {
      edges.push({ from: 'project_manager', to: 'architect', label: 'asigna' });
    } else {
      const direct = EXEC.filter(has);
      if (direct.length > 0) {
        for (const r of direct) edges.push({ from: 'project_manager', to: r });
      } else if (has('reviewer')) {
        edges.push({ from: 'project_manager', to: 'reviewer' });
      } else if (has('human')) {
        edges.push({ from: 'project_manager', to: 'human' });
      }
    }
  }

  // Architect → execution or reviewer/human
  if (has('architect')) {
    const execUnder = EXEC.filter(has);
    if (execUnder.length > 0) {
      for (const r of execUnder) edges.push({ from: 'architect', to: r });
    } else if (has('reviewer')) {
      edges.push({ from: 'architect', to: 'reviewer' });
    } else if (has('human')) {
      edges.push({ from: 'architect', to: 'human' });
    }
  }

  // Cross-execution
  if (has('backend') && has('testing'))    edges.push({ from: 'backend', to: 'testing' });
  if (has('frontend') && has('testing'))   edges.push({ from: 'frontend', to: 'testing' });
  if (has('backend') && has('deployment')) edges.push({ from: 'backend', to: 'deployment' });

  // Execution → reviewer or human
  const exitTarget = has('reviewer') ? 'reviewer' : has('human') ? 'human' : null;
  if (exitTarget) {
    for (const r of EXEC) {
      if (has(r)) edges.push({ from: r, to: exitTarget });
    }
  }

  // Reviewer output
  if (has('reviewer')) {
    if (has('human'))           edges.push({ from: 'reviewer', to: 'human', label: 'feedback' });
    if (has('project_manager')) edges.push({ from: 'reviewer', to: 'project_manager', curved: true });
  }

  // Deduplicate
  const seen = new Set<string>();
  return edges.filter(({ from, to }) => {
    const k = `${from}|${to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function edgePath(
  f: { cx: number; cy: number },
  t: { cx: number; cy: number },
  curved?: boolean,
): string {
  if (curved) {
    return `M ${f.cx} ${f.cy} C ${f.cx + 260} ${f.cy} ${t.cx + 260} ${t.cy} ${t.cx} ${t.cy}`;
  }
  const mx = (f.cx + t.cx) / 2;
  const my = (f.cy + t.cy) / 2 - Math.abs(t.cx - f.cx) * 0.05;
  return `M ${f.cx} ${f.cy} Q ${mx} ${my} ${t.cx} ${t.cy}`;
}

function labelMidpoint(
  f: { cx: number; cy: number },
  t: { cx: number; cy: number },
  curved?: boolean,
): { x: number; y: number } {
  if (curved) return { x: f.cx + 200, y: (f.cy + t.cy) / 2 };
  return { x: (f.cx + t.cx) / 2, y: (f.cy + t.cy) / 2 - 10 };
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

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.role, a])), [agents]);

  const visibleRoles = useMemo(() => {
    const roles = new Set(['human', ...agents.map((a) => a.role)]);
    return Array.from(roles);
  }, [agents]);

  const visibleSet = useMemo(() => new Set(visibleRoles), [visibleRoles]);

  const { positions, svgH } = useMemo(() => computeLayout(visibleRoles), [visibleRoles]);
  const edges = useMemo(() => computeEdges(visibleSet), [visibleSet]);

  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(sessionStatus);

  const agentRunning = useCallback((role: string) => {
    if (role === 'human') return true;
    return (agentMap.get(role)?.status ?? 'idle') === 'running';
  }, [agentMap]);

  const edgeActive = useCallback((from: string, to: string) =>
    isActive && (agentRunning(from) || agentRunning(to)),
    [isActive, agentRunning],
  );

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

  return (
    <div className="relative">
      <div className="rounded-2xl border border-white/5 bg-[#070a13]/60 backdrop-blur-md overflow-hidden p-2">
        <svg viewBox={`0 0 ${SVG_W} ${svgH}`} className="w-full" style={{ maxHeight: '520px' }}>
          <defs>
            <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L6,3 z" fill="#1e293b" />
            </marker>
            <marker id="arr-on" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L6,3 z" fill="#22d3ee" />
            </marker>
            <style>{`
              @keyframes flow { to { stroke-dashoffset: -16; } }
              .flowing { animation: flow 0.8s linear infinite; stroke-dasharray: 6 4; }
            `}</style>
          </defs>

          {/* Outer boundary */}
          <rect x="50" y="16" width="900" height={svgH - 28} rx="16"
            fill="none" stroke="#1e293b" strokeWidth="1" strokeDasharray="6 4" opacity="0.3" />

          {/* Dynamic edges */}
          {edges.map(({ from, to, label, curved }) => {
            const fp = positions[from];
            const tp = positions[to];
            if (!fp || !tp) return null;
            const active = edgeActive(from, to);
            const lp = labelMidpoint(fp, tp, curved);
            return (
              <g key={`${from}→${to}`}>
                <path
                  d={edgePath(fp, tp, curved)}
                  fill="none"
                  stroke={active ? '#22d3ee' : '#1e293b'}
                  strokeWidth={active ? 1.5 : 1}
                  className={active ? 'flowing' : undefined}
                  markerEnd={active ? 'url(#arr-on)' : 'url(#arr)'}
                  opacity={active ? 0.8 : 0.5}
                />
                {label && (
                  <text x={lp.x} y={lp.y} textAnchor="middle" fontSize="9.5"
                    fill={active ? '#67e8f9' : '#475569'} className="select-none font-mono">
                    {label}
                  </text>
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
            const status = id === 'human' ? 'active' : (agent?.status ?? 'idle');
            const isWorking = agentRunning(id);
            const isBlocked = status === 'blocked';
            const selected = selectedRole === id;
            const clickable = id !== 'human';

            const displayStatus = id === 'human' ? 'Activo'
              : status === 'running' ? 'Trabajando'
              : status === 'blocked' ? 'Bloqueado'
              : status === 'completed' ? 'Completado'
              : status === 'failed' ? 'Fallido'
              : 'En espera';

            let borderClass = 'border-zinc-800/80';
            let textStatusClass = 'text-zinc-500';
            if (id === 'human') { borderClass = 'border-blue-500/25'; textStatusClass = 'text-emerald-400'; }
            else if (isWorking) { borderClass = theme.border; textStatusClass = theme.text; }
            else if (isBlocked) { borderClass = 'border-red-500/25'; textStatusClass = 'text-red-400'; }
            else if (status === 'completed') { borderClass = 'border-emerald-500/20'; textStatusClass = 'text-emerald-500'; }

            return (
              <g key={id} transform={`translate(${cx}, ${cy})`}>
                {isWorking && (
                  <circle r="46" fill="none" stroke={theme.color} strokeWidth="1" opacity="0.1">
                    <animate attributeName="r" values="44;54;44" dur="2s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.15;0;0.15" dur="2s" repeatCount="indefinite" />
                  </circle>
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
                      'relative flex items-center gap-2.5 rounded-xl border bg-[#090d16]/95 p-2.5 shadow-lg backdrop-blur-md transition-all select-none h-full',
                      clickable ? 'cursor-pointer' : '',
                      borderClass,
                      selected ? 'ring-1 ring-cyan-400 border-cyan-400' : 'hover:border-zinc-700',
                      isWorking ? theme.glow : '',
                    )}
                  >
                    <div className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform',
                      id === 'human' ? 'bg-blue-500/10 text-blue-400' : theme.iconBg,
                      selected ? 'scale-95' : '',
                    )}>
                      <IconComponent className="h-4.5 w-4.5" />
                    </div>
                    <div className="flex flex-col min-w-0 leading-tight">
                      <span className="text-[11px] font-semibold text-zinc-100 truncate">{meta.label}</span>
                      <span className={cn('text-[9px] font-medium font-mono mt-0.5', textStatusClass)}>
                        {displayStatus}
                      </span>
                    </div>
                    {isBlocked && (
                      <div className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-950 border border-red-500/30 text-[9px] shadow-sm">
                        🔒
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
          Haz clic en un agente → tareas · logs · terminal
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
