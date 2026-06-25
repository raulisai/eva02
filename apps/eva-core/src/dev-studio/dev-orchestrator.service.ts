import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { AgentLoopService } from '../agent/agent-loop.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { TasksService } from '../tasks/tasks.service';
import { DatabaseService } from '../database/database.service';
import { DevSessionService } from './dev-session.service';
import { DevProjectManagerService } from './dev-project-manager.service';
import { DevArchitectService } from './dev-architect.service';
import { ClaudeCodeRunnerService, CLAUDE_AUTH_OPTIONS } from './claude-code-runner.service';
import { GithubService, GithubNotConnectedError } from './github/github.service';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  DevSession, DevGoal, DevIteration, AGENT_SYSTEM_PROMPTS,
  AgentRole, DevGoalStatus, TeamTier, TEAM_TIER_CONFIG,
  DevMergeProposal, SuccessCriterion,
} from './dev-studio.types';
import { agentBranchName, agentGitIdentity, slugify } from './dev-studio.utils';

/** GitHub repo context resolved for a session (git flow enabled). */
interface SessionRepoContext {
  owner: string;
  repo: string;
  repoUrl: string;
  integrationBranch: string;
  token: string;
}

// Max iterations per goal before stopping and asking user
const MAX_ITERATIONS_PER_GOAL = 10;

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  project_manager: 'PM Agent',
  architect: 'Architect Agent',
  backend: 'Backend Agent',
  frontend: 'Frontend Agent',
  full_stack: 'Full Stack Agent',
  testing: 'Testing Agent',
  deployment: 'Deployment Agent',
  reviewer: 'Reviewer Agent',
};

// Roles that run on Claude Code (in a pre-baked sandbox) instead of the API loop.
const CODE_ROLES = new Set<string>(['backend', 'frontend', 'full_stack', 'testing']);

interface TickResult {
  action: 'none' | 'iteration_created' | 'tasks_dispatched' | 'human_task_created' | 'goals_complete' | 'waiting';
  message: string;
  iterationId?: string;
}

// Heartbeat: how often to sweep for stranded sessions, and the staleness
// thresholds that mark a session/iteration as "abandoned" and safe to nudge.
const HEARTBEAT_MS = 2 * 60 * 1000;
const SESSION_STALE_MS = 3 * 60 * 1000;
const ITERATION_STALE_MS = 15 * 60 * 1000;

// How long a task can sit in `assigned`/`running` without a status update before
// the orchestrator considers it a silent crash and auto-requeues it.
// 30 minutes: Claude Code tasks regularly take 15-30 min; the onEvent heartbeat
// touches updated_at every 60 s so a genuinely-live task never hits this limit.
const TASK_STUCK_MS = 30 * 60 * 1000;

@Injectable()
export class DevOrchestratorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevOrchestratorService.name);
  // Track in-flight ticks to avoid concurrent ticks on same session
  private readonly activeTicks = new Set<string>();
  private heartbeatTimer?: NodeJS.Timeout;

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
    private readonly github: GithubService,
  ) {}

  onModuleInit() {
    // Subscribe to events that should trigger an orchestrator tick
    if (typeof this.events.on !== 'function') return;

    this.events.on('dev.iteration.updated' as any, async (event) => {
      const payload = event.payload as { iterationId?: string; status?: string; sessionId?: string };
      // `needs_more_work` also needs a re-tick so the loop continues without
      // relying on the direct tickSafe call inside dispatchTaskWaves.
      if (payload.status === 'completed' || payload.status === 'evaluating' || payload.status === 'needs_more_work') {
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

    // Release gate: when a release-merge approval is resolved, merge develop→main
    // (approved) or close the release PR (rejected). Non-release approvals are ignored.
    this.events.on('approval.resolved' as any, async (event) => {
      const payload = event.payload as { approvalId?: string; status?: string };
      if (!payload.approvalId) return;
      await this.handleReleaseApprovalResolved(payload.approvalId, payload.status ?? '', event.orgId).catch((err) =>
        this.logger.error(`Release approval handler failed: ${(err as Error).message}`),
      );
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

    // Anti-abandonment: recover crashed in-flight work on boot, then sweep
    // periodically so a session never strands in `running` with no re-tick.
    void this.recoverAndSweep('boot').catch((err) =>
      this.logger.error(`Boot reconciliation failed: ${(err as Error).message}`),
    );
    this.heartbeatTimer = setInterval(() => {
      void this.recoverAndSweep('heartbeat').catch((err) =>
        this.logger.error(`Heartbeat sweep failed: ${(err as Error).message}`),
      );
    }, HEARTBEAT_MS);
    // Don't keep the event loop alive just for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  /**
   * Reconcile stranded Dev Studio work:
   *  - iterations stuck in `running` past the stale threshold (their tasks were
   *    orphaned by a crash) → requeue the orphaned tasks so a tick re-dispatches;
   *  - sessions in `running` with no recent progress → nudge with a tick.
   * Idempotent: the per-session tick guard + _tick's own checks make extra ticks
   * harmless (they short-circuit when work is genuinely in flight).
   */
  private async recoverAndSweep(reason: 'boot' | 'heartbeat'): Promise<void> {
    // 1. Recover orphaned iterations — ONLY on boot, where nothing is in-flight.
    // Doing this on the periodic heartbeat could requeue tasks of a live wave and
    // duplicate work; per-task timeouts bound genuinely-hung live iterations.
    let recovered = 0;
    if (reason === 'boot') {
      const staleIters = await this.sessionService.listStaleRunningIterations(ITERATION_STALE_MS).catch(() => []);
      recovered = staleIters.length;
      for (const it of staleIters) {
        const requeued = await this.sessionService.requeueOrphanedTasks(it.id, it.org_id).catch(() => 0);
        if (requeued > 0) {
          await this.sessionService.logEvent({
            orgId: it.org_id, sessionId: it.session_id, eventType: 'iteration.recovered',
            message: `Reconciliación (${reason}): ${requeued} tarea(s) huérfana(s) re-encoladas tras posible reinicio/cuelgue.`,
            iterationId: it.id,
          }).catch(() => undefined);
        }
        await this.tickSafe(it.session_id, it.org_id);
      }
    }

    // 2. Nudge stale running sessions (idempotent — _tick short-circuits if busy).
    const staleSessions = await this.sessionService.listStaleRunningSessions(SESSION_STALE_MS).catch(() => []);
    for (const s of staleSessions) {
      await this.tickSafe(s.id, s.org_id);
    }

    if (recovered || staleSessions.length) {
      this.logger.log(`Sweep (${reason}): ${recovered} stale iteration(s) recovered, ${staleSessions.length} stale session(s) nudged`);
    }
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
    // In-process guard (fast) — prevents same-node concurrent ticks.
    if (this.activeTicks.has(sessionId)) {
      this.logger.log(`Tick skipped — already in progress for session ${sessionId}`);
      return { action: 'none', message: 'Tick already in progress' };
    }
    this.activeTicks.add(sessionId);

    // Cross-instance guard (Redis) — prevents two nodes ticking the same session
    // and duplicating iterations/tasks. Fail-open if Redis is unavailable.
    const lockKey = `devtick:${sessionId}`;
    const locked = typeof this.events.tryLock === 'function'
      ? await this.events.tryLock(lockKey, 60_000)
      : true;
    if (!locked) {
      this.activeTicks.delete(sessionId);
      return { action: 'none', message: 'Tick locked by another instance' };
    }

    try {
      return await this._tick(sessionId, orgId);
    } finally {
      this.activeTicks.delete(sessionId);
      if (typeof this.events.releaseLock === 'function') {
        await this.events.releaseLock(lockKey).catch(() => undefined);
      }
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
      // Open the release PR (develop → main) and gate it through the Approval Engine.
      await this.prepareReleasePr(session, orgId);
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
    const [activeTasks, queuedTasks, assignedTasks] = await Promise.all([
      this.sessionService.listStudioTasks(sessionId, orgId, 'running'),
      this.sessionService.listStudioTasks(sessionId, orgId, 'queued'),
      this.sessionService.listStudioTasks(sessionId, orgId, 'assigned'),
    ]);

    if (activeTasks.length > 0 || assignedTasks.length > 0) {
      // Before declaring "in flight", check whether any of these tasks have been
      // frozen for too long without a status update — that's a silent crash.
      const stuckTasks = await this.sessionService.listStuckInFlightTasks(sessionId, orgId, TASK_STUCK_MS);

      if (stuckTasks.length > 0) {
        // Auto-requeue: mark frozen tasks as queued and reset their agent status.
        this.logger.warn(
          `[tick] ${stuckTasks.length} task(s) stuck in ${[...new Set(stuckTasks.map((t) => t.status))].join('/')} ` +
          `for >${Math.round(TASK_STUCK_MS / 60_000)}min — auto-requeuing: ${stuckTasks.map((t) => t.title.slice(0, 40)).join(', ')}`,
        );

        for (const t of stuckTasks) {
          await this.sessionService.updateStudioTaskStatus(t.id, orgId, 'queued', {
            result_summary: `Auto-recolada: sin actividad durante ${Math.round(TASK_STUCK_MS / 60_000)} minutos (estado previo: ${t.status}).`,
          });
          await this.sessionService.logEvent({
            orgId, sessionId, eventType: 'task.stuck_requeued',
            message: `[${t.role}] Tarea "${t.title}" re-encolada automáticamente — sin avance desde ${new Date(t.updated_at).toLocaleTimeString()}.`,
            taskId: t.id,
          });
          // Reset agent to idle so it can pick up the re-queued task
          const agentRecord = await this.sessionService.getAgent(sessionId, orgId, t.role).catch(() => null);
          if (agentRecord) {
            await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'idle', { current_task_id: null });
          }
        }
        // Re-enter tick: now there should be queued tasks to dispatch
        return this._tick(sessionId, orgId);
      }

      // Tasks genuinely in-flight — monitor only
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

    // Derive tasks via architect (pass team tier so it constrains role selection)
    const teamTier = (session.metadata?.teamTier as TeamTier | undefined) ?? 'medium';
    const architectPlan = await this.architect.deriveTasks(session, goal, iteration, teamTier);

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

    // Register only the agents actually needed for these tasks.
    // PM + Architect are always present; technical roles come from the architect plan
    // and are already constrained to the session's team tier.
    const neededRoles = [
      'project_manager',
      'architect',
      ...new Set(architectPlan.tasks.map((t) => t.role)),
    ];
    for (const role of [...new Set(neededRoles)]) {
      await this.ensureAgentAndMachine(session, orgId, role, iteration);
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

    // Mark all newly created tasks as `assigned` BEFORE releasing the tick guard.
    // If we left them as `queued`, the next tick (fired immediately after this
    // function returns and the guard is released) would see queued tasks and
    // dispatch them via runWaveFromQueued — racing with the dispatchTaskWaves
    // fire-and-forget below and executing each task twice.
    for (const taskId of createdTaskIds) {
      await this.sessionService.updateStudioTaskStatus(taskId, orgId, 'assigned').catch(() => undefined);
    }

    // Dispatch tasks using wave executor (parallel by dependency).
    // Tasks are already `assigned`; dispatchTaskWaves will move them to `running`.
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
    let hasClaudeAuth = await this.claudeCode.hasCredential(orgId);
    if (needsClaude && !hasClaudeAuth) {
      const agents = await this.sessionService.listAgents(session.id, orgId).catch(() => []);
      for (const agent of agents) {
        if (CODE_ROLES.has(agent.role) && await this.claudeCode.hasCredential(orgId, agent.id)) {
          hasClaudeAuth = true;
          break;
        }
      }
    }
    if (needsClaude && !hasClaudeAuth) {
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
    // try/finally: a throw mid-wave must NOT leave the iteration stuck in
    // `running` forever — the finally always closes it and re-ticks.
    let threw: unknown = null;
    try {
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
              await this.sessionService.updateStudioTaskStatus(id, orgId, 'failed').catch(() => undefined);
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
    } catch (err) {
      threw = err;
      this.logger.error(`dispatchTaskWaves error (session ${session.id}, iter ${iteration.id}): ${(err as Error).message}`);
    } finally {
      // Evaluate iteration when all tasks done — judge by REAL task outputs, not
      // a generic "Wave N completed" string, so the PM can actually assess progress.
      const allFailed = Object.values(status).every((s) => s === 'failed' || s === 'skipped');
      const anyCompleted = Object.values(status).some((s) => s === 'completed');
      const outputs = await this.sessionService.buildIterationOutputs(iteration.id, orgId).catch(() => [] as string[]);

      await this.sessionService.updateIterationStatus(
        iteration.id, orgId,
        allFailed || threw ? 'needs_more_work' : 'completed',
        { completed_at: new Date().toISOString(), completed_outputs: outputs },
      ).catch((e) => this.logger.error(`updateIterationStatus failed: ${(e as Error).message}`));

      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: threw ? 'iteration.error' : 'iteration.completed',
        message: threw
          ? `Iteración "${iteration.title}" terminó con error: ${(threw as Error).message}`
          : `Iteración "${iteration.title}" finalizada. Wave ${wave}. ${anyCompleted ? `${outputs.length} output(s)` : 'Todos fallaron'}`,
        iterationId: iteration.id,
      }).catch(() => undefined);

      // Re-tick is driven by the dev.iteration.updated event published above by
      // updateIterationStatus (handles completed + needs_more_work + evaluating).
      // No direct call here to avoid double-ticking the same session.
    }
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

  /**
   * Resolve the GitHub repo context for a session and ensure the integration
   * branch (develop) exists. Returns null when the session has no repo configured
   * (git flow disabled — back-compat for older sessions). Throws
   * GithubNotConnectedError when a repo is set but the org has no GitHub token, so
   * the caller can surface the connect panel.
   */
  private async resolveSessionRepoContext(
    session: DevSession,
    orgId: string,
  ): Promise<SessionRepoContext | null> {
    if (!session.repo_url) return null;
    const token = await this.github.requireToken(orgId); // throws GithubNotConnectedError
    const { owner, repo } = GithubService.parseRepoUrl(session.repo_url);
    const integrationBranch = session.integration_branch || 'develop';
    const baseBranch = session.base_branch || 'main';
    try {
      await this.github.ensureBranch(orgId, owner, repo, integrationBranch, baseBranch);
    } catch (err) {
      // base_branch may not match the repo default (e.g. master) — retry from the
      // repo's actual default branch before giving up.
      const info = await this.github.getRepo(orgId, owner, repo).catch(() => null);
      if (info?.defaultBranch && info.defaultBranch !== baseBranch) {
        await this.github.ensureBranch(orgId, owner, repo, integrationBranch, info.defaultBranch);
      } else {
        throw err;
      }
    }
    return { owner, repo, repoUrl: session.repo_url, integrationBranch, token };
  }

  /** Surface a human task asking the user to connect GitHub (mirrors Claude Code provisioning). */
  private async ensureGithubProvisioningTask(
    session: DevSession,
    orgId: string,
    iteration: DevIteration,
  ): Promise<void> {
    const pending = await this.sessionService.listHumanTasks(session.id, orgId, 'pending');
    const exists = pending.some((t) => (t.instructions as Record<string, unknown> | undefined)?.kind === 'github_connect');
    if (exists) return;

    await this.sessionService.createHumanTask({
      orgId,
      sessionId: session.id,
      iterationId: iteration.id,
      title: 'Conectar GitHub para versionar el trabajo de los agentes',
      description:
        'Cada agente crea su propia rama, commitea con su identidad y abre un Pull Request hacia develop. ' +
        'Conecta un token de GitHub (fine-grained PAT con permisos contents:write y pull_requests:write) en ' +
        'Integraciones › Credenciales › GitHub.',
      requiredOutput: 'Token de GitHub conectado a nivel organización',
      sensitive: true,
      instructions: { kind: 'github_connect', provider: 'github' },
    });

    await this.sessionService.transition(session.id, orgId, 'waiting_for_human_setup');
    await this.sessionService.logEvent({
      orgId, sessionId: session.id, eventType: 'agent.blocked',
      message: 'Esperando conexión de GitHub para versionar el trabajo de los agentes.',
      iterationId: iteration.id,
    });
    await this.emitToSession(orgId, session.id, 'dev.human_task.created', {
      sessionId: session.id, kind: 'github_connect',
    });
  }

  /**
   * Open the feature PR (head → develop), record it as a merge proposal, and run
   * the Architect's review. On approve the architect merges to develop; on
   * changes_requested the task is flagged so the goal re-iterates. PR/review
   * failures are surfaced as events and never crash the task.
   */
  private async openAndReviewFeaturePr(args: {
    session: DevSession; orgId: string; studioTaskId: string; role: AgentRole;
    iteration: DevIteration; repoCtx: SessionRepoContext; branch: string;
    headSha?: string; taskPrompt: string;
  }): Promise<void> {
    const { session, orgId, studioTaskId, role, iteration, repoCtx, branch, headSha, taskPrompt } = args;
    try {
      let pr = await this.github
        .findOpenPullRequest(orgId, repoCtx.owner, repoCtx.repo, branch, repoCtx.integrationBranch)
        .catch(() => null);
      if (!pr) {
        pr = await this.github.createPullRequest(orgId, repoCtx.owner, repoCtx.repo, {
          head: branch,
          base: repoCtx.integrationBranch,
          title: `[${role}] ${taskPrompt.split('\n')[0].slice(0, 72)}`,
          body: `PR automático del agente **${role}** (Dev Studio).\n\nRama \`${branch}\` → \`${repoCtx.integrationBranch}\`.`,
        });
      }

      const files = await this.github
        .getPullRequestFiles(orgId, repoCtx.owner, repoCtx.repo, pr.number)
        .catch(() => []);
      const diffSummary = files
        .slice(0, 30)
        .map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join('\n');

      const { data: taskRow } = await this.db.admin
        .from('dev_tasks')
        .select('acceptance_criteria, test_result, title')
        .eq('id', studioTaskId)
        .eq('org_id', orgId)
        .maybeSingle();
      const acceptance = (taskRow?.acceptance_criteria as SuccessCriterion[]) ?? [];
      const testResult = (taskRow?.test_result as Record<string, unknown>) ?? undefined;

      const review = await this.architect.reviewPullRequest({
        orgId,
        taskTitle: (taskRow?.title as string) ?? taskPrompt.slice(0, 60),
        taskPrompt,
        acceptanceCriteria: acceptance,
        files,
        testResult,
      });

      const proposal = await this.sessionService.createMergeProposal({
        orgId, sessionId: session.id, taskId: studioTaskId,
        sourceBranch: branch, targetBranch: repoCtx.integrationBranch,
        diffSummary, riskLevel: review.riskLevel,
        prNumber: pr.number, prUrl: pr.url, prState: pr.state, headSha, kind: 'feature',
        testResult,
      });

      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'dev.pr.opened',
        message: `[${role}] PR #${pr.number} ${branch} → ${repoCtx.integrationBranch} — revisión: ${review.decision}`,
        iterationId: iteration.id, taskId: studioTaskId,
      });
      await this.emitToSession(orgId, session.id, 'dev.pr.opened', {
        sessionId: session.id, studioTaskId, prNumber: pr.number, prUrl: pr.url, branch, decision: review.decision,
      });

      if (review.decision === 'approve') {
        const merge = await this.github.mergePullRequest(orgId, repoCtx.owner, repoCtx.repo, pr.number, 'squash');
        if (merge.merged) {
          await this.sessionService.updateMergeProposal(proposal.id, orgId, {
            status: 'merged', pr_state: 'merged', reviewer_notes: review.summary,
          });
          await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'merged', {
            result_summary: `Integrado a ${repoCtx.integrationBranch} (PR #${pr.number}).`,
          });
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'dev.pr.merged',
            message: `[${role}] PR #${pr.number} integrado a ${repoCtx.integrationBranch}.`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
          await this.emitToSession(orgId, session.id, 'dev.pr.merged', {
            sessionId: session.id, studioTaskId, prNumber: pr.number, targetBranch: repoCtx.integrationBranch,
          });
        } else {
          await this.sessionService.updateMergeProposal(proposal.id, orgId, {
            status: 'conflicted', reviewer_notes: merge.message ?? 'No mergeable (conflicto).',
          });
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'dev.pr.conflicted',
            message: `[${role}] PR #${pr.number} no se integró automáticamente: ${(merge.message ?? '').slice(0, 160)}`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
        }
      } else {
        await this.sessionService.updateMergeProposal(proposal.id, orgId, {
          status: 'rejected', reviewer_notes: review.notes ?? review.summary,
        });
        await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'changes_requested', {
          result_summary: review.notes ?? review.summary,
        });
        await this.sessionService.logEvent({
          orgId, sessionId: session.id, eventType: 'dev.pr.changes_requested',
          message: `[${role}] PR #${pr.number}: cambios solicitados — ${(review.notes ?? review.summary).slice(0, 160)}`,
          iterationId: iteration.id, taskId: studioTaskId,
        });
      }
    } catch (err) {
      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'dev.pr.error',
        message: `[${role}] Error en PR/review: ${(err as Error).message.slice(0, 200)}`,
        iterationId: iteration.id, taskId: studioTaskId,
      }).catch(() => undefined);
    }
  }

  /**
   * Human-approve a merge proposal. For a real GitHub PR this merges it (squash
   * for feature → develop, merge commit for release → main); otherwise it just
   * flips the proposal status. Release merges are reached through the Approval
   * Engine (see prepareReleasePr / executeReleaseMerge).
   */
  async approveMergeProposal(proposalId: string, orgId: string, notes?: string): Promise<DevMergeProposal> {
    const proposal = await this.sessionService.getMergeProposal(proposalId, orgId);
    if (!proposal) throw new Error('Merge proposal not found');
    // Release PRs (develop → main) are production actions: they merge ONLY through
    // the Approval Engine (handleReleaseApprovalResolved), never via a direct button.
    if (proposal.kind === 'release') {
      throw new Error('Los releases a producción se aprueban en el panel de Approvals, no aquí.');
    }
    const session = await this.sessionService.findById(proposal.session_id, orgId);
    if (proposal.pr_number && session?.repo_url) {
      const { owner, repo } = GithubService.parseRepoUrl(session.repo_url);
      // Only feature PRs reach here (release is guarded above) → squash into develop.
      const merge = await this.github.mergePullRequest(orgId, owner, repo, proposal.pr_number, 'squash');
      if (!merge.merged) {
        return this.sessionService.updateMergeProposal(proposalId, orgId, {
          status: 'conflicted', reviewer_notes: notes ?? merge.message ?? 'No mergeable',
        });
      }
      await this.sessionService.logEvent({
        orgId, sessionId: proposal.session_id, eventType: 'dev.pr.merged',
        message: `PR #${proposal.pr_number} integrado a ${proposal.target_branch} (aprobación humana).`,
      });
      return this.sessionService.updateMergeProposal(proposalId, orgId, {
        status: 'merged', pr_state: 'merged', reviewer_notes: notes,
      });
    }
    return this.sessionService.updateMergeProposal(proposalId, orgId, { status: 'approved', reviewer_notes: notes });
  }

  /** Human-reject a merge proposal; closes the PR on GitHub when there is one. */
  async rejectMergeProposal(proposalId: string, orgId: string, notes?: string): Promise<DevMergeProposal> {
    const proposal = await this.sessionService.getMergeProposal(proposalId, orgId);
    if (!proposal) throw new Error('Merge proposal not found');
    const session = await this.sessionService.findById(proposal.session_id, orgId);
    if (proposal.pr_number && session?.repo_url) {
      const { owner, repo } = GithubService.parseRepoUrl(session.repo_url);
      await this.github.closePullRequest(orgId, owner, repo, proposal.pr_number).catch(() => undefined);
    }
    return this.sessionService.updateMergeProposal(proposalId, orgId, {
      status: 'rejected', pr_state: 'closed', reviewer_notes: notes,
    });
  }

  /**
   * Connect a GitHub repo to a session: either an existing repo (by URL) or a new
   * one created via the API. Resolves the default branch, ensures the integration
   * branch (develop) exists, and persists the coordinates on the session.
   */
  async connectRepo(
    sessionId: string,
    orgId: string,
    opts: { repoUrl?: string; create?: boolean; name?: string; owner?: string; private?: boolean },
  ): Promise<DevSession> {
    const session = await this.sessionService.findByIdOrThrow(sessionId, orgId);
    await this.github.requireToken(orgId); // surfaces GithubNotConnectedError if missing

    let info;
    if (opts.create) {
      const name = opts.name?.trim() || slugify(session.title, 60);
      info = await this.github.createRepo(orgId, { name, private: opts.private ?? true, org: opts.owner });
    } else {
      if (!opts.repoUrl) throw new Error('repoUrl requerido para conectar un repo existente');
      const { owner, repo } = GithubService.parseRepoUrl(opts.repoUrl);
      info = await this.github.getRepo(orgId, owner, repo);
    }

    await this.github.ensureBranch(orgId, info.owner, info.repo, 'develop', info.defaultBranch).catch(() => undefined);

    const updated = await this.sessionService.setSessionRepo(sessionId, orgId, {
      repoUrl: info.htmlUrl,
      owner: info.owner,
      repo: info.repo,
      baseBranch: info.defaultBranch,
      integrationBranch: 'develop',
    });

    await this.sessionService.logEvent({
      orgId, sessionId, eventType: 'dev.repo.connected',
      message: `Repo conectado: ${info.fullName} (default ${info.defaultBranch}, integración develop).`,
    });
    await this.emitToSession(orgId, sessionId, 'dev.repo.connected', {
      sessionId, repoUrl: info.htmlUrl, owner: info.owner, repo: info.repo,
    });
    return updated;
  }

  // ── Release gate (develop → main, human-approved) ────────────────────────────

  /**
   * Open the release PR (develop → main) once all goals are complete and gate it
   * through the Approval Engine (level 2) — this is the user's final review before
   * production. Idempotent: skips when a release proposal is already in flight or
   * when the session has no repo configured.
   */
  private async prepareReleasePr(session: DevSession, orgId: string): Promise<void> {
    if (!session.repo_url) return;
    // Require a GitHub token; if absent, feature work would already have surfaced github_connect.
    try {
      await this.github.requireToken(orgId);
    } catch {
      return;
    }

    const existing = await this.sessionService
      .listMergeProposals(session.id, orgId)
      .catch(() => [] as DevMergeProposal[]);
    if (existing.some((p) => p.kind === 'release' && ['pending', 'approved'].includes(p.status))) return;

    const { owner, repo } = GithubService.parseRepoUrl(session.repo_url);
    const integrationBranch = session.integration_branch || 'develop';
    const prodBranch = session.base_branch || 'main';

    try {
      let pr = await this.github.findOpenPullRequest(orgId, owner, repo, integrationBranch, prodBranch).catch(() => null);
      if (!pr) {
        pr = await this.github.createPullRequest(orgId, owner, repo, {
          head: integrationBranch,
          base: prodBranch,
          title: `Release: ${session.title}`,
          body: `Release de Dev Studio — integra \`${integrationBranch}\` → \`${prodBranch}\` (producción). Requiere aprobación humana.`,
        });
      }

      const approval = await this.approvals.request(
        {
          action_type: 'dev_studio.release_merge',
          level: 2,
          payload: { sessionId: session.id, owner, repo, prNumber: pr.number, headSha: pr.head.sha, targetBranch: prodBranch },
          summary: `Release a producción: ${session.title} (PR #${pr.number} ${integrationBranch} → ${prodBranch})`,
          source: 'dev_manager',
        } as any,
        orgId,
        session.user_id,
      );

      await this.sessionService.createMergeProposal({
        orgId, sessionId: session.id,
        sourceBranch: integrationBranch, targetBranch: prodBranch,
        prNumber: pr.number, prUrl: pr.url, prState: pr.state, headSha: pr.head.sha,
        kind: 'release', approvalId: approval.id,
        diffSummary: `Release ${integrationBranch} → ${prodBranch}`, riskLevel: 'high',
      });

      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'dev.release.requested',
        message: `Release listo: PR #${pr.number} ${integrationBranch} → ${prodBranch}. Esperando tu aprobación para ir a prod.`,
      });
      await this.emitToSession(orgId, session.id, 'dev.release.requested', {
        sessionId: session.id, prNumber: pr.number, prUrl: pr.url, approvalId: approval.id,
      });
    } catch (err) {
      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'dev.release.error',
        message: `No se pudo preparar el release: ${(err as Error).message.slice(0, 200)}`,
      }).catch(() => undefined);
    }
  }

  /** React to a resolved release-merge approval: merge to prod (approved) or close the PR (rejected). */
  private async handleReleaseApprovalResolved(approvalId: string, status: string, orgId: string): Promise<void> {
    const proposal = await this.sessionService.getMergeProposalByApproval(approvalId, orgId);
    if (!proposal || proposal.kind !== 'release') return; // not a dev-studio release approval
    if (proposal.status === 'merged' || proposal.status === 'rejected') return; // already handled
    const session = await this.sessionService.findById(proposal.session_id, orgId);

    if (status === 'approved') {
      await this.executeReleaseMerge(proposal, session, orgId, approvalId);
      return;
    }
    if (status === 'rejected') {
      if (proposal.pr_number && session?.repo_url) {
        const { owner, repo } = GithubService.parseRepoUrl(session.repo_url);
        await this.github.closePullRequest(orgId, owner, repo, proposal.pr_number).catch(() => undefined);
      }
      await this.sessionService.updateMergeProposal(proposal.id, orgId, { status: 'rejected', pr_state: 'closed' });
      if (session) await this.sessionService.transition(session.id, orgId, 'running').catch(() => undefined);
      await this.sessionService.logEvent({
        orgId, sessionId: proposal.session_id, eventType: 'dev.release.rejected',
        message: 'Release a producción rechazado; la sesión vuelve a trabajar.',
      });
    }
  }

  /** Merge develop → main after human approval, consuming the approval nonce once. */
  private async executeReleaseMerge(
    proposal: DevMergeProposal,
    session: DevSession | null,
    orgId: string,
    approvalId: string,
  ): Promise<void> {
    // Consume the approval so the production merge can never run twice.
    await this.approvals.consumeApproved(approvalId, orgId).catch(() => undefined);
    if (!session?.repo_url || !proposal.pr_number) return;
    const { owner, repo } = GithubService.parseRepoUrl(session.repo_url);
    const merge = await this.github.mergePullRequest(orgId, owner, repo, proposal.pr_number, 'merge');

    if (merge.merged) {
      await this.sessionService.updateMergeProposal(proposal.id, orgId, { status: 'merged', pr_state: 'merged' });
      await this.sessionService.transition(session.id, orgId, 'completed').catch(() => undefined);
      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'dev.release.merged',
        message: `Release integrado a ${proposal.target_branch} (producción). PR #${proposal.pr_number}.`,
      });
      await this.emitToSession(orgId, session.id, 'dev.release.merged', {
        sessionId: session.id, prNumber: proposal.pr_number, targetBranch: proposal.target_branch,
      });
    } else {
      await this.sessionService.updateMergeProposal(proposal.id, orgId, { status: 'conflicted', reviewer_notes: merge.message });
      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: 'dev.release.conflicted',
        message: `Release no se pudo integrar a ${proposal.target_branch}: ${(merge.message ?? '').slice(0, 160)}`,
      });
    }
  }

  private async runWaveFromQueued(session: DevSession, orgId: string, tasks: Record<string, unknown>[]): Promise<number> {
    let dispatched = 0;
    const iterations = new Map<string, DevIteration>();
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
        .eq('org_id', orgId)
        .maybeSingle();

      if (!iterRow) return;
      iterations.set(iterRow.id as string, iterRow as DevIteration);

      await this.sessionService.updateStudioTaskStatus(taskId, orgId, 'assigned');
      try {
        const success = await this.runAgentTask(session, orgId, taskId, prompt, role, iterRow as DevIteration);
        if (!success) {
          const iterationTasks = await this.sessionService.listIterationTasks(iterRow.id as string, orgId);
          const refreshed = iterationTasks.find((candidate) => candidate.id === taskId);
          // Auth failures deliberately return the task to `queued`; provisioning
          // already explains that blocker, so do not create a second human task.
          if (refreshed?.status !== 'queued') {
            await this.handleAgentFailure(
              session, orgId, taskId, iterRow as DevIteration, null,
              String(refreshed?.result_summary ?? 'Task execution failed'),
            );
          }
        }
      } catch (err) {
        // Explicitly mark as failed so the task doesn't stay frozen in `assigned`.
        const errMsg = (err as Error).message;
        this.logger.error(`runWaveFromQueued: task ${taskId} threw: ${errMsg}`);
        await this.sessionService.updateStudioTaskStatus(taskId, orgId, 'failed', { result_summary: errMsg }).catch(() => undefined);
        await this.sessionService.logEvent({
          orgId, sessionId: session.id, eventType: 'task.failed',
          message: `[${role}] Error al ejecutar tarea (re-dispatch): ${errMsg.slice(0, 300)}`,
          taskId,
        }).catch(() => undefined);
      }
      dispatched++;
    }));

    // Re-dispatched work must close its original iteration just like a fresh
    // wave. Keep it open only when auth provisioning re-queued some work.
    for (const iteration of iterations.values()) {
      const iterationTasks = await this.sessionService.listIterationTasks(iteration.id, orgId);
      const stillPending = iterationTasks.some((task) =>
        ['queued', 'assigned', 'running'].includes(String(task.status)),
      );
      if (stillPending) continue;

      const allFailed = iterationTasks.length > 0 && iterationTasks.every((task) => task.status === 'failed');
      const outputs = await this.sessionService.buildIterationOutputs(iteration.id, orgId).catch(() => [] as string[]);
      await this.sessionService.updateIterationStatus(
        iteration.id,
        orgId,
        allFailed ? 'needs_more_work' : 'completed',
        { completed_at: new Date().toISOString(), completed_outputs: outputs },
      );
      await this.sessionService.logEvent({
        orgId,
        sessionId: session.id,
        eventType: 'iteration.completed',
        message: `Iteración "${iteration.title}" finalizada tras reanudar ${iterationTasks.length} tarea(s).`,
        iterationId: iteration.id,
      });
    }

    if (iterations.size > 0) await this.tickSafe(session.id, orgId);
    return dispatched;
  }

  /**
   * Register an agent for a role (if needed) and eagerly boot its dedicated
   * Docker machine, recording the container + image on the dev_agents row and
   * streaming boot events to the UI (booting → ready/failed). Best-effort: a
   * machine boot failure never blocks the iteration — the task may still run
   * on the API loop or report a missing-image blocker later.
   */
  private async ensureAgentAndMachine(
    session: DevSession,
    orgId: string,
    role: string,
    iteration: DevIteration,
  ): Promise<void> {
    const agent = await this.sessionService.ensureAgent({
      orgId, sessionId: session.id, role,
      name: AGENT_DISPLAY_NAMES[role] ?? `${role} Agent`,
    });

    // Already booted (container_id set and machine still live) → nothing to do.
    if (agent.container_id && this.claudeCode.hasContainer(agent.id)) return;

    const result = await this.claudeCode.bootMachine({
      orgId,
      key: agent.id,
      role,
      onEvent: async (ev) => {
        await this.sessionService.logEvent({
          orgId, sessionId: session.id, eventType: `agent.machine.${ev.type}`,
          message: `[${role}] ${ev.text}`, iterationId: iteration.id,
        });
        await this.emitToSession(orgId, session.id, 'dev.agent.machine', {
          sessionId: session.id, agentId: agent.id, role, status: ev.type, message: ev.text,
        });
      },
    });

    // For code roles, confirm the machine is actually logged in to Claude Code so
    // the user can SEE auth status per machine (green = logged in / red = bad token).
    let authOk: boolean | null = null;
    let authError: string | undefined;
    if (result.ok && CODE_ROLES.has(role)) {
      const check = await this.claudeCode.verifyAuth(orgId, agent.id).catch(() => ({ ok: false, error: 'probe error' }));
      authOk = check.ok;
      authError = check.error;
      await this.sessionService.logEvent({
        orgId, sessionId: session.id, eventType: `agent.machine.${check.ok ? 'auth_ok' : 'auth_failed'}`,
        message: `[${role}] ${check.ok ? 'Claude Code logueado correctamente' : `Login falló: ${check.error ?? 'desconocido'}`}`,
        iterationId: iteration.id,
      });
      await this.emitToSession(orgId, session.id, 'dev.agent.machine', {
        sessionId: session.id, agentId: agent.id, role,
        status: check.ok ? 'auth_ok' : 'auth_failed', message: check.error ?? '',
      });
    }

    await this.sessionService.updateAgentStatus(agent.id, orgId, agent.status ?? 'idle', {
      runtime: result.image ? `docker:${result.image}` : 'docker',
      container_id: result.containerName ?? null,
      metadata: {
        ...(agent.metadata ?? {}),
        machine: { image: result.image, ok: result.ok, error: result.error, authOk, authError },
      },
    });
  }

  /** Tear down all booted machines for a session (called on terminal states). */
  async shutdownSessionMachines(sessionId: string, orgId: string): Promise<void> {
    const agents = await this.sessionService.listAgents(sessionId, orgId).catch(() => []);
    await Promise.all(agents.map((a) => this.claudeCode.destroyMachine(a.id).catch(() => undefined)));
  }

  private async runAgentTask(
    session: DevSession,
    orgId: string,
    studioTaskId: string,
    prompt: string,
    role: AgentRole,
    iteration: DevIteration,
  ): Promise<boolean> {
    const agentRecord = await this.sessionService.getAgent(session.id, orgId, role);

    // Git context for this run, resolved lazily inside the Claude Code branch and
    // reused after success to commit + push the agent's work.
    let repoCtx: SessionRepoContext | null = null;
    let agentBranch: string | null = null;
    let gitIdentity: { name: string; email: string } | null = null;

    // ── Guard: code roles REQUIRE Claude Code — never fall back to agent loop ──
    // The agent loop lacks filesystem tooling and can't write production code.
    // If the credential is missing, requeue the task and surface the provisioning
    // panel so the user can connect Claude Code before the task runs.
    if (CODE_ROLES.has(role)) {
      const hasCred = await this.claudeCode.hasCredential(orgId, agentRecord?.id);
      if (!hasCred) {
        await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'queued', {
          result_summary: 'En espera de credencial de Claude Code. Conecta Claude Code para continuar.',
        });
        await this.sessionService.logEvent({
          orgId, sessionId: session.id, eventType: 'task.blocked_no_credential',
          message: `[${role}] Tarea re-encolada: falta credencial de Claude Code.`,
          iterationId: iteration.id, taskId: studioTaskId,
        });
        const agentRecord = await this.sessionService.getAgent(session.id, orgId, role).catch(() => null);
        if (agentRecord) {
          await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'blocked', { current_task_id: null });
        }
        await this.ensureClaudeCodeProvisioningTask(session, orgId, iteration);
        return false;
      }
    }

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

    if (!backingTask) {
      // Mark as failed so the task doesn't stay frozen in `assigned`.
      await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'failed', {
        result_summary: 'Error interno: no se pudo crear la tarea de respaldo en la base de datos.',
      });
      return false;
    }

    const backingTaskId = (backingTask as { id: string }).id;
    await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'running');

    // Update agent status to running
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
      const useClaudeCode = CODE_ROLES.has(role) && (await this.claudeCode.hasCredential(orgId, agentRecord?.id));
      const runtimeLabel = useClaudeCode ? 'claude-code' : 'agent-loop';

      let outcome: { ok: boolean; text?: string; authFailed?: boolean };
      if (useClaudeCode) {
        // ── Real git: prepare the agent's branch in its machine before coding ──
        try {
          repoCtx = await this.resolveSessionRepoContext(session, orgId);
        } catch (err) {
          if (err instanceof GithubNotConnectedError) {
            await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'queued', {
              result_summary: 'En espera de conexión de GitHub. Conecta GitHub para versionar el trabajo.',
            });
            await this.sessionService.logEvent({
              orgId, sessionId: session.id, eventType: 'task.blocked_no_github',
              message: `[${role}] Tarea re-encolada: falta token de GitHub.`,
              iterationId: iteration.id, taskId: studioTaskId,
            });
            if (agentRecord) await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'blocked', { current_task_id: null });
            await this.ensureGithubProvisioningTask(session, orgId, iteration);
            await this.tasks.transition(backingTaskId, orgId, 'failed', { error: 'GITHUB_NOT_CONNECTED' }).catch(() => undefined);
            return false;
          }
          const gErr = (err as Error).message;
          await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'failed', { result_summary: `GitHub: ${gErr}` });
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'git.setup_failed',
            message: `[${role}] No se pudo preparar el repo: ${gErr.slice(0, 200)}`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
          await this.tasks.transition(backingTaskId, orgId, 'failed', { error: gErr }).catch(() => undefined);
          if (agentRecord) await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'failed', { current_task_id: null });
          return false;
        }

        if (repoCtx && agentRecord) {
          agentBranch = agentBranchName(agentRecord.name, prompt, iteration.number);
          gitIdentity = agentGitIdentity(agentRecord);
          await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'running', {
            current_task_id: studioTaskId,
            branch_name: agentBranch,
            git_author_name: gitIdentity.name,
            git_author_email: gitIdentity.email,
          });
          await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'running', { branch_name: agentBranch });

          const setup = await this.claudeCode.setupAgentRepo({
            orgId,
            machineKey: agentRecord.id,
            role,
            repoUrl: repoCtx.repoUrl,
            token: repoCtx.token,
            branch: agentBranch,
            baseBranch: repoCtx.integrationBranch,
            identity: gitIdentity,
          });
          if (!setup.ok) {
            await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'failed', { result_summary: `git setup: ${setup.error}` });
            await this.sessionService.logEvent({
              orgId, sessionId: session.id, eventType: 'git.setup_failed',
              message: `[${role}] git setup falló: ${(setup.error ?? '').slice(0, 200)}`,
              iterationId: iteration.id, taskId: studioTaskId,
            });
            await this.tasks.transition(backingTaskId, orgId, 'failed', { error: setup.error ?? 'git setup failed' }).catch(() => undefined);
            if (agentRecord) await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'failed', { current_task_id: null });
            return false;
          }
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'git.branch_ready',
            message: `[${role}] Rama lista: ${agentBranch} (desde ${repoCtx.integrationBranch})`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
        }

        // Heartbeat: touch dev_tasks.updated_at periodically so the stuck-task
        // detector doesn't falsely requeue this task while Claude is still active.
        let lastHeartbeat = Date.now();
        const result = await this.claudeCode.run({
          orgId,
          taskId: backingTaskId,
          prompt,
          context: roleContext,
          // Run inside the agent's persistent machine so the pre-baked toolchain
          // and /work state carry across this agent's tasks.
          machineKey: agentRecord?.id,
          role,
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
            // Touch updated_at at most every 60 s so the task is never
            // treated as "stuck" while Claude Code is actively producing events.
            if (Date.now() - lastHeartbeat > 60_000) {
              lastHeartbeat = Date.now();
              await this.sessionService.touchStudioTask(studioTaskId, orgId).catch(() => undefined);
            }
          },
        });
        outcome = { ok: result.ok, text: result.resultSummary ?? result.text ?? result.error ?? '', authFailed: result.authFailed };

        // Persist an inspectable exit record (image, container, ok/error tail).
        const machine = agentRecord ? this.claudeCode.machineInfo(agentRecord.id) : null;
        await this.sessionService.logEvent({
          orgId, sessionId: session.id, eventType: result.ok ? 'claude.exit' : 'claude.exit_error',
          message: [
            `exit=${result.ok ? 'ok' : (result.authFailed ? 'auth_failed' : 'error')}`,
            machine?.image ? `image=${machine.image}` : '',
            machine?.containerName ? `container=${machine.containerName}` : '',
            result.error ? `err=${result.error.slice(0, 240)}` : '',
          ].filter(Boolean).join(' · '),
          iterationId: iteration.id, taskId: studioTaskId,
        }).catch(() => undefined);

        // Auth problem → reopen provisioning and requeue the task so it resumes
        // automatically once the user supplies a valid token (instead of a dead-end fail).
        if (result.authFailed) {
          await this.sessionService.updateStudioTaskStatus(studioTaskId, orgId, 'queued', { result_summary: result.error ?? 'AUTH_FAILED' });
          await this.tasks.transition(backingTaskId, orgId, 'failed', { error: result.error ?? 'AUTH_FAILED' }).catch(() => undefined);
          if (agentRecord) await this.sessionService.updateAgentStatus(agentRecord.id, orgId, 'blocked', { current_task_id: null });
          await this.ensureClaudeCodeProvisioningTask(session, orgId, iteration);
          return false;
        }
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

      // Code work succeeded → commit + push the agent's branch under its identity,
      // so the history shows real, attributable authorship per agent.
      if (success && useClaudeCode && repoCtx && agentBranch && gitIdentity && agentRecord) {
        const commitMsg = `[${role}] ${prompt.split('\n')[0].slice(0, 72)}`;
        const push = await this.claudeCode.commitAndPushAgentRepo({
          machineKey: agentRecord.id,
          token: repoCtx.token,
          branch: agentBranch,
          message: commitMsg,
          identity: gitIdentity,
        });
        if (push.ok && push.pushed) {
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'git.pushed',
            message: `[${role}] push ${agentBranch}${push.headSha ? ` @ ${push.headSha.slice(0, 7)}` : ''}`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
          // Open the PR (feature → develop) and let the architect review/merge it.
          await this.openAndReviewFeaturePr({
            session, orgId, studioTaskId, role, iteration, repoCtx,
            branch: agentBranch, headSha: push.headSha, taskPrompt: prompt,
          });
        } else if (push.error === 'NO_CHANGES') {
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'git.no_changes',
            message: `[${role}] El agente no produjo cambios en archivos.`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
        } else {
          await this.sessionService.logEvent({
            orgId, sessionId: session.id, eventType: 'git.push_failed',
            message: `[${role}] push falló: ${(push.error ?? '').slice(0, 200)}`,
            iterationId: iteration.id, taskId: studioTaskId,
          });
        }
      }

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
    // If a Claude Code auth provisioning task is already pending, the failure is
    // already surfaced there — don't pile on a duplicate generic blocker.
    const pending = await this.sessionService.listHumanTasks(session.id, orgId, 'pending').catch(() => []);
    if (pending.some((t) => (t.instructions as Record<string, unknown> | undefined)?.kind === 'claude_code_auth')) {
      return;
    }

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

    // Persist team tier so every tick can use it without re-classifying
    const teamTier = northStarResult.teamTier ?? 'medium';
    await this.db.admin
      .from('dev_sessions')
      .update({ metadata: { ...(session.metadata ?? {}), teamTier, teamTierReason: northStarResult.teamTierReason } })
      .eq('id', sessionId)
      .eq('org_id', orgId);

    this.logger.log(`Session ${sessionId} team tier: ${teamTier} — ${northStarResult.teamTierReason}`);

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
      message: `North Star generada. Tier: ${teamTier} (${TEAM_TIER_CONFIG[teamTier].description}). ${northStarResult.goals.length} goals propuestos, esperando aprobación.`,
    });

    await this.emitToSession(orgId, sessionId, 'dev.session.updated', {
      sessionId, status: 'awaiting_goals_approval',
      northStar: northStarResult.northStar,
      goalCount: northStarResult.goals.length,
    });
  }

  /**
   * Start a session using a pre-approved plan from the planning wizard.
   * Skips PM planning phase entirely — goals are seeded directly and approved.
   */
  async startSessionWithPreplan(
    sessionId: string,
    orgId: string,
    preplan: {
      northStar?: string;
      teamTier?: TeamTier;
      teamTierReason?: string;
      definitionOfDone?: Array<{ id: string; description: string; verifiable: boolean }>;
      goals: Array<{
        title: string;
        description: string;
        priority: number;
        successCriteria: Array<{ id: string; description: string; verifiable: boolean }>;
      }>;
    },
  ): Promise<void> {
    const session = await this.sessionService.findByIdOrThrow(sessionId, orgId);

    await this.sessionService.transition(sessionId, orgId, 'planning');

    const northStar = preplan.northStar ?? preplan.goals.map((g) => g.title).join(', ');
    await this.sessionService.setNorthStar(sessionId, orgId, northStar, preplan.definitionOfDone ?? []);

    const teamTier: TeamTier = preplan.teamTier ?? 'small';
    await this.db.admin
      .from('dev_sessions')
      .update({
        metadata: {
          ...(session.metadata ?? {}),
          teamTier,
          teamTierReason: preplan.teamTierReason ?? 'Plan pre-aprobado por el usuario',
          preplan: undefined,
        },
      })
      .eq('id', sessionId)
      .eq('org_id', orgId);

    for (const goalDef of preplan.goals) {
      await this.sessionService.createGoal({
        orgId,
        sessionId,
        title: goalDef.title,
        description: goalDef.description,
        priority: goalDef.priority,
        successCriteria: goalDef.successCriteria,
      });
    }

    const goals = await this.sessionService.listGoals(sessionId, orgId);
    await this.sessionService.approveGoals(sessionId, orgId, goals.map((g) => g.id));
    await this.sessionService.transition(sessionId, orgId, 'running');

    await this.sessionService.logEvent({
      orgId, sessionId, eventType: 'session.running',
      message: `Plan pre-aprobado. Tier: ${teamTier}. ${preplan.goals.length} goals creados y aprobados automáticamente.`,
    });

    await this.emitToSession(orgId, sessionId, 'dev.session.updated', {
      sessionId, status: 'running', goalCount: goals.length,
    });

    void this.tickSafe(sessionId, orgId);
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
