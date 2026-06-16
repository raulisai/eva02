import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { AgentLoopService } from '../agent/agent-loop.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { TasksService } from '../tasks/tasks.service';
import { DatabaseService } from '../database/database.service';
import { DevSessionService } from './dev-session.service';
import { DevProjectManagerService } from './dev-project-manager.service';
import { DevArchitectService } from './dev-architect.service';
import { ClaudeCodeRunnerService, CLAUDE_AUTH_OPTIONS } from './claude-code-runner.service';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  DevSession, DevGoal, DevIteration, AGENT_SYSTEM_PROMPTS,
  AgentRole, DevGoalStatus,
} from './dev-studio.types';

// Max iterations per goal before stopping and asking user
const MAX_ITERATIONS_PER_GOAL = 10;

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  project_manager: 'PM Agent',
  architect: 'Architect Agent',
  backend: 'Backend Agent',
  frontend: 'Frontend Agent',
  testing: 'Testing Agent',
  deployment: 'Deployment Agent',
  reviewer: 'Reviewer Agent',
};

// Roles that run on Claude Code (in a pre-baked sandbox) instead of the API loop.
const CODE_ROLES = new Set<string>(['backend', 'frontend', 'testing']);

interface TickResult {
  action: 'none' | 'iteration_created' | 'tasks_dispatched' | 'human_task_created' | 'goals_complete' | 'waiting';
  message: string;
  iterationId?: string;
}

@Injectable()
export class DevOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(DevOrchestratorService.name);
  // Track in-flight ticks to avoid concurrent ticks on same session
  private readonly activeTicks = new Set<string>();

  constructor(
    private readonly events: EventBusService,
    private readonly agentLoop: AgentLoopService,
    private readonly modelRouter: ModelRouterService,
    private readonly tasks: TasksService,
    private readonly db: DatabaseService,
    private readonly sessionService: DevSessionService,
    private readonly pm: DevProjectManagerService,
    private readonly architect: DevArchitectService,
    private readonly approvals: ApprovalsService,
    private readonly claudeCode: ClaudeCodeRunnerService,
  ) {}

  onModuleInit() {
    // Subscribe to events that should trigger an orchestrator tick
    if (typeof this.events.on !== 'function') return;

    this.events.on('dev.iteration.updated' as any, async (event) => {
      const payload = event.payload as { iterationId?: string; status?: string; sessionId?: string };
      if (payload.status === 'completed' || payload.status === 'evaluating') {
        // Find session from iteration
        if (payload.sessionId) {
          await this.tickSafe(payload.sessionId, event.orgId);
        }
      }
    });

    this.events.on('dev.human_task.verified' as any, async (event) => {
      const payload = event.payload as { sessionId?: string };
      if (payload.sessionId) {
        await this.tickSafe(payload.sessionId, event.orgId);
      }
    });

    // Auto-start sessions created via the chat gate (explicit trigger without handshake)
    this.events.on('dev.session.created' as any, async (event) => {
      const payload = event.payload as { sessionId?: string; autoStart?: boolean };
      if (payload.autoStart && payload.sessionId) {
        await this.startSession(payload.sessionId, event.orgId).catch((err) =>
          this.logger.error(`Auto-start session ${payload.sessionId}: ${err.message}`),
        );
      }
    });

    this.logger.log('DevOrchestrator subscribed to iteration.updated + human_task.verified + session.created(autoStart)');
  }

  private async tickSafe(sessionId: string, orgId: string): Promise<void> {
    try {
      await this.tick(sessionId, orgId);
    } catch (err) {
      this.logger.error(`Orchestrator tick error for session ${sessionId}: ${(err as Error).message}`);
    }
  }

  /**
   * Core orchestrator loop. Called:
   * - When a session starts
   * - When an iteration completes
   * - When a human task is verified
   * - On heartbeat (anti-abandonment via scheduled_jobs)
   * - Never when the session is paused/cancelled/completed/failed
   */
  async tick(sessionId: string, orgId: string): Promise<TickResult> {
    if (this.activeTicks.has(sessionId)) {
      this.logger.log(`Tick skipped — already in progress for session ${sessionId}`);
      return { action: 'none', message: 'Tick already in progress' };
    }
    this.activeTicks.add(sessionId);

    try {
      return await this._tick(sessionId, orgId);
    } finally {
      this.activeTicks.delete(sessionId);
    }
  }

  private async _tick(sessionId: string, orgId: string): Promise<TickResult> {
    const session = await this.sessionService.findById(sessionId, orgId);
    if (!session) return { action: 'none', message: 'Session not found' };

    // Respect terminal and paused states
    const nonRunningStates = ['paused', 'cancelled', 'completed', 'failed', 'blocked'];
    if (nonRunningStates.includes(session.status)) {
      return { action: 'none', message: `Session is ${session.status}` };
    }

    await this.sessionService.logEvent({
      orgId,
      sessionId,
      eventType: 'orchestrator.tick',
      message: `Tick en estado: ${session.status}`,
    });

    const goals = await this.sessionService.listGoals(sessionId, orgId);
    const approvedGoals = goals.filter((g) => ['approved', 'in_progress'].includes(g.status));
    const incompleteGoals = goals.filter((g) =>
      ['approved', 'in_progress', 'blocked', 'needs_user_decision'].includes(g.status),
    );

    // ── 1. All goals complete? ────────────────────────────────────────────────
    if (goals.length > 0 && incompleteGoals.length === 0) {
      await this.sessionService.transition(sessionId, orgId, 'ready_for_release');
      const closeMessage = await this.pm.generateSessionCloseMessage(session, goals);
      await this.sessionService.logEvent({ orgId, sessionId, eventType: 'session.goals_complete', message: closeMessage });
      await this.emitToSession(orgId, sessionId, 'dev.goals_complete', { sessionId, message: closeMessage });
      return { action: 'goals_complete', message: closeMessage };
    }

    if (approvedGoals.length === 0) {
      return { action: 'waiting', message: 'No approved goals to work on' };
    }

    // ── 2. Check for pending human tasks (session is blocked on human) ────────
    const pendingHumanTasks = await this.sessionService.listHumanTasks(sessionId, orgId, 'pending');
    const submittedHumanTasks = await this.sessionService.listHumanTasks(sessionId, orgId, 'submitted');
    if (pendingHumanTasks.length > 0 || submittedHumanTasks.length > 0) {
      const waitStatus = pendingHumanTasks.length > 0 ? 'waiting_for_human_setup' : 'waiting_for_human_validation';
      if (session.status !== waitStatus) {
        await this.sessionService.transition(sessionId, orgId, waitStatus as any);
      }
      return { action: 'waiting', message: `Waiting for ${pendingHumanTasks.length + submittedHumanTasks.length} human task(s)` };
    }

    // ── 3. Pick highest-priority unblocked goal ───────────────────────────────
    const goal = approvedGoals
      .filter((g) => g.status !== 'blocked')
      .sort((a, b) => b.priority - a.priority)[0];

    if (!goal) {
      return { action: 'waiting', message: 'All active goals are blocked' };
    }

    // ── 4. Check active tasks for this goal ───────────────────────────────────
    const activeTasks = await this.sessionService.listStudioTasks(sessionId, orgId, 'running');
    const queuedTasks = await this.sessionService.listStudioTasks(sessionId, orgId, 'queued');
    const assignedTasks = await this.sessionService.listStudioTasks(sessionId, orgId, 'assigned');

    if (activeTasks.length > 0 || assignedTasks.length > 0) {
      // Tasks are running — monitor only
      return { action: 'waiting', message: `${activeTasks.length + assignedTasks.length} task(s) in flight` };
    }

    // ── 5. never_stop: no active tasks but goal incomplete → new iteration ─────
    const policy = session.continuation_policy;
    const neverStop = policy?.never_stop_just_because_tasks_are_empty !== false;

    if (queuedTasks.length > 0) {
      // Queued tasks exist — dispatch them
      return await this.dispatchQueuedTasks(session, orgId, goal);
    }

    // Check if goal exceeded max iterations
    const iterations = await this.sessionService.listIterations(sessionId, orgId, goal.id);
    const completedIterations = iterations.filter((i) => i.status === 'completed');
    const maxIter = policy?.max_iterations_per_goal ?? MAX_ITERATIONS_PER_GOAL;

    if (completedIterations.length >= maxIter) {
      // Budget exhausted for this goal — ask human
      await this.sessionService.updateGoalStatus(goal.id, orgId, 'needs_user_decision');
      const humanTask = await this.sessionService.createHumanTask({
        orgId,
        sessionId,
        goalId: goal.id,
        title: `Goal "${goal.title}" alcanzó el límite de iteraciones (${maxIter})`,
        description: `El goal ha tenido ${completedIterations.length} iteraciones sin completarse. ¿Quieres continuar, reducir el alcance, o cancelar este goal?`,
        requiredOutput: 'Decisión: continuar / reducir alcance / cancelar',
        sensitive: false,
      });
      await this.sessionService.logEvent({
        orgId, sessionId, eventType: 'goal.max_iterations_reached',
        message: `Goal "${goal.title}" superó el límite de ${maxIter} iteraciones. Human task creada.`,
        goalId: goal.id,
      });
      return { action: 'human_task_created', message: `Max iterations reached for goal "${goal.title}"` };
    }

    if (!neverStop && completedIterations.length > 0) {
      return { action: 'waiting', message: 'Policy: stopping on empty tasks' };
    }

    // ── 6. Evaluate last iteration if exists ──────────────────────────────────
    const lastIteration = iterations.find((i) => i.status === 'completed' || i.status === 'evaluating');
    if (lastIteration && lastIteration.status !== 'evaluating') {
      return await this.evaluateAndContinueOrClose(session, orgId, goal, lastIteration, iterations.length + 1);
    }

    // ── 7. Create first or next iteration ─────────────────────────────────────
    return await this.createNewIteration(session, orgId, goal, null, iterations.length + 1);
  }

  private async evaluateAndContinueOrClose(
    session: DevSession,
    orgId: string,
    goal: DevGoal,
    lastIteration: DevIteration,
    nextIterationNumber: number,
  ): Promise<TickResult> {
    // Mark iteration as evaluating
    await this.sessionService.updateIterationStatus(lastIteration.id, orgId, 'evaluating');

    const evaluation = await this.pm.evaluateGoalCompletion(session, goal, lastIteration);

    await this.sessionService.updateIterationStatus(lastIteration.id, orgId, evaluation.needsMoreWork ? 'needs_more_work' : 'completed', {
      evaluation: {
        goal_score: evaluation.score,
        completed_criteria: evaluation.completedCriteria,
        missing_criteria: evaluation.missingCriteria,
        summary: evaluation.summary,
        needs_more_work: evaluation.needsMoreWork,
      },
    });

    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'iteration.evaluated',
      message: `Iteración "${lastIteration.title}" — score: ${evaluation.score.toFixed(2)}, ${evaluation.needsMoreWork ? 'necesita más trabajo' : 'completa'}`,
      goalId: goal.id, iterationId: lastIteration.id,
    });

    if (!evaluation.needsMoreWork && evaluation.score >= 0.8) {
      // Goal ready for validation
      await this.sessionService.updateGoalStatus(goal.id, orgId, 'ready_for_validation', {
        current_score: evaluation.score,
      });

      const humanTask = await this.sessionService.createHumanTask({
        orgId,
        sessionId: session.id,
        goalId: goal.id,
        iterationId: lastIteration.id,
        title: `Validar goal: "${goal.title}"`,
        description: `El agente considera este goal completado (score: ${(evaluation.score * 100).toFixed(0)}%).\n\n${evaluation.summary}\n\nPor favor valida que el resultado cumple los criterios.`,
        requiredOutput: 'Confirmar que el goal está completo o indicar qué falta',
        sensitive: false,
      });

      await this.emitToSession(orgId, session.id, 'dev.goal.ready_for_validation', {
        sessionId: session.id, goalId: goal.id,
        humanTaskId: humanTask.id,
        summary: evaluation.summary,
      });

      return {
        action: 'human_task_created',
        message: `Goal "${goal.title}" listo para validación humana`,
      };
    }

    // Needs more work — create next iteration
    return await this.createNewIteration(session, orgId, goal, evaluation, nextIterationNumber);
  }

  private async createNewIteration(
    session: DevSession,
    orgId: string,
    goal: DevGoal,
    evaluation: { score: number; completedCriteria: string[]; missingCriteria: string[]; summary: string; needsMoreWork: boolean; suggestedNextObjective: string } | null,
    iterationNumber: number,
  ): Promise<TickResult> {
    // Update goal status
    if (goal.status === 'approved') {
      await this.sessionService.updateGoalStatus(goal.id, orgId, 'in_progress');
    }
    await this.sessionService.incGoalIterationCount(goal.id, orgId);

    // Plan iteration
    let iterPlan: { title: string; objective: string; plannedOutputs: string[] };
    if (evaluation) {
      iterPlan = await this.pm.planNextIteration(session, goal, evaluation, iterationNumber);
    } else {
      // First iteration — objective from the goal itself
      iterPlan = {
        title: `Iteración #${iterationNumber} — ${goal.title}`,
        objective: goal.description ?? goal.title,
        plannedOutputs: (goal.success_criteria as any[]).map((c) => `Cumplir: ${c.description}`),
      };
    }

    const iteration = await this.sessionService.createIteration({
      orgId,
      sessionId: session.id,
      goalId: goal.id,
      title: iterPlan.title,
      objective: iterPlan.objective,
      plannedOutputs: iterPlan.plannedOutputs,
      number: iterationNumber,
    });

    await this.sessionService.updateIterationStatus(iteration.id, orgId, 'running', {
      started_at: new Date().toISOString(),
    });

    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'iteration.started',
      message: `Iniciando ${iteration.title}: ${iteration.objective}`,
      goalId: goal.id, iterationId: iteration.id,
    });

    // Ensure session is running
    if (!['running'].includes(session.status)) {
      await this.sessionService.transition(session.id, orgId, 'running');
    }

    // Update session current iteration
    await this.db.admin
      .from('dev_sessions')
      .update({ current_goal_id: goal.id, current_iteration_id: iteration.id })
      .eq('id', session.id)
      .eq('org_id', orgId);

    // Derive tasks via architect
    const architectPlan = await this.architect.deriveTasks(session, goal, iteration);

    if (architectPlan.humanApprovalRequired) {
      const humanTask = await this.sessionService.createHumanTask({
        orgId,
        sessionId: session.id,
        goalId: goal.id,
        iterationId: iteration.id,
        title: `Aprobación de arquitectura: ${iteration.title}`,
        description: architectPlan.humanApprovalReason ?? 'El Architect Agent necesita aprobación antes de proceder.',
        requiredOutput: 'Aprobación o ajuste del plan de arquitectura',
        sensitive: false,
        instructions: { architecturePlan: architectPlan },
      });
      await this.sessionService.transition(session.id, orgId, 'waiting_for_human_review');
      return {
        action: 'human_task_created',
        message: `Arquitectura requiere aprobación para iteración ${iterationNumber}`,
        iterationId: iteration.id,
      };
    }

    // Register only the agents actually needed for these tasks
    await this.sessionService.ensureAgent({ orgId, sessionId: session.id, role: 'project_manager', name: AGENT_DISPLAY_NAMES.project_manager });
    await this.sessionService.ensureAgent({ orgId, sessionId: session.id, role: 'architect', name: AGENT_DISPLAY_NAMES.architect });
    const neededRoles = [...new Set(architectPlan.tasks.map((t) => t.role))];
    for (const role of neededRoles) {
      await this.sessionService.ensureAgent({ orgId, sessionId: session.id, role, name: AGENT_DISPLAY_NAMES[role] ?? `${role} Agent` });
    }

    // Create studio tasks for each technical task
    const createdTaskIds: string[] = [];
    const taskIndexToId: Map<number, string> = new Map();

    for (let i = 0; i < architectPlan.tasks.length; i++) {
      const t = architectPlan.tasks[i];
      const devTask = await this.sessionService.createStudioTask({
        orgId,
        sessionId: session.id,
        goalId: goal.id,
        iterationId: iteration.id,
        title: t.title,
        prompt: t.prompt,
        role: t.role,
        priority: t.priority,
        dependsOn: [],
        acceptanceCriteria: t.acceptanceCriteria,
        branchName: t.branchName,
        userId: session.user_id,
      });
      const taskId = (devTask as { id: string }).id;
      taskIndexToId.set(i, taskId);
      createdTaskIds.push(taskId);
    }

    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'tasks.created',
      message: `Architect creó ${createdTaskIds.length} tareas técnicas`,
      goalId: goal.id, iterationId: iteration.id,
      payload: { taskIds: createdTaskIds, architectureNotes: architectPlan.architectureNotes },
    });

    await this.emitToSession(orgId, session.id, 'dev.tasks.created', {
      sessionId: session.id, iterationId: iteration.id, goalId: goal.id,
      taskCount: createdTaskIds.length,
    });

    // Dispatch tasks using wave executor (parallel by dependency)
    this.dispatchTaskWaves(session, orgId, iteration, architectPlan.tasks, taskIndexToId).catch((err) =>
      this.logger.error(`Wave dispatch error for session ${session.id}: ${err.message}`),
    );

    return {
      action: 'iteration_created',
      message: `Iteración #${iterationNumber} creada con ${createdTaskIds.length} tareas`,
      iterationId: iteration.id,
    };
  }

  private async dispatchQueuedTasks(session: DevSession, orgId: string, goal: DevGoal): Promise<TickResult> {
    const queued = await this.sessionService.listStudioTasks(session.id, orgId, 'queued');
    const dispatched = await this.runWaveFromQueued(session, orgId, queued);
    return {
      action: 'tasks_dispatched',
      message: `Dispatched ${dispatched} queued task(s)`,
    };
  }

  /**
   * Wave executor: run tasks in parallel by dependency level.
   * Reuses the same DAG logic as PipelineRunnerService but for DevStudio tasks.
   */
  private async dispatchTaskWaves(
    session: DevSession,
    orgId: string,
    iteration: DevIteration,
    tasks: Array<{ title: string; prompt: string; role: string; dependsOn: string[]; acceptanceCriteria: any[]; branchName: string }>,
    taskIndexToId: Map<number, string>,
  ): Promise<void> {
    // Gate: code roles run on Claude Code. If any code task is present and the org
    // has no Claude Code credential, pause and ask the user to provision one.
    const needsClaude = tasks.some((t) => CODE_ROLES.has(t.role));
    if (needsClaude && !(await this.claudeCode.hasCredential(orgId))) {
      // Leave the studio tasks queued so a later tick dispatches them once provisioned.
      for (const id of taskIndexToId.values()) {
        if (id) await this.sessionService.updateStudioTaskStatus(id, orgId, 'queued').catch(() => undefined);
      }
      await this.ensureClaudeCodeProvisioningTask(session, orgId, iteration);
      return;
    }

    // Map task index-based deps to actual task IDs
    const taskIds = Array.from({ length: tasks.length }, (_, i) => taskIndexToId.get(i) ?? '');

    const status: Record<string, 'pending' | 'running' | 'completed' | 'failed' | 'skipped'> = {};
    taskIds.forEach((id) => { if (id) status[id] = 'pending'; });

    // Rebuild dependsOn as task IDs
    const depsById: Record<string, string[]> = {};
    for (let i = 0; i < tasks.length; i++) {
      const taskId = taskIds[i];
      if (!taskId) continue;
      depsById[taskId] = (tasks[i].dependsOn ?? [])
        .map((dep) => {
          const idx = parseInt(String(dep).replace('task-', ''), 10);
          return !isNaN(idx) ? (taskIndexToId.get(idx) ?? '') : dep;
        })
        .filter(Boolean);
    }

    let wave = 0;
    while (Object.values(status).some((s) => s === 'pending')) {
      const ready = taskIds.filter((id) => {
        if (!id || status[id] !== 'pending') return false;
        return (depsById[id] ?? []).every((dep) => status[dep] === 'completed');
      });

      if (ready.length === 0) {
        // Unresolvable deps
        for (const id of taskIds) {
          if (status[id] === 'pending') {
            status[id] = 'skipped';
            await this.sessionService.updateStudioTaskStatus(id, orgId, 'failed');
          }
        }
        break;
      }

      wave++;
      await Promise.all(ready.map(async (taskId) => {
        status[taskId] = 'running';
        await this.sessionService.updateStudioTaskStatus(taskId, orgId, 'assigned');

        const taskDef = tasks[taskIds.indexOf(taskId)];
        const agentRole = (taskDef?.role ?? 'backend') as AgentRole;

        try {
          const success = await this.runAgentTask(session, orgId, taskId, taskDef?.prompt ?? taskDef?.title ?? '', agentRole, iteration);
          status[taskId] = success ? 'completed' : 'failed';

          if (!success) {
            // Detect blocker and create human task if needed
            await this.handleAgentFailure(session, orgId, taskId, iteration, null, 'Task execution failed');
          }
        } catch (err) {
          status[taskId] = 'failed';
          await this.handleAgentFailure(session, orgId, taskId, iteration, null, (err as Error).message);
        }
      }));
    }

    // Evaluate iteration when all tasks done
    const allFailed = Object.values(status).every((s) => s === 'failed' || s === 'skipped');
    const anyCompleted = Object.values(status).some((s) => s === 'completed');

    await this.sessionService.updateIterationStatus(iteration.id, orgId, allFailed ? 'needs_more_work' : 'completed', {
      completed_at: new Date().toISOString(),
      completed_outputs: anyCompleted ? [`Wave ${wave} completed`] : [],
    });

    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'iteration.completed',
      message: `Iteración "${iteration.title}" finalizada. Wave ${wave}. ${anyCompleted ? 'Algunos tasks OK' : 'Todos fallaron'}`,
      iterationId: iteration.id,
    });

    // Trigger next tick
    await this.tickSafe(session.id, orgId);
  }

  /**
   * Create a human task asking the user to provision Claude Code (choose an auth
   * method + provide the token) the first time a code agent needs it. Idempotent:
   * skips if a pending provisioning task already exists.
   */
  private async ensureClaudeCodeProvisioningTask(
    session: DevSession,
    orgId: string,
    iteration: DevIteration,
  ): Promise<void> {
    const pending = await this.sessionService.listHumanTasks(session.id, orgId, 'pending');
    const exists = pending.some((t) => (t.instructions as Record<string, unknown> | undefined)?.kind === 'claude_code_auth');
    if (exists) return;

    await this.sessionService.createHumanTask({
      orgId,
      sessionId: session.id,
      iterationId: iteration.id,
      title: 'Conectar Claude Code para los agentes de código',
      description:
        'Los agentes de código (backend/frontend/testing) corren sobre Claude Code en una máquina dedicada. ' +
        'Elige cómo autenticar y pega el token correspondiente. Recomendado: token de suscripción (OAuth) de tu plan ya contratado.',
      requiredOutput: 'Método de autenticación + token de Claude Code',
      sensitive: true,
      instructions: { kind: 'claude_code_auth', options: CLAUDE_AUTH_OPTIONS },
    });

    await this.sessionService.transition(session.id, orgId, 'waiting_for_human_setup');
    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'agent.blocked',
      message: 'Esperando credenciales de Claude Code para los agentes de código.',
      iterationId: iteration.id,
    });
    await this.emitToSession(orgId, session.id, 'dev.human_task.created', {
      sessionId: session.id, kind: 'claude_code_auth',
    });
  }

  private async runWaveFromQueued(session: DevSession, orgId: string, tasks: Record<string, unknown>[]): Promise<number> {
    let dispatched = 0;
    // Simple: run all queued in parallel (no dep resolution for re-dispatch)
    await Promise.all(tasks.map(async (task) => {
      const taskId = task.id as string;
      const role = (task.role as AgentRole) ?? 'backend';
      const prompt = (task.prompt ?? task.title) as string;

      // Find the iteration for this task
      const { data: iterRow } = await this.db.admin
        .from('dev_iterations')
        .select('*')
        .eq('id', task.iteration_id as string)
        .maybeSingle();

      if (!iterRow) return;

      await this.sessionService.updateStudioTaskStatus(taskId, orgId, 'assigned');
      await this.runAgentTask(session, orgId, taskId, prompt, role, iterRow as DevIteration).catch(() => undefined);
      dispatched++;
    }));
    return dispatched;
  }

  private async runAgentTask(
    session: DevSession,
    orgId: string,
    studioTaskId: string,
    prompt: string,
    role: AgentRole,
    iteration: DevIteration,
  ): Promise<boolean> {
    // Build role-specific context
    const roleSystemPrompt = AGENT_SYSTEM_PROMPTS[role] ?? AGENT_SYSTEM_PROMPTS.backend;
    const roleContext = [
      `[DEV STUDIO — Rol: ${role.toUpperCase()}]`,
      `Sesión: "${session.title}"`,
      `North Star: ${session.north_star ?? 'N/A'}`,
      `Iteración actual: ${iteration.title} — ${iteration.objective}`,
      `Stack: ${JSON.stringify(session.metadata?.stack ?? 'Definir')}`,
      `\nRol del agente:\n${roleSystemPrompt}`,
    ].join('\n');

    // Create a backing task in the main tasks table for AgentLoop
    const { data: backingTask } = await this.db.admin
      .from('tasks')
      .insert({
        org_id: orgId,
        title: `[${role}] ${prompt.slice(0, 80)}`,
        input: prompt,
        status: 'pending',
        created_by: session.user_id,
        metadata: {
          dev_studio: true,
          session_id: session.id,
          iteration_id: iteration.id,
          studio_task_id: studioTaskId,
          role,
        },
      })
      .select()
      .single();

    if (!backingTask) return false;

    const backingTaskId = (backingTask as { id: string }).id;
    await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'running');

    // Update agent status to running
    const agentRecord = await this.sessionService.getAgent(session.id, orgId, role);
    if (agentRecord) {
      await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'running', { current_task_id: studioTaskId });
    }

    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'task.started',
      message: `[${role}] Iniciando: ${prompt.slice(0, 80)}`,
      iterationId: iteration.id, taskId: studioTaskId,
    });

    await this.emitToSession(orgId, session.id, 'dev.task.started', {
      sessionId: session.id, studioTaskId, role, iterationId: iteration.id,
    });

    try {
      await this.tasks.transition(backingTaskId, orgId, 'planning');
      await this.tasks.transition(backingTaskId, orgId, 'running');

      // Code roles run on Claude Code (pre-baked sandbox); others use the API loop.
      const useClaudeCode = CODE_ROLES.has(role) && (await this.claudeCode.hasCredential(orgId));
      const runtimeLabel = useClaudeCode ? 'claude-code' : 'agent-loop';

      let outcome: { ok: boolean; text?: string };
      if (useClaudeCode) {
        const result = await this.claudeCode.run({
          orgId,
          taskId: backingTaskId,
          prompt,
          context: roleContext,
          onEvent: async (ev) => {
            // Stream to task_events (Logs tab) and dev_events (timeline).
            await this.events.publish({
              type: 'task.step',
              orgId,
              taskId: backingTaskId,
              payload: { tool: ev.type === 'tool_call' ? ev.text : undefined, thought: ev.type === 'text' ? ev.text : undefined, claude: true, kind: ev.type, text: ev.text },
            }).catch(() => undefined);
            await this.sessionService.logEvent({
              orgId, sessionId: session.id, eventType: `claude.${ev.type}`,
              message: ev.text.slice(0, 500), iterationId: iteration.id, taskId: studioTaskId,
            });
          },
        });
        outcome = { ok: result.ok, text: result.resultSummary ?? result.text ?? result.error ?? '' };
      } else {
        outcome = await this.agentLoop.run(orgId, backingTaskId, prompt, {
          maxSteps: 12,
          context: roleContext,
          userId: session.user_id,
          log: async (msg, scope) => {
            await this.sessionService.logEvent({
              orgId, sessionId: session.id, eventType: `agent.log.${scope}`,
              message: msg, iterationId: iteration.id, taskId: studioTaskId,
            });
          },
        });
      }

      const success = outcome.ok;
      const resultSummary = outcome.text?.slice(0, 500) ?? '';

      await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, success ? 'needs_review' : 'failed', {
        result_summary: resultSummary,
      });

      await this.tasks.transition(backingTaskId, orgId, success ? 'completed' : 'failed', {
        result: success ? { text: resultSummary, model: runtimeLabel } : undefined,
        error: !success ? (outcome.text ?? `${runtimeLabel} failed`) : undefined,
      });

      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: success ? 'task.completed' : 'task.failed',
        message: `[${role}] ${success ? 'Completada' : 'Falló'}: ${resultSummary.slice(0, 200)}`,
        iterationId: iteration.id, taskId: studioTaskId,
      });

      await this.emitToSession(orgId, session.id, success ? 'dev.task.completed' : 'dev.task.failed', {
        sessionId: session.id, studioTaskId, role, success, resultSummary,
      });

      if (agentRecord) {
        await this.sessionService.updateAgentStatus(agentRecord.id, orgId, success ? 'completed' : 'failed', { current_task_id: null });
      }

      return success;
    } catch (err) {
      const errMsg = (err as Error).message;
      await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'failed', { result_summary: errMsg });
      await this.tasks.transition(backingTaskId, orgId, 'failed', { error: errMsg }).catch(() => undefined);
      if (agentRecord) {
        await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'failed', { current_task_id: null });
      }
      return false;
    }
  }

  private async handleAgentFailure(
    session: DevSession,
    orgId: string,
    taskId: string,
    iteration: DevIteration,
    goal: DevGoal | null,
    errorContext: string,
  ): Promise<void> {
    const blocker = await this.pm.detectBlocker(errorContext);
    const requiresHuman = ['missing_credentials', 'missing_account', 'missing_permission', 'quota_exhausted'].includes(blocker.type);

    if (requiresHuman) {
      await this.sessionService.createHumanTask({
        orgId,
        sessionId: session.id,
        goalId: goal?.id,
        iterationId: iteration.id,
        title: blocker.title,
        description: blocker.description,
        sensitive: blocker.sensitive,
        blocksTaskIds: [taskId],
        requiredOutput: `Resolver: ${blocker.type}`,
      });

      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'agent.blocked',
        message: `Blocker [${blocker.type}]: ${blocker.description.slice(0, 200)}`,
        iterationId: iteration.id, taskId,
      });
    }
  }

  private async emitToSession(orgId: string, sessionId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.publish({
      type: eventType as any,
      orgId,
      payload: { ...payload, sessionId },
    });
  }

  // ── Public API for controller ─────────────────────────────────────────────

  async startSession(sessionId: string, orgId: string): Promise<void> {
    const session = await this.sessionService.findByIdOrThrow(sessionId, orgId);

    // Generate North Star + Goals from original prompt
    await this.sessionService.transition(sessionId, orgId, 'planning');

    const northStarResult = await this.pm.generateNorthStarAndGoals(session);

    await this.sessionService.setNorthStar(sessionId, orgId, northStarResult.northStar, northStarResult.definitionOfDone);

    // Create goals
    for (const goalDef of northStarResult.goals) {
      await this.sessionService.createGoal({
        orgId,
        sessionId,
        title: goalDef.title,
        description: goalDef.description,
        priority: goalDef.priority,
        successCriteria: goalDef.successCriteria,
      });
    }

    await this.sessionService.transition(sessionId, orgId, 'awaiting_goals_approval');

    await this.sessionService.logEvent({
      orgId, sessionId, eventType: 'goals.awaiting_approval',
      message: `North Star generada. ${northStarResult.goals.length} goals propuestos, esperando aprobación.`,
    });

    await this.emitToSession(orgId, sessionId, 'dev.session.updated', {
      sessionId, status: 'awaiting_goals_approval',
      northStar: northStarResult.northStar,
      goalCount: northStarResult.goals.length,
    });
  }

  async approveGoalsAndRun(sessionId: string, orgId: string, goalIds: string[]): Promise<void> {
    await this.sessionService.approveGoals(sessionId, orgId, goalIds);
    await this.sessionService.transition(sessionId, orgId, 'running');

    await this.sessionService.logEvent({
      orgId, sessionId, eventType: 'session.running',
      message: `${goalIds.length} goals aprobados. Orquestador iniciando.`,
    });

    // Fire first tick
    void this.tickSafe(sessionId, orgId);
  }

  async steerSession(sessionId: string, orgId: string, message: string): Promise<void> {
    const session = await this.sessionService.findByIdOrThrow(sessionId, orgId);

    // Find running backing tasks and inject steer
    const { data: runningTasks } = await this.db.admin
      .from('tasks')
      .select('id')
      .eq('org_id', orgId)
      .eq('status', 'running')
      .contains('metadata', { session_id: sessionId });

    for (const t of (runningTasks ?? []) as { id: string }[]) {
      await this.events.pushSteer(t.id, message);
    }

    await this.sessionService.logEvent({
      orgId, sessionId, eventType: 'session.steered',
      message: `Steer recibido: "${message.slice(0, 200)}"`,
    });
  }
}
