'use client';

import { coreFetch } from './core-api';
import type {
  DevSession, DevGoal, DevIteration, DevAgent,
  DevHumanTask, DevMergeProposal, DevEvent, ClaudeAuthOption, FlowState,
  ProjectPlan, GithubStatus, GithubTreeEntry, GithubContent, GithubPrFile,
} from './dev-studio-types';

const BASE = '/dev-studio';

// ── Sessions ──────────────────────────────────────────────────────────────────

export const devStudioApi = {
  // Planning preview (no session created)
  planSession: (description: string) =>
    coreFetch<ProjectPlan>(`${BASE}/sessions/plan`, { method: 'POST', body: JSON.stringify({ description }) }),

  // Sessions
  createSession: (data: {
    prompt: string;
    title?: string;
    project_id?: string;
    preplan?: {
      northStar?: string;
      teamTier?: 'small' | 'medium' | 'large';
      teamTierReason?: string;
      definitionOfDone?: Array<{ id: string; description: string; verifiable: boolean }>;
      goals: Array<{ title: string; description: string; priority: number; successCriteria: Array<{ id: string; description: string; verifiable: boolean }> }>;
      autoApprove?: boolean;
    };
  }) =>
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

  deleteSession: (id: string) =>
    coreFetch<void>(`${BASE}/sessions/${id}`, { method: 'DELETE' }),

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

  retryTask: (taskId: string) =>
    coreFetch<{ ok: boolean; task: Record<string, unknown> }>(`${BASE}/tasks/${taskId}/retry`, { method: 'POST', body: '{}' }),

  deleteTask: (taskId: string) =>
    coreFetch<{ ok: boolean }>(`${BASE}/tasks/${taskId}`, { method: 'DELETE' }),

  listTaskEvents: (taskId: string, limit = 60) =>
    coreFetch<Record<string, unknown>[]>(`${BASE}/tasks/${taskId}/events?limit=${limit}`),

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

  deleteAgent: (agentId: string) =>
    coreFetch<{ ok: boolean }>(`${BASE}/agents/${agentId}`, { method: 'DELETE' }),

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

  checkAgentAuth: (sessionId: string, role: string) =>
    coreFetch<{ ok: boolean; authOk: boolean; error?: string | null }>(
      `${BASE}/sessions/${sessionId}/agents/${role}/machine/check-auth`,
      { method: 'POST', body: '{}' },
    ),

  /** Force-requeue all frozen tasks and immediately re-tick the session. */
  unstickSession: (sessionId: string) =>
    coreFetch<{ ok: boolean; requeued: number; roles: string[] }>(
      `${BASE}/sessions/${sessionId}/unstick`,
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

  /** Start an OAuth device-code flow in the agent's machine.
   *  Returns { ok:true, url } on success or { ok:false, useTerminal:true, error } when
   *  the automated flow can't get a URL and the user should run claude auth login manually.
   */
  startOAuthFlow: (sessionId: string, role: string) =>
    coreFetch<{ ok: boolean; url: string | null; agentId: string; error: string | null; useTerminal: boolean }>(
      `${BASE}/sessions/${sessionId}/agents/${role}/machine/oauth/start`,
      { method: 'POST', body: '{}' },
    ),

  /** Poll whether the OAuth flow completed and the token was saved. */
  pollOAuthStatus: (sessionId: string, role: string) =>
    coreFetch<{
      status: 'scanning_url' | 'waiting_for_code' | 'waiting_callback' | 'completed' | 'failed' | 'idle';
      configured: boolean;
      url: string | null;
      error: string | null;
    }>(`${BASE}/sessions/${sessionId}/agents/${role}/machine/oauth/status`),

  /** Submit the auth code received after visiting the OAuth URL. */
  submitOAuthCode: (sessionId: string, role: string, code: string) =>
    coreFetch<{ ok: boolean }>(
      `${BASE}/sessions/${sessionId}/agents/${role}/machine/oauth/code`,
      { method: 'POST', body: JSON.stringify({ code }) },
    ),

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

  mergeProposalFiles: (proposalId: string) =>
    coreFetch<GithubPrFile[]>(`${BASE}/merge-proposals/${proposalId}/files`),

  // ── GitHub connection + read-only repo viewer ────────────────────────────────

  githubStatus: () => coreFetch<GithubStatus>(`${BASE}/github/status`),

  connectRepo: (
    sessionId: string,
    data: { repoUrl?: string; create?: boolean; name?: string; owner?: string; private?: boolean },
  ) =>
    coreFetch<DevSession>(`${BASE}/sessions/${sessionId}/repo/connect`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  repoTree: (sessionId: string, ref?: string) => {
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return coreFetch<GithubTreeEntry[]>(`${BASE}/sessions/${sessionId}/repo/tree${qs}`);
  },

  repoFile: (sessionId: string, path: string, ref?: string) => {
    const qs = new URLSearchParams({ path });
    if (ref) qs.set('ref', ref);
    return coreFetch<GithubContent>(`${BASE}/sessions/${sessionId}/repo/file?${qs.toString()}`);
  },
};
