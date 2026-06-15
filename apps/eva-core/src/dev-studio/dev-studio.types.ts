export type DevSessionStatus =
  | 'idea_intake'
  | 'planning'
  | 'awaiting_goals_approval'
  | 'awaiting_architecture_approval'
  | 'running'
  | 'waiting_for_human_setup'
  | 'waiting_for_human_secret'
  | 'waiting_for_human_review'
  | 'waiting_for_human_validation'
  | 'paused'
  | 'blocked'
  | 'ready_for_release'
  | 'ready_for_deploy'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DevGoalStatus =
  | 'proposed'
  | 'approved'
  | 'in_progress'
  | 'blocked'
  | 'needs_user_decision'
  | 'ready_for_validation'
  | 'validated'
  | 'completed'
  | 'paused'
  | 'cancelled';

export type DevIterationStatus =
  | 'planned'
  | 'running'
  | 'evaluating'
  | 'needs_more_work'
  | 'needs_user_decision'
  | 'completed'
  | 'cancelled';

export type DevAgentStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'waiting_for_dependency'
  | 'completed'
  | 'failed';

export type DevHumanTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'waiting_user'
  | 'submitted'
  | 'verified'
  | 'rejected'
  | 'cancelled';

// Roles de agente especializado
export type AgentRole =
  | 'project_manager'
  | 'architect'
  | 'frontend'
  | 'backend'
  | 'testing'
  | 'deployment'
  | 'reviewer'
  | 'human';

export interface DevSession {
  id: string;
  org_id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  original_prompt: string;
  north_star: string | null;
  definition_of_done: SuccessCriterion[];
  status: DevSessionStatus;
  repo_url: string | null;
  base_branch: string;
  session_branch: string | null;
  current_goal_id: string | null;
  current_iteration_id: string | null;
  continuation_policy: ContinuationPolicy;
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
  success_criteria: SuccessCriterion[];
  current_score: number;
  target_score: number;
  owner_agent_role: AgentRole;
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
  evaluation: IterationEvaluation;
  created_by: string;
  number: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface DevAgent {
  id: string;
  org_id: string;
  session_id: string;
  role: AgentRole;
  name: string;
  status: DevAgentStatus;
  runtime: string;
  node_id: string | null;
  current_task_id: string | null;
  branch_name: string | null;
  container_id: string | null;
  budget: Record<string, unknown>;
  last_heartbeat_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DevHumanTask {
  id: string;
  org_id: string;
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
  org_id: string;
  session_id: string;
  task_id: string | null;
  source_branch: string;
  target_branch: string;
  status: 'pending' | 'approved' | 'rejected' | 'merged' | 'conflicted';
  diff_summary: string | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  test_result: Record<string, unknown>;
  reviewer_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SuccessCriterion {
  id: string;
  description: string;
  verifiable: boolean;
  verified?: boolean;
}

export interface ContinuationPolicy {
  default: string;
  never_stop_just_because_tasks_are_empty: boolean;
  ask_user_when: string[];
  auto_create_iteration_when: string[];
  max_iterations_per_goal: number;
  budget_token_limit: number;
}

export interface IterationEvaluation {
  goal_score?: number;
  completed_criteria?: string[];
  missing_criteria?: string[];
  summary?: string;
  needs_more_work?: boolean;
}

// Resultado del clasificador de modo desarrollo
export interface DevModeClassification {
  isDevProject: boolean;
  confidence: number;
  reason: string;
  requiresHandshake: boolean;
  extractedTitle?: string;
}

// Transiciones válidas de sesión
export const DEV_SESSION_TRANSITIONS: Record<DevSessionStatus, DevSessionStatus[]> = {
  idea_intake: ['planning', 'cancelled'],
  planning: ['awaiting_goals_approval', 'cancelled'],
  awaiting_goals_approval: ['awaiting_architecture_approval', 'planning', 'cancelled'],
  awaiting_architecture_approval: ['running', 'planning', 'cancelled'],
  running: [
    'waiting_for_human_setup',
    'waiting_for_human_secret',
    'waiting_for_human_review',
    'waiting_for_human_validation',
    'paused',
    'blocked',
    'ready_for_release',
    'ready_for_deploy',
    'completed',
    'failed',
    'cancelled',
  ],
  waiting_for_human_setup: ['running', 'blocked', 'paused', 'cancelled'],
  waiting_for_human_secret: ['running', 'blocked', 'paused', 'cancelled'],
  waiting_for_human_review: ['running', 'blocked', 'paused', 'cancelled'],
  waiting_for_human_validation: ['running', 'blocked', 'paused', 'cancelled'],
  paused: ['running', 'cancelled'],
  blocked: ['running', 'paused', 'failed', 'cancelled'],
  ready_for_release: ['running', 'completed', 'cancelled'],
  ready_for_deploy: ['completed', 'running', 'cancelled'],
  completed: [],
  failed: ['planning'],
  cancelled: [],
};

export function isValidSessionTransition(current: DevSessionStatus, next: DevSessionStatus): boolean {
  return current === next || (DEV_SESSION_TRANSITIONS[current] ?? []).includes(next);
}

// Transiciones válidas de goal
export const DEV_GOAL_TRANSITIONS: Record<DevGoalStatus, DevGoalStatus[]> = {
  proposed: ['approved', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['blocked', 'needs_user_decision', 'ready_for_validation', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  needs_user_decision: ['in_progress', 'cancelled'],
  ready_for_validation: ['validated', 'in_progress'],
  validated: ['completed'],
  completed: [],
  paused: ['in_progress', 'cancelled'],
  cancelled: [],
};

export function isValidGoalTransition(current: DevGoalStatus, next: DevGoalStatus): boolean {
  return current === next || (DEV_GOAL_TRANSITIONS[current] ?? []).includes(next);
}

// System prompts base para cada rol
export const AGENT_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  project_manager: `Eres el Project Manager Agent de EVA Development Studio.
Tu responsabilidad no es terminar tareas, sino completar goals de producto.
Nunca cierres un proyecto solo porque no hay tareas activas.
Si hay goals incompletos, crea una nueva iteración o identifica bloqueos.
Si un bloqueo requiere al humano, crea una human task clara, accionable y verificable.
Si todos los goals están completos, pregunta al usuario si quiere preparar release, crear nuevos goals, pausar o cerrar.
Evalúa cada iteración contra criterios de éxito definidos, no contra "tareas completadas".
No permitas que un goal pase a completed sin validación técnica y, cuando aplique, validación humana.
Responde SIEMPRE en JSON estructurado.`,

  architect: `Eres el Architect Agent de EVA Development Studio.
Tu responsabilidad es convertir goals e iteraciones en arquitectura, decisiones técnicas y tareas ejecutables.
Minimiza deuda técnica, separa responsabilidades y detecta riesgos.
Cuando una decisión afecte auth, permisos, base de datos, multi-tenancy, costos, deploy o seguridad, solicita revisión humana.
No debes hacer merge directo. Produce propuestas revisables.
Cada tarea debe tener criterios de aceptación claros y verificables.
Responde SIEMPRE en JSON estructurado.`,

  frontend: `Eres el Frontend Agent de EVA Development Studio.
Construyes UI, creas componentes, integras APIs, implementas estados de carga/error/vacío.
Si el contrato API no está definido, repórtalo como blocker.
Trabaja en tu branch asignada. No mergees directo.
Genera una descripción de lo que construiste al finalizar cada tarea.`,

  backend: `Eres el Backend Agent de EVA Development Studio.
Creas endpoints, servicios, migraciones y lógica de negocio.
Controlas autorización y multi-tenancy. Integras proveedores externos.
Si necesitas secrets o cuentas externas, repórtalo como blocker explícito con tipo missing_credentials.
Trabaja en tu branch asignada. No mergees directo.`,

  testing: `Eres el Testing Agent de EVA Development Studio.
Creas tests unitarios, de integración y e2e según aplique.
Validas criterios de aceptación de cada tarea. Detectas regresiones.
Produces un reporte de calidad con tests pasados/fallidos.
Si un test falla, repórtalo con contexto suficiente para que el agente responsable lo corrija.`,

  deployment: `Eres el Deployment Agent de EVA Development Studio.
Preparas Docker, variables de ambiente y CI/CD.
Validas health checks. Preparas staging.
Nunca despliega a producción sin aprobación humana explícita a través del Approval Engine.
Si faltan secrets, repórtalo como blocker.`,

  reviewer: `Eres el Reviewer Agent de EVA Development Studio.
Revisas diffs, detectas conflictos, validas que los tests pasen.
Integras branches. Rechazas cambios incompletos o sin tests.
Pides correcciones con contexto específico (archivo, línea, razón).
No apruebas ningún merge sin que los criterios de aceptación estén verificados.`,

  human: `Tú eres el contributor humano del equipo.`,
};
