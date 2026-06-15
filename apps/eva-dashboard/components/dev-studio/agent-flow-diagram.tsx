'use client';

import { useState, useCallback } from 'react';
import type { DevAgent, AgentRole } from '@/lib/dev-studio-types';
import { AGENT_ROLE_EMOJI } from '@/lib/dev-studio-types';
import { AgentDetailPanel } from './agent-detail-panel';

// ── Node topology ─────────────────────────────────────────────────────────────
const NODES: { id: string; label: string; cx: number; cy: number }[] = [
  { id: 'project_manager', label: 'Project Manager',     cx: 500, cy: 72  },
  { id: 'architect',       label: 'Architect',           cx: 240, cy: 210 },
  { id: 'backend',         label: 'Backend Agent',       cx: 760, cy: 210 },
  { id: 'frontend',        label: 'Frontend Agent',      cx: 175, cy: 348 },
  { id: 'testing',         label: 'Testing Agent',       cx: 500, cy: 348 },
  { id: 'deployment',      label: 'Deployment Agent',    cx: 825, cy: 348 },
  { id: 'reviewer',        label: 'Reviewer / Integrator', cx: 500, cy: 468 },
  { id: 'human',           label: 'Humano',              cx: 500, cy: 565 },
];

// ── Edges ─────────────────────────────────────────────────────────────────────
const EDGES: { from: string; to: string; label?: string; curved?: boolean }[] = [
  { from: 'project_manager', to: 'architect',    label: 'asigna' },
  { from: 'project_manager', to: 'backend',      label: 'asigna' },
  { from: 'architect',       to: 'frontend' },
  { from: 'architect',       to: 'testing' },
  { from: 'backend',         to: 'testing' },
  { from: 'backend',         to: 'deployment',  label: 'deploy' },
  { from: 'frontend',        to: 'testing' },
  { from: 'frontend',        to: 'reviewer',    label: 'revisión' },
  { from: 'testing',         to: 'reviewer',    label: 'revisión' },
  { from: 'deployment',      to: 'reviewer',    label: 'revisión' },
  { from: 'reviewer',        to: 'human',       label: 'feedback' },
  { from: 'reviewer',        to: 'project_manager', curved: true },
];

// ── Status theme ──────────────────────────────────────────────────────────────
const NODE_THEME: Record<string, {
  fill: string; stroke: string; text: string; badge: string; badgeText: string; label: string;
}> = {
  running:                { fill: '#0a1a0e', stroke: '#16a34a', text: '#4ade80', badge: '#14532d', badgeText: '#4ade80', label: 'Trabajando' },
  blocked:                { fill: '#1a0a0a', stroke: '#dc2626', text: '#f87171', badge: '#450a0a', badgeText: '#f87171', label: 'Bloqueado' },
  rate_limited:           { fill: '#1a110a', stroke: '#d97706', text: '#fbbf24', badge: '#451a03', badgeText: '#fbbf24', label: 'Rate Limited' },
  quota_exhausted:        { fill: '#1a110a', stroke: '#f59e0b', text: '#fcd34d', badge: '#451a03', badgeText: '#fcd34d', label: 'Sin quota' },
  waiting_for_dependency: { fill: '#0a0f1a', stroke: '#3b82f6', text: '#93c5fd', badge: '#1e3a5f', badgeText: '#93c5fd', label: 'Esperando' },
  completed:              { fill: '#0a1a0e', stroke: '#22c55e', text: '#86efac', badge: '#14532d', badgeText: '#86efac', label: 'Completado' },
  failed:                 { fill: '#1a0a0a', stroke: '#ef4444', text: '#fca5a5', badge: '#450a0a', badgeText: '#fca5a5', label: 'Fallido' },
  idle:                   { fill: '#0d0d12', stroke: '#27272a', text: '#71717a', badge: '#18181b', badgeText: '#52525b', label: 'En espera' },
};

function pos(id: string) {
  return NODES.find((n) => n.id === id)!;
}

function edgePath(fromId: string, toId: string, curved?: boolean) {
  const f = pos(fromId); const t = pos(toId);
  if (curved) {
    // PM feedback loop — curve out to the right
    return `M ${f.cx} ${f.cy} C ${f.cx + 280} ${f.cy} ${t.cx + 280} ${t.cy} ${t.cx} ${t.cy}`;
  }
  const mx = (f.cx + t.cx) / 2;
  const my = (f.cy + t.cy) / 2 - Math.abs(t.cx - f.cx) * 0.05;
  return `M ${f.cx} ${f.cy} Q ${mx} ${my} ${t.cx} ${t.cy}`;
}

function labelPos(fromId: string, toId: string, curved?: boolean) {
  const f = pos(fromId); const t = pos(toId);
  if (curved) return { x: f.cx + 210, y: (f.cy + t.cy) / 2 };
  return { x: (f.cx + t.cx) / 2, y: (f.cy + t.cy) / 2 - 8 };
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
  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(sessionStatus);

  const theme = useCallback((role: string) => {
    if (role === 'human') return NODE_THEME.running!;
    const status = agentMap.get(role)?.status ?? 'idle';
    return NODE_THEME[status] ?? NODE_THEME.idle!;
  }, [agentMap]);

  const isRunning = useCallback((role: string) => {
    if (role === 'human') return true;
    return (agentMap.get(role)?.status ?? 'idle') === 'running';
  }, [agentMap]);

  const edgeActive = useCallback((fromId: string, toId: string) => {
    return isActive && (isRunning(fromId) || isRunning(toId));
  }, [isActive, isRunning]);

  return (
    <div className="relative">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        <svg viewBox="0 0 1000 620" className="w-full" style={{ maxHeight: '500px' }}>
          <defs>
            <marker id="arr" markerWidth="5" markerHeight="5" refX="4.5" refY="2.5" orient="auto">
              <path d="M0,0.5 L0,4.5 L5,2.5 z" fill="#27272a" />
            </marker>
            <marker id="arr-on" markerWidth="5" markerHeight="5" refX="4.5" refY="2.5" orient="auto">
              <path d="M0,0.5 L0,4.5 L5,2.5 z" fill="#22d3ee" />
            </marker>
            <style>{`
              @keyframes flow { to { stroke-dashoffset: -16; } }
              .flowing { animation: flow 0.7s linear infinite; }
              @keyframes pulse-ring { 0%,100%{r:50;opacity:0.15} 50%{r:60;opacity:0} }
            `}</style>
          </defs>

          {/* Outer dashed boundary */}
          <rect x="85" y="30" width="830" height="555" rx="16"
            fill="none" stroke="#18181b" strokeWidth="1" strokeDasharray="6 3" />

          {/* Edges */}
          {EDGES.map(({ from, to, label, curved }) => {
            const active = edgeActive(from, to);
            return (
              <g key={`${from}-${to}`}>
                <path d={edgePath(from, to, curved)}
                  fill="none"
                  stroke={active ? '#22d3ee' : '#27272a'}
                  strokeWidth={active ? 1.5 : 1}
                  strokeDasharray={active ? '6 4' : undefined}
                  className={active ? 'flowing' : undefined}
                  markerEnd={active ? 'url(#arr-on)' : 'url(#arr)'}
                  opacity={active ? 0.7 : 0.5}
                />
                {label && (() => {
                  const lp = labelPos(from, to, curved);
                  return (
                    <text x={lp.x} y={lp.y} textAnchor="middle" fontSize="9.5"
                      fill={active ? '#67e8f9' : '#3f3f46'} className="select-none font-mono">
                      {label}
                    </text>
                  );
                })()}
              </g>
            );
          })}

          {/* Nodes */}
          {NODES.map(({ id, label, cx, cy }) => {
            const t = theme(id);
            const running = isRunning(id);
            const selected = selectedRole === id;
            const clickable = id !== 'human';
            const emoji = AGENT_ROLE_EMOJI[id] ?? (id === 'human' ? '👤' : '🤖');

            return (
              <g key={id}
                transform={`translate(${cx},${cy})`}
                className={clickable ? 'cursor-pointer' : ''}
                onClick={() => clickable && setSelectedRole(selected ? null : id as AgentRole)}
              >
                {/* Pulse ring */}
                {running && (
                  <circle r="50" fill="none" stroke={t.stroke} strokeWidth="1" opacity="0.15">
                    <animate attributeName="r" values="46;58;46" dur="2.2s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.15;0;0.15" dur="2.2s" repeatCount="indefinite" />
                  </circle>
                )}

                {/* Selection ring */}
                {selected && (
                  <circle r="50" fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8" />
                )}

                {/* Node rect */}
                <rect x="-74" y="-36" width="148" height="72" rx="12"
                  fill={t.fill}
                  stroke={selected ? '#22d3ee' : t.stroke}
                  strokeWidth={selected ? 1.5 : 1}
                />

                {/* Emoji */}
                <text y="-10" textAnchor="middle" fontSize="18" className="select-none">{emoji}</text>

                {/* Label */}
                <text y="8" textAnchor="middle" fontSize="10.5" fontWeight="500"
                  fill={t.text} className="select-none">{label}</text>

                {/* Status badge */}
                <rect x="-36" y="15" width="72" height="14" rx="7" fill={t.badge} opacity="0.6" />
                <text y="26" textAnchor="middle" fontSize="9" fill={t.badgeText} className="select-none font-mono">
                  {t.label}
                </text>

                {/* Live dot */}
                {running && (
                  <circle cx="64" cy="-30" r="4" fill="#22c55e">
                    <animate attributeName="opacity" values="1;0.3;1" dur="1.1s" repeatCount="indefinite" />
                  </circle>
                )}
                {(agentMap.get(id)?.status === 'blocked') && (
                  <text x="64" y="-26" textAnchor="middle" fontSize="12" className="select-none">🔒</text>
                )}
              </g>
            );
          })}

          {/* Bottom hint */}
          <text x="500" y="608" textAnchor="middle" fontSize="10" fill="#27272a" className="select-none font-mono">
            click en un agente → tareas · logs · terminal
          </text>
        </svg>
      </div>

      {/* Detail panel */}
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
