export type DevSessionStatus =
  | 'idea_intake' | 'planning' | 'awaiting_goals_approval'
  | 'awaiting_architecture_approval' | 'running'
  | 'waiting_for_human_setup' | 'waiting_for_human_secret'
  | 'waiting_for_human_review' | 'waiting_for_human_validation'
  | 'paused' | 'blocked' | 'ready_for_release' | 'ready_for_deploy'
  | 'completed' | 'failed' | 'cancelled';

export type DevGoalStatus =
  | 'proposed' | 'approved' | 'in_progress' | 'blocked'
  | 'needs_user_decision' | 'ready_for_validation' | 'validated'
  | 'completed' | 'paused' | 'cancelled';

export type DevIterationStatus =
  | 'planned' | 'running' | 'evaluating' | 'needs_more_work'
  | 'needs_user_decision' | 'completed' | 'cancelled';

export type DevHumanTaskStatus =
  | 'pending' | 'in_progress' | 'waiting_user' | 'submitted' | 'verified'
  | 'rejected' | 'cancelled';

export interface DevSession {
  id: string;
  org_id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  original_prompt: string;
  north_star: string | null;
  definition_of_done: unknown[];
  status: DevSessionStatus;
  repo_url: string | null;
  base_branch: string;
  session_branch: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_provider: string | null;
  integration_branch: string | null;
  current_goal_id: string | null;
  current_iteration_id: string | null;
  continuation_policy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DevGoal {
  id: string;
  org_id: string;
  session_id: string;
  title: string;
  description: string | null;
  status: DevGoalStatus;
  priority: number;
  success_criteria: Array<{ id: string; description: string; verifiable: boolean; verified?: boolean }>;
  current_score: number;
  target_score: number;
  owner_agent_role: string;
  iteration_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DevIteration {
  id: string;
  org_id: string;
  session_id: string;
  goal_id: string | null;
  title: string;
  status: DevIterationStatus;
  objective: string;
  planned_outputs: string[];
  completed_outputs: string[];
  evaluation: {
    goal_score?: number;
    completed_criteria?: string[];
    missing_criteria?: string[];
    summary?: string;
    needs_more_work?: boolean;
  };
  created_by: string;
  number: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface DevAgent {
  id: string;
  session_id: string;
  role: string;
  name: string;
  status: string;
  runtime: string;
  current_task_id: string | null;
  branch_name: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  github_login: string | null;
  last_heartbeat_at: string | null;
}

export interface DevHumanTask {
  id: string;
  session_id: string;
  goal_id: string | null;
  iteration_id: string | null;
  title: string;
  description: string | null;
  status: DevHumanTaskStatus;
  required_output: string | null;
  sensitive: boolean;
  blocks_task_ids: string[];
  instructions: Record<string, unknown>;
  submitted_result: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

export interface DevMergeProposal {
  id: string;
  session_id: string;
  task_id: string | null;
  source_branch: string;
  target_branch: string;
  status: string;
  diff_summary: string | null;
  risk_level: string | null;
  test_result: Record<string, unknown>;
  reviewer_notes: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  head_sha: string | null;
  kind: 'feature' | 'release' | null;
  approval_id: string | null;
  created_at: string;
}

// ── GitHub connection + read-only viewer ──────────────────────────────────────

export interface GithubStatus {
  connected: boolean;
  login?: string;
  scopes?: string[];
  error?: string;
}

export interface GithubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface GithubContent {
  path: string;
  encoding: string;
  content: string;
  sha: string;
  size: number;
  truncated: boolean;
  tooLarge: boolean;
}

export interface GithubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface DevEvent {
  id: number;
  session_id: string;
  goal_id: string | null;
  iteration_id: string | null;
  task_id: string | null;
  event_type: string;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export type AgentRole =
  | 'project_manager' | 'architect' | 'frontend' | 'backend' | 'full_stack'
  | 'testing' | 'deployment' | 'reviewer' | 'human';

/** Live flow state powering the agent diagram (GET sessions/:id/flow). */
export interface FlowAgentState {
  role: string;
  status: string;
  name: string;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  currentTaskStatus: string | null;
  lastUpdateAt: string | null;
  stuckMs: number | null;
}

export interface FlowHandoff {
  from: string;
  to: string;
  instruction: string;
  at: string | null;
  taskId: string | null;
  status: string;
}

export interface FlowState {
  assigner: string;
  iterationObjective: string | null;
  agents: FlowAgentState[];
  handoffs: FlowHandoff[];
  stuck: { role: string; reason: string; sinceMs: number | null; taskTitle: string | null; lastError?: string | null } | null;
}

export interface ClaudeAuthOption {
  method: 'oauth' | 'api_key' | 'org';
  label: string;
  description: string;
  envVar: string;
  recommended?: boolean;
  hint: string;
}

export const SESSION_STATUS_LABEL: Record<DevSessionStatus, string> = {
  idea_intake: 'Idea',
  planning: 'Planificando',
  awaiting_goals_approval: 'Esperando aprobación de goals',
  awaiting_architecture_approval: 'Esperando aprobación de arquitectura',
  running: 'En ejecución',
  waiting_for_human_setup: 'Esperando setup humano',
  waiting_for_human_secret: 'Esperando credenciales',
  waiting_for_human_review: 'Esperando revisión',
  waiting_for_human_validation: 'Esperando validación',
  paused: 'Pausada',
  blocked: 'Bloqueada',
  ready_for_release: 'Lista para release',
  ready_for_deploy: 'Lista para deploy',
  completed: 'Completada',
  failed: 'Fallida',
  cancelled: 'Cancelada',
};

export const GOAL_STATUS_LABEL: Record<DevGoalStatus, string> = {
  proposed: 'Propuesto',
  approved: 'Aprobado',
  in_progress: 'En progreso',
  blocked: 'Bloqueado',
  needs_user_decision: 'Necesita decisión',
  ready_for_validation: 'Listo para validar',
  validated: 'Validado',
  completed: 'Completado',
  paused: 'Pausado',
  cancelled: 'Cancelado',
};

// ── Project Planning (wizard) ─────────────────────────────────────────────────

export interface PlanSuccessCriterion {
  id: string;
  description: string;
  verifiable: boolean;
}

export interface PlanGoal {
  title: string;
  description: string;
  priority: number;
  successCriteria: PlanSuccessCriterion[];
}

export interface ProjectPlan {
  northStar: string;
  definitionOfDone: PlanSuccessCriterion[];
  goals: PlanGoal[];
  teamTier: 'small' | 'medium' | 'large';
  teamTierReason: string;
}

export const TEAM_TIER_AGENTS: Record<'small' | 'medium' | 'large', string[]> = {
  small: ['project_manager', 'full_stack'],
  medium: ['project_manager', 'architect', 'backend', 'frontend'],
  large: ['project_manager', 'architect', 'backend', 'frontend', 'testing', 'deployment', 'reviewer'],
};

export const AGENT_ROLE_EMOJI: Record<string, string> = {
  project_manager: '🧭',
  architect: '🏗️',
  frontend: '🎨',
  backend: '⚙️',
  full_stack: '🧰',
  testing: '🧪',
  deployment: '🚀',
  reviewer: '🔍',
  human: '👤',
};
