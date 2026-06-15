'use client';

import { cn } from '@/lib/utils';
import type { DevAgent } from '@/lib/dev-studio-types';
import { AGENT_ROLE_EMOJI } from '@/lib/dev-studio-types';

const AGENT_STATUS_COLOR: Record<string, string> = {
  idle: 'bg-slate-100 text-slate-500',
  running: 'bg-emerald-100 text-emerald-700',
  blocked: 'bg-red-100 text-red-700',
  quota_exhausted: 'bg-orange-100 text-orange-700',
  rate_limited: 'bg-amber-100 text-amber-700',
  waiting_for_dependency: 'bg-blue-100 text-blue-600',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

// Fixed team definition — always show all roles
const TEAM_ROLES = [
  { role: 'project_manager', label: 'Project Manager' },
  { role: 'architect', label: 'Architect' },
  { role: 'frontend', label: 'Frontend' },
  { role: 'backend', label: 'Backend' },
  { role: 'testing', label: 'Testing' },
  { role: 'reviewer', label: 'Reviewer' },
  { role: 'deployment', label: 'Deployment' },
];

interface AgentTeamProps {
  agents: DevAgent[];
  userId?: string;
  userLabel?: string;
}

export function AgentTeam({ agents, userId, userLabel }: AgentTeamProps) {
  const agentsByRole = new Map(agents.map((a) => [a.role, a]));

  return (
    <div className="space-y-2">
      {TEAM_ROLES.map(({ role, label }) => {
        const agent = agentsByRole.get(role);
        const emoji = AGENT_ROLE_EMOJI[role] ?? '🤖';
        const status = agent?.status ?? 'idle';

        return (
          <div key={role} className="flex items-center gap-3">
            <span className="text-lg w-6 text-center">{emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-700">{label} Agent</p>
              {agent?.branch_name && (
                <p className="text-xs text-slate-400 font-mono truncate">{agent.branch_name}</p>
              )}
            </div>
            <span className={cn(
              'text-xs rounded-full px-2 py-0.5 font-medium',
              AGENT_STATUS_COLOR[status] ?? 'bg-slate-100 text-slate-500',
            )}>
              {status === 'running' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse mr-1" />}
              {status === 'idle' ? 'En espera' : status}
            </span>
          </div>
        );
      })}

      {/* Human contributor */}
      <div className="flex items-center gap-3 border-t border-slate-100 pt-2 mt-2">
        <span className="text-lg w-6 text-center">👤</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-700">{userLabel ?? 'Tú'}</p>
          <p className="text-xs text-slate-400">Human Contributor</p>
        </div>
        <span className="text-xs rounded-full px-2 py-0.5 bg-blue-100 text-blue-700 font-medium">
          Activo
        </span>
      </div>
    </div>
  );
}
