'use client';

import { coreFetch } from './core-api';
import type {
  DevSession, DevGoal, DevIteration, DevAgent,
  DevHumanTask, DevMergeProposal, DevEvent, ClaudeAuthOption, FlowState,
} from './dev-studio-types';

const BASE = '/dev-studio';

// ── Sessions ──────────────────────────────────────────────────────────────────

export const devStudioApi = {
  // Sessions
  createSession: (data: { prompt: string; title?: string; project_id?: string }) =>
    coreFetch<DevSession>(`${BASE}/sessions`, { method: 'POST', body: JSON.stringify(data) }),

  listSessions: () => coreFetch<DevSession[]>(`${BASE}/sessions`),

  getSession: (id: string) => coreFetch<DevSession>(`${BASE}/sessions/${id}`),

  startSession: (id: string) =>
    coreFetch<{ accepted: boolean; sessionId: string }>(`${BASE}/sessions/${id}/start`, { method: 'POST', body: '{}' }),

  pauseSession: (id: string) =>
    coreFetch<DevSession>(`${BASE}/sessions/${id}/pause`, { method: 'POST', body: '{}' }),

  resumeSession: (id: string) =>
    coreFetch<DevSession>(`${BASE}/sessions/${id}/resume`, { method: 'POST', body: '{}' }),

  cancelSession: (id: string) =>
    coreFetch<DevSession>(`${BASE}/sessions/${id}/cancel`, { method: 'POST', body: '{}' }),

  steerSession: (id: string, message: string) =>
    coreFetch<{ accepted: boolean }>(`${BASE}/sessions/${id}/steer`, { method: 'POST', body: JSON.stringify({ message }) }),

  tickSession: (id: string) =>
    coreFetch<{ action: string; message: string }>(`${BASE}/sessions/${id}/tick`, { method: 'POST', body: '{}' }),

  // Goals
  listGoals: (sessionId: string) =>
    coreFetch<DevGoal[]>(`${BASE}/sessions/${sessionId}/goals`),

  approveGoals: (sessionId: string, goalIds: string[]) =>
    coreFetch<{ accepted: boolean }>(`${BASE}/sessions/${sessionId}/goals/approve`, {
      method: 'POST',
      body: JSON.stringify({ goal_ids: goalIds }),
    }),

  validateGoal: (goalId: string) =>
    coreFetch<{ validated: boolean }>(`${BASE}/goals/${goalId}/validate`, { method: 'POST', body: '{}' }),

  // Iterations
  listIterations: (sessionId: string, goalId?: string) => {
    const qs = goalId ? `?goal_id=${goalId}` : '';
    return coreFetch<DevIteration[]>(`${BASE}/sessions/${sessionId}/iterations${qs}`);
  },

  // Tasks
  listTasks: (sessionId: string, status?: string) => {
    const qs = status ? `?status=${status}` : '';
    return coreFetch<Record<string, unknown>[]>(`${BASE}/sessions/${sessionId}/tasks${qs}`);
  },

  // Human Tasks
  listHumanTasks: (sessionId: string, status?: string) => {
    const qs = status ? `?status=${status}` : '';
    return coreFetch<DevHumanTask[]>(`${BASE}/sessions/${sessionId}/human-tasks${qs}`);
  },

  submitHumanTask: (taskId: string, result: Record<string, unknown>, notes?: string) =>
    coreFetch<DevHumanTask>(`${BASE}/human-tasks/${taskId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ result, notes }),
    }),

  verifyHumanTask: (taskId: string) =>
    coreFetch<DevHumanTask>(`${BASE}/human-tasks/${taskId}/verify`, { method: 'POST', body: '{}' }),

  // Agents
  listAgents: (sessionId: string) =>
    coreFetch<DevAgent[]>(`${BASE}/sessions/${sessionId}/agents`),

  getFlowState: (sessionId: string) =>
    coreFetch<FlowState>(`${BASE}/sessions/${sessionId}/flow`),

  getAgentDetail: (sessionId: string, role: string) =>
    coreFetch<Record<string, unknown>>(`${BASE}/sessions/${sessionId}/agents/${role}/detail`),

  getAgentLogs: (sessionId: string, role: string, limit = 100) =>
    coreFetch<Record<string, unknown>[]>(`${BASE}/sessions/${sessionId}/agents/${role}/logs?limit=${limit}`),

  bootAgentMachine: (sessionId: string, role: string) =>
    coreFetch<{ agentId: string; ok: boolean; image?: string; containerName?: string; error?: string }>(
      `${BASE}/sessions/${sessionId}/agents/${role}/machine/boot`,
      { method: 'POST', body: '{}' },
    ),

  // Claude Code provisioning
  getClaudeCodeOptions: () =>
    coreFetch<{ options: ClaudeAuthOption[] }>(`${BASE}/claude-code/options`),

  getClaudeCodeStatus: () =>
    coreFetch<{ configured: boolean; imageReady: boolean }>(`${BASE}/claude-code/status`),

  saveClaudeCodeCredential: (sessionId: string, method: string, token: string) =>
    coreFetch<{ ok: boolean }>(`${BASE}/sessions/${sessionId}/claude-code/credential`, {
      method: 'POST',
      body: JSON.stringify({ method, token }),
    }),

  // Events
  listEvents: (sessionId: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : '';
    return coreFetch<DevEvent[]>(`${BASE}/sessions/${sessionId}/events${qs}`);
  },

  // Merge proposals
  listMergeProposals: (sessionId: string) =>
    coreFetch<DevMergeProposal[]>(`${BASE}/sessions/${sessionId}/merge-proposals`),

  approveMerge: (proposalId: string, notes?: string) =>
    coreFetch<DevMergeProposal>(`${BASE}/merge-proposals/${proposalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reviewer_notes: notes }),
    }),

  rejectMerge: (proposalId: string, notes?: string) =>
    coreFetch<DevMergeProposal>(`${BASE}/merge-proposals/${proposalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reviewer_notes: notes }),
    }),
};
