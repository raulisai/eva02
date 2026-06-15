'use client';

import { useState, useCallback } from 'react';
import type { DevAgent, AgentRole } from '@/lib/dev-studio-types';
import { AGENT_ROLE_EMOJI } from '@/lib/dev-studio-types';
import { cn } from '@/lib/utils';
import { AgentDetailPanel } from './agent-detail-panel';

const ROLE_LABEL: Record<string, string> = {
  project_manager: 'Project Manager',
  architect: 'Architect',
  frontend: 'Frontend Agent',
  backend: 'Backend Agent',
  testing: 'Testing Agent',
  deployment: 'Deployment Agent',
  reviewer: 'Reviewer / Integrator',
};

// ── Fixed topology coordinates (percentage-based 0-100 within a 1000×620 viewBox) ──
const NODE_POSITIONS: Record<string, { cx: number; cy: number }> = {
  project_manager: { cx: 500, cy: 80 },
  architect:       { cx: 250, cy: 215 },
  backend:         { cx: 750, cy: 215 },
  frontend:        { cx: 180, cy: 360 },
  testing:         { cx: 500, cy: 360 },
  deployment:      { cx: 820, cy: 360 },
  reviewer:        { cx: 500, cy: 490 },
  human:           { cx: 500, cy: 580 },
};

// ── Edges: [from, to, label?] ──
const EDGES: [string, string, string?][] = [
  ['project_manager', 'architect', 'plan'],
  ['project_manager', 'backend', 'plan'],
  ['architect', 'frontend', ''],
  ['architect', 'testing', ''],
  ['backend', 'testing', ''],
  ['backend', 'deployment', 'deploy'],
  ['frontend', 'testing', ''],
  ['testing', 'reviewer', 'review'],
  ['deployment', 'reviewer', 'review'],
  ['reviewer', 'human', 'feedback'],
  ['reviewer', 'project_manager'],
];

const STATUS_NODE_COLOR: Record<string, { fill: string; stroke: string; text: string; badge: string }> = {
  running:         { fill: '#052e16', stroke: '#16a34a', text: '#4ade80', badge: '#16a34a' },
  blocked:         { fill: '#1c0a09', stroke: '#dc2626', text: '#f87171', badge: '#dc2626' },
  rate_limited:    { fill: '#1c1109', stroke: '#d97706', text: '#fbbf24', badge: '#d97706' },
  quota_exhausted: { fill: '#1c1109', stroke: '#f59e0b', text: '#fcd34d', badge: '#f59e0b' },
  waiting_for_dependency: { fill: '#0d1629', stroke: '#3b82f6', text: '#93c5fd', badge: '#3b82f6' },
  completed:       { fill: '#052e16', stroke: '#22c55e', text: '#86efac', badge: '#22c55e' },
  failed:          { fill: '#1c0a09', stroke: '#ef4444', text: '#fca5a5', badge: '#ef4444' },
  idle:            { fill: '#0d0d14', stroke: '#334155', text: '#94a3b8', badge: '#334155' },
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Trabajando',
  blocked: 'Bloqueado',
  rate_limited: 'Rate Limited',
  quota_exhausted: 'Sin quota',
  waiting_for_dependency: 'Esperando',
  completed: 'Completado',
  failed: 'Fallido',
  idle: 'En espera',
};

function midpoint(a: { cx: number; cy: number }, b: { cx: number; cy: number }) {
  return { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 };
}

function getEdgePath(from: { cx: number; cy: number }, to: { cx: number; cy: number }) {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  // Control point offset for smooth curves
  const cpx = from.cx + dx * 0.5;
  const cpy = from.cy + dy * 0.1;
  return `M ${from.cx} ${from.cy} Q ${cpx} ${cpy} ${to.cx} ${to.cy}`;
}

interface AgentFlowDiagramProps {
  agents: DevAgent[];
  sessionId: string;
  orgToken: string;
  sessionStatus: string;
}

export function AgentFlowDiagram({ agents, sessionId, orgToken, sessionStatus }: AgentFlowDiagramProps) {
  const [selectedRole, setSelectedRole] = useState<AgentRole | null>(null);

  const agentMap = new Map(agents.map((a) => [a.role, a]));

  const getStatus = useCallback((role: string) => {
    if (role === 'human') return 'running';
    return agentMap.get(role)?.status ?? 'idle';
  }, [agentMap]);

  const nodeRoles = Object.keys(NODE_POSITIONS);
  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(sessionStatus);

  return (
    <div className="relative w-full">
      {/* SVG diagram */}
      <div className="rounded-2xl border border-slate-700 bg-gradient-to-b from-slate-950 to-[#070714] overflow-hidden">
        <svg
          viewBox="0 0 1000 640"
          className="w-full"
          style={{ maxHeight: '520px' }}
        >
          <defs>
            {/* Arrow marker */}
            <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#334155" />
            </marker>
            <marker id="arrow-active" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#22d3ee" />
            </marker>

            {/* Glow filter for active nodes */}
            <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Animated dash for active edges */}
            <style>{`
              @keyframes dash { to { stroke-dashoffset: -20; } }
              .edge-active { animation: dash 0.8s linear infinite; }
            `}</style>
          </defs>

          {/* Bounding box dashes */}
          <rect x="100" y="40" width="800" height="570" rx="20"
            fill="none" stroke="#1e293b" strokeWidth="1" strokeDasharray="8 4" />

          {/* Edges */}
          {EDGES.map(([fromRole, toRole, label]) => {
            const from = NODE_POSITIONS[fromRole];
            const to = NODE_POSITIONS[toRole];
            if (!from || !to) return null;

            const fromStatus = getStatus(fromRole);
            const toStatus = getStatus(toRole);
            const edgeActive = isActive && (fromStatus === 'running' || toStatus === 'running');
            const mid = midpoint(from, to);

            return (
              <g key={`${fromRole}-${toRole}`}>
                <path
                  d={getEdgePath(from, to)}
                  fill="none"
                  stroke={edgeActive ? '#22d3ee' : '#1e293b'}
                  strokeWidth={edgeActive ? 1.5 : 1}
                  strokeDasharray={edgeActive ? '6 4' : undefined}
                  className={edgeActive ? 'edge-active' : undefined}
                  markerEnd={edgeActive ? 'url(#arrow-active)' : 'url(#arrow)'}
                  opacity={edgeActive ? 0.8 : 0.4}
                />
                {label && (
                  <text
                    x={mid.x}
                    y={mid.y - 4}
                    textAnchor="middle"
                    fontSize="10"
                    fill={edgeActive ? '#67e8f9' : '#475569'}
                    className="select-none"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {nodeRoles.map((role) => {
            const pos = NODE_POSITIONS[role]!;
            const status = getStatus(role);
            const colors = STATUS_NODE_COLOR[status] ?? STATUS_NODE_COLOR.idle!;
            const isRunning = status === 'running';
            const isClickable = role !== 'human';
            const isSelected = selectedRole === role;

            return (
              <g
                key={role}
                transform={`translate(${pos.cx}, ${pos.cy})`}
                className={isClickable ? 'cursor-pointer' : 'cursor-default'}
                onClick={() => {
                  if (isClickable) setSelectedRole(role === selectedRole ? null : role as AgentRole);
                }}
              >
                {/* Pulse ring for running agents */}
                {isRunning && (
                  <>
                    <circle r="52" fill="none" stroke={colors.stroke} strokeWidth="1" opacity="0.3">
                      <animate attributeName="r" values="48;62;48" dur="2s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite" />
                    </circle>
                  </>
                )}

                {/* Selection ring */}
                {isSelected && (
                  <circle r="52" fill="none" stroke="#22d3ee" strokeWidth="2" opacity="0.6" />
                )}

                {/* Node background */}
                <rect
                  x="-80" y="-38" width="160" height="76" rx="16"
                  fill={isSelected ? '#0e1a2e' : colors.fill}
                  stroke={isSelected ? '#22d3ee' : colors.stroke}
                  strokeWidth={isSelected ? 2 : 1.5}
                  filter={isRunning ? 'url(#glow)' : undefined}
                />

                {/* Emoji icon */}
                <text y="-10" textAnchor="middle" fontSize="22" className="select-none">
                  {AGENT_ROLE_EMOJI[role] ?? (role === 'human' ? '👤' : '🤖')}
                </text>

                {/* Role label */}
                <text y="8" textAnchor="middle" fontSize="11" fontWeight="600" fill={colors.text} className="select-none">
                  {ROLE_LABEL[role] ?? role}
                </text>

                {/* Status badge */}
                <rect x="-38" y="16" width="76" height="16" rx="8" fill={colors.badge} opacity="0.2" />
                <text y="28" textAnchor="middle" fontSize="9.5" fill={colors.text} opacity="0.9" className="select-none">
                  {STATUS_LABEL[status] ?? status}
                </text>

                {/* Dot indicator */}
                {isRunning && (
                  <circle cx="68" cy="-32" r="5" fill="#22c55e">
                    <animate attributeName="opacity" values="1;0.2;1" dur="1.2s" repeatCount="indefinite" />
                  </circle>
                )}
                {status === 'blocked' && (
                  <circle cx="68" cy="-32" r="5" fill="#ef4444" />
                )}
              </g>
            );
          })}

          {/* Hint text */}
          <text x="500" y="630" textAnchor="middle" fontSize="11" fill="#334155" className="select-none">
            Haz clic en un agente para ver tareas, conversaciones e interacciones.
          </text>
        </svg>
      </div>

      {/* Agent detail panel (slide-over) */}
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
