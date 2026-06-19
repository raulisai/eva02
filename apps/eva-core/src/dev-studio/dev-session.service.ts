import { Injectable, InternalServerErrorException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EventBusService } from '../events/event-bus.service';
import {
  DevSession, DevSessionStatus, isValidSessionTransition,
  DevGoal, DevIteration, DevHumanTask, DevAgent, DevMergeProposal,
} from './dev-studio.types';

/**
 * Map a raw EventBus event (persisted in task_events) to a UI log category.
 * The agent loop publishes `task.step` with payload { thought, tool, args, ... }.
 */
function mapEventToLogType(eventType: string, payload?: Record<string, unknown>): string {
  const t = (eventType ?? '').toLowerCase();
  if (t.includes('error') || t.includes('failed')) return 'error';
  if (t.includes('final') || t.includes('completed') || t.includes('done')) return 'final';
  if (t.includes('steer')) return 'steer';
  if (t.includes('input') || t.includes('approval') || t.includes('await')) return 'input';
  if (t.includes('result') || t.includes('observation')) return 'tool_result';
  if (payload && typeof payload.tool === 'string') return 'tool_call';
  if (payload && (payload.thought !== undefined)) return 'thought';
  return 'event';
}

@Injectable()
export class DevSessionService {
  private readonly logger = new Logger(DevSessionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
  ) {}

  // ── Sessions ──────────────────────────────────────────────────────────────

  async create(input: {
    orgId: string;
    userId: string;
    title: string;
    originalPrompt: string;
    projectId?: string;
  }): Promise<DevSession> {
    const { data, error } = await this.db.admin
      .from('dev_sessions')
      .insert({
        org_id: input.orgId,
        user_id: input.userId,
        project_id: input.projectId ?? null,
        title: input.title,
        original_prompt: input.originalPrompt,
        status: 'idea_intake',
      })
      .select()
      .single();
    if (error) this.fail('dev_sessions.create', error);
    const session = data as DevSession;

    await this.events.publish({
      type: 'dev.session.created',
      orgId: input.orgId,
      payload: { sessionId: session.id, title: session.title },
    });
    return session;
  }

  async findById(sessionId: string, orgId: string): Promise<DevSession | null> {
    const { data, error } = await this.db.admin
      .from('dev_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (error) this.fail('dev_sessions.findById', error);
    return data as DevSession | null;
  }

  async findByIdOrThrow(sessionId: string, orgId: string): Promise<DevSession> {
    const session = await this.findById(sessionId, orgId);
    if (!session) throw new NotFoundException(`Dev session ${sessionId} not found`);
    return session;
  }

  async list(orgId: string, userId?: string): Promise<DevSession[]> {
    let q = this.db.admin
      .from('dev_sessions')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) this.fail('dev_sessions.list', error);
    return (data ?? []) as DevSession[];
  }

  async transition(sessionId: string, orgId: string, next: DevSessionStatus, patch: Record<string, unknown> = {}): Promise<DevSession> {
    const session = await this.findByIdOrThrow(sessionId, orgId);
    if (!isValidSessionTransition(session.status, next)) {
      throw new BadRequestException(`Cannot transition dev_session from '${session.status}' to '${next}'`);
    }
    const { data, error } = await this.db.admin
      .from('dev_sessions')
      .update({ status: next, ...patch })
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_sessions.transition', error);
    const updated = data as DevSession;

    await this.events.publish({
      type: 'dev.session.updated',
      orgId,
      payload: { sessionId, status: next },
    });
    return updated;
  }

  async setNorthStar(sessionId: string, orgId: string, northStar: string, definitionOfDone: unknown[]): Promise<DevSession> {
    const { data, error } = await this.db.admin
      .from('dev_sessions')
      .update({ north_star: northStar, definition_of_done: definitionOfDone })
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_sessions.setNorthStar', error);
    return data as DevSession;
  }

  async pause(sessionId: string, orgId: string): Promise<DevSession> {
    return this.transition(sessionId, orgId, 'paused');
  }

  async resume(sessionId: string, orgId: string): Promise<DevSession> {
    return this.transition(sessionId, orgId, 'running');
  }

  async cancel(sessionId: string, orgId: string): Promise<DevSession> {
    return this.transition(sessionId, orgId, 'cancelled');
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  async createGoal(input: {
    orgId: string;
    sessionId: string;
    title: string;
    description?: string;
    priority?: number;
    successCriteria?: unknown[];
  }): Promise<DevGoal> {
    const { data, error } = await this.db.admin
      .from('dev_goals')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 0,
        success_criteria: input.successCriteria ?? [],
        status: 'proposed',
      })
      .select()
      .single();
    if (error) this.fail('dev_goals.create', error);
    const goal = data as DevGoal;

    await this.events.publish({
      type: 'dev.goal.created',
      orgId: input.orgId,
      payload: { sessionId: input.sessionId, goalId: goal.id, title: goal.title },
    });
    return goal;
  }

  async listGoals(sessionId: string, orgId: string): Promise<DevGoal[]> {
    const { data, error } = await this.db.admin
      .from('dev_goals')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .order('priority', { ascending: false });
    if (error) this.fail('dev_goals.list', error);
    return (data ?? []) as DevGoal[];
  }

  async findGoalById(goalId: string, orgId: string): Promise<DevGoal | null> {
    const { data, error } = await this.db.admin
      .from('dev_goals')
      .select('*')
      .eq('id', goalId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (error) this.fail('dev_goals.find', error);
    return data as DevGoal | null;
  }

  async updateGoalStatus(goalId: string, orgId: string, status: string, extras: Record<string, unknown> = {}): Promise<DevGoal> {
    const { data, error } = await this.db.admin
      .from('dev_goals')
      .update({ status, ...extras })
      .eq('id', goalId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_goals.updateStatus', error);
    const goal = data as DevGoal;

    await this.events.publish({
      type: 'dev.goal.updated',
      orgId,
      payload: { goalId, status },
    });
    return goal;
  }

  async approveGoals(sessionId: string, orgId: string, goalIds: string[]): Promise<DevGoal[]> {
    const results: DevGoal[] = [];
    for (const goalId of goalIds) {
      const goal = await this.updateGoalStatus(goalId, orgId, 'approved');
      results.push(goal);
    }
    await this.events.publish({
      type: 'dev.goals.approved',
      orgId,
      payload: { sessionId, goalIds },
    });
    return results;
  }

  async incGoalIterationCount(goalId: string, orgId: string): Promise<void> {
    const { data } = await this.db.admin
      .from('dev_goals')
      .select('iteration_count')
      .eq('id', goalId)
      .eq('org_id', orgId)
      .single();
    const count = ((data as { iteration_count: number } | null)?.iteration_count ?? 0) + 1;
    await this.db.admin
      .from('dev_goals')
      .update({ iteration_count: count })
      .eq('id', goalId)
      .eq('org_id', orgId);
  }

  // ── Iterations ────────────────────────────────────────────────────────────

  async createIteration(input: {
    orgId: string;
    sessionId: string;
    goalId?: string;
    title: string;
    objective: string;
    plannedOutputs?: string[];
    number?: number;
  }): Promise<DevIteration> {
    // Compute iteration number for the goal
    let number = input.number;
    if (!number && input.goalId) {
      const { count } = await this.db.admin
        .from('dev_iterations')
        .select('id', { count: 'exact', head: true })
        .eq('goal_id', input.goalId)
        .eq('org_id', input.orgId);
      number = (count ?? 0) + 1;
    }

    const { data, error } = await this.db.admin
      .from('dev_iterations')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        goal_id: input.goalId ?? null,
        title: input.title,
        objective: input.objective,
        planned_outputs: input.plannedOutputs ?? [],
        status: 'planned',
        number: number ?? 1,
      })
      .select()
      .single();
    if (error) this.fail('dev_iterations.create', error);
    const iteration = data as DevIteration;

    await this.events.publish({
      type: 'dev.iteration.created',
      orgId: input.orgId,
      payload: { sessionId: input.sessionId, iterationId: iteration.id, goalId: input.goalId, number: iteration.number },
    });
    return iteration;
  }

  async updateIterationStatus(iterationId: string, orgId: string, status: string, extras: Record<string, unknown> = {}): Promise<DevIteration> {
    const { data, error } = await this.db.admin
      .from('dev_iterations')
      .update({ status, ...extras })
      .eq('id', iterationId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_iterations.updateStatus', error);
    const iteration = data as DevIteration;
    await this.events.publish({
      type: 'dev.iteration.updated',
      orgId,
      // sessionId is REQUIRED by the orchestrator's tick handler — without it the
      // event-driven re-tick never fires.
      payload: { iterationId, status, sessionId: iteration.session_id },
    });
    return iteration;
  }

  async listIterations(sessionId: string, orgId: string, goalId?: string): Promise<DevIteration[]> {
    let q = this.db.admin
      .from('dev_iterations')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });
    if (goalId) q = q.eq('goal_id', goalId);
    const { data, error } = await q;
    if (error) this.fail('dev_iterations.list', error);
    return (data ?? []) as DevIteration[];
  }

  // ── Human Tasks ───────────────────────────────────────────────────────────

  async createHumanTask(input: {
    orgId: string;
    sessionId: string;
    goalId?: string;
    iterationId?: string;
    title: string;
    description?: string;
    requiredOutput?: string;
    sensitive?: boolean;
    blocksTaskIds?: string[];
    instructions?: Record<string, unknown>;
  }): Promise<DevHumanTask> {
    const { data, error } = await this.db.admin
      .from('dev_human_tasks')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        goal_id: input.goalId ?? null,
        iteration_id: input.iterationId ?? null,
        title: input.title,
        description: input.description ?? null,
        required_output: input.requiredOutput ?? null,
        sensitive: input.sensitive ?? false,
        blocks_task_ids: input.blocksTaskIds ?? [],
        instructions: input.instructions ?? {},
        status: 'pending',
      })
      .select()
      .single();
    if (error) this.fail('dev_human_tasks.create', error);
    const task = data as DevHumanTask;

    await this.events.publish({
      type: 'dev.human_task.created',
      orgId: input.orgId,
      payload: { sessionId: input.sessionId, humanTaskId: task.id, title: task.title, sensitive: task.sensitive },
    });
    return task;
  }

  async listHumanTasks(sessionId: string, orgId: string, status?: string): Promise<DevHumanTask[]> {
    let q = this.db.admin
      .from('dev_human_tasks')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) this.fail('dev_human_tasks.list', error);
    return (data ?? []) as DevHumanTask[];
  }

  async submitHumanTask(taskId: string, orgId: string, result: Record<string, unknown>): Promise<DevHumanTask> {
    const { data, error } = await this.db.admin
      .from('dev_human_tasks')
      .update({ status: 'submitted', submitted_result: result })
      .eq('id', taskId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_human_tasks.submit', error);
    const task = data as DevHumanTask;
    await this.events.publish({
      type: 'dev.human_task.submitted',
      orgId,
      payload: { humanTaskId: taskId, sessionId: task.session_id },
    });
    return task;
  }

  async verifyHumanTask(taskId: string, orgId: string): Promise<DevHumanTask> {
    const now = new Date().toISOString();
    const { data, error } = await this.db.admin
      .from('dev_human_tasks')
      .update({ status: 'verified', completed_at: now })
      .eq('id', taskId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_human_tasks.verify', error);
    const task = data as DevHumanTask;
    await this.events.publish({
      type: 'dev.human_task.verified',
      orgId,
      payload: { humanTaskId: taskId, sessionId: task.session_id },
    });
    return task;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async registerAgent(input: {
    orgId: string;
    sessionId: string;
    role: string;
    name: string;
  }): Promise<DevAgent> {
    const { data, error } = await this.db.admin
      .from('dev_agents')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        role: input.role,
        name: input.name,
        status: 'idle',
        runtime: 'anthropic_model',
      })
      .select()
      .single();
    if (error) this.fail('dev_agents.register', error);
    return data as DevAgent;
  }

  async listAgents(sessionId: string, orgId: string): Promise<DevAgent[]> {
    const { data, error } = await this.db.admin
      .from('dev_agents')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId);
    if (error) this.fail('dev_agents.list', error);
    return (data ?? []) as DevAgent[];
  }

  async getAgent(sessionId: string, orgId: string, role: string): Promise<DevAgent | null> {
    const { data } = await this.db.admin
      .from('dev_agents')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .eq('role', role)
      .maybeSingle();
    return data as DevAgent | null;
  }

  async ensureAgent(input: { orgId: string; sessionId: string; role: string; name: string }): Promise<DevAgent> {
    const existing = await this.getAgent(input.sessionId, input.orgId, input.role);
    if (existing) return existing;
    return this.registerAgent(input);
  }

  async updateAgentStatus(agentId: string, orgId: string, status: string, extras: Record<string, unknown> = {}): Promise<void> {
    await this.db.admin
      .from('dev_agents')
      .update({ status, last_heartbeat_at: new Date().toISOString(), ...extras })
      .eq('id', agentId)
      .eq('org_id', orgId);
  }

  // ── Merge Proposals ───────────────────────────────────────────────────────

  async createMergeProposal(input: {
    orgId: string;
    sessionId: string;
    taskId?: string;
    sourceBranch: string;
    targetBranch: string;
    diffSummary?: string;
    riskLevel?: 'low' | 'medium' | 'high';
  }): Promise<DevMergeProposal> {
    const { data, error } = await this.db.admin
      .from('dev_merge_proposals')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        task_id: input.taskId ?? null,
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        diff_summary: input.diffSummary ?? null,
        risk_level: input.riskLevel ?? null,
        status: 'pending',
      })
      .select()
      .single();
    if (error) this.fail('dev_merge_proposals.create', error);
    const proposal = data as DevMergeProposal;
    await this.events.publish({
      type: 'dev.merge.proposed',
      orgId: input.orgId,
      payload: { sessionId: input.sessionId, proposalId: proposal.id, sourceBranch: input.sourceBranch },
    });
    return proposal;
  }

  async updateMergeProposal(proposalId: string, orgId: string, patch: Partial<DevMergeProposal>): Promise<DevMergeProposal> {
    const { data, error } = await this.db.admin
      .from('dev_merge_proposals')
      .update(patch)
      .eq('id', proposalId)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) this.fail('dev_merge_proposals.update', error);
    return data as DevMergeProposal;
  }

  async listMergeProposals(sessionId: string, orgId: string): Promise<DevMergeProposal[]> {
    const { data, error } = await this.db.admin
      .from('dev_merge_proposals')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });
    if (error) this.fail('dev_merge_proposals.list', error);
    return (data ?? []) as DevMergeProposal[];
  }

  // ── Dev Events (timeline) ─────────────────────────────────────────────────

  async logEvent(input: {
    orgId: string;
    sessionId: string;
    eventType: string;
    message?: string;
    goalId?: string;
    iterationId?: string;
    taskId?: string;
    agentId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.admin
      .from('dev_events')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        event_type: input.eventType,
        message: input.message ?? null,
        goal_id: input.goalId ?? null,
        iteration_id: input.iterationId ?? null,
        task_id: input.taskId ?? null,
        agent_id: input.agentId ?? null,
        payload: input.payload ?? {},
      })
      .then(({ error }) => {
        if (error) this.logger.warn(`dev_events insert failed: ${error.message}`);
      });
  }

  async listEvents(sessionId: string, orgId: string, limit = 100): Promise<unknown[]> {
    const { data, error } = await this.db.admin
      .from('dev_events')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) this.fail('dev_events.list', error);
    return data ?? [];
  }

  // ── Studio Dev Tasks ──────────────────────────────────────────────────────

  async createStudioTask(input: {
    orgId: string;
    sessionId: string;
    goalId?: string;
    iterationId?: string;
    title: string;
    prompt?: string;
    role: string;
    priority?: number;
    dependsOn?: string[];
    acceptanceCriteria?: unknown[];
    branchName?: string;
    userId: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.admin
      .from('dev_tasks')
      .insert({
        org_id: input.orgId,
        project_id: null,
        session_id: input.sessionId,
        goal_id: input.goalId ?? null,
        iteration_id: input.iterationId ?? null,
        title: input.title,
        prompt: input.prompt ?? null,
        status: 'queued',
        role: input.role,
        priority_studio: input.priority ?? 0,
        depends_on: input.dependsOn ?? [],
        acceptance_criteria: input.acceptanceCriteria ?? [],
        branch_name: input.branchName ?? null,
        created_by: input.userId,
        metadata: {},
      })
      .select()
      .single();
    if (error) this.fail('dev_tasks.createStudio', error);
    return data as Record<string, unknown>;
  }

  async listStudioTasks(sessionId: string, orgId: string, status?: string): Promise<Record<string, unknown>[]> {
    let q = this.db.admin
      .from('dev_tasks')
      .select('*')
      .eq('session_id', sessionId)
      .eq('org_id', orgId)
      .order('priority_studio', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) this.fail('dev_tasks.listStudio', error);
    return (data ?? []) as Record<string, unknown>[];
  }

  async updateStudioTaskStatus(taskId: string, orgId: string, status: string, extras: Record<string, unknown> = {}): Promise<void> {
    await this.db.admin
      .from('dev_tasks')
      .update({ status, ...extras })
      .eq('id', taskId)
      .eq('org_id', orgId);
  }

  /** Studio tasks of an iteration (for building real evaluation outputs). */
  async listIterationTasks(iterationId: string, orgId: string): Promise<Record<string, unknown>[]> {
    const { data } = await this.db.admin
      .from('dev_tasks')
      .select('id, role, title, status, result_summary, branch_name, artifacts')
      .eq('iteration_id', iterationId)
      .eq('org_id', orgId);
    return (data ?? []) as Record<string, unknown>[];
  }

  /**
   * Real, human-readable outputs of an iteration: each finished studio task's
   * role + title + result summary. Feeds the PM's goal evaluation so it judges
   * the actual work instead of a generic "Wave N completed" string.
   */
  async buildIterationOutputs(iterationId: string, orgId: string): Promise<string[]> {
    const tasks = await this.listIterationTasks(iterationId, orgId);
    const DONE = new Set(['needs_review', 'approved', 'merged', 'completed']);
    return tasks
      .filter((t) => DONE.has(t.status as string))
      .map((t) => {
        const role = (t.role as string) ?? 'dev';
        const title = (t.title as string) ?? '';
        const summary = (t.result_summary as string) ?? '';
        const branch = t.branch_name ? ` (branch: ${t.branch_name})` : '';
        return `[${role}] ${title}${branch}${summary ? `\n  → ${summary}` : ''}`;
      });
  }

  /**
   * Sessions that may need a nudge from the heartbeat: non-terminal, not waiting
   * on a human, whose last update is older than `staleMs`. Cross-org (admin) —
   * the heartbeat re-ticks each with its own org_id.
   */
  async listStaleRunningSessions(staleMs: number, limit = 50): Promise<Array<{ id: string; org_id: string; status: string }>> {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const { data } = await this.db.admin
      .from('dev_sessions')
      .select('id, org_id, status, updated_at')
      .in('status', ['running'])
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(limit);
    return (data ?? []) as Array<{ id: string; org_id: string; status: string }>;
  }

  /**
   * Iterations stuck in `running` whose work can't still be in flight (older than
   * `staleMs`). Used to recover after a crash/restart: their assigned/running
   * tasks are orphaned and must be requeued.
   */
  async listStaleRunningIterations(staleMs: number, limit = 100): Promise<Array<{ id: string; session_id: string; org_id: string }>> {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const { data } = await this.db.admin
      .from('dev_iterations')
      .select('id, session_id, org_id, started_at, created_at')
      .eq('status', 'running')
      .lt('started_at', cutoff)
      .order('started_at', { ascending: true })
      .limit(limit);
    return (data ?? []) as Array<{ id: string; session_id: string; org_id: string }>;
  }

  /**
   * Requeue tasks of an iteration that were left mid-flight (assigned/running)
   * — e.g. when the process died during a wave. Returns how many were requeued.
   */
  async requeueOrphanedTasks(iterationId: string, orgId: string): Promise<number> {
    const { data } = await this.db.admin
      .from('dev_tasks')
      .update({ status: 'queued' })
      .eq('iteration_id', iterationId)
      .eq('org_id', orgId)
      .in('status', ['assigned', 'running'])
      .select('id');
    return ((data ?? []) as unknown[]).length;
  }

  /**
   * Aggregate view of a single agent (role) for the flow diagram detail panel.
   * Returns studio tasks for this role, their communications from dev_events,
   * and the backing task id (if any is currently running).
   */
  async getAgentDetail(sessionId: string, orgId: string, role: string): Promise<Record<string, unknown>> {
    const [tasksRes, backingRes, agentRes] = await Promise.all([
      this.db.admin
        .from('dev_tasks')
        .select('id, title, status, branch_name, created_at, updated_at, acceptance_criteria, iteration_id, result_summary, priority')
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .eq('role', role)
        .order('created_at', { ascending: true }),
      // Find the active backing task (tasks table) for this role
      this.db.admin
        .from('tasks')
        .select('id, status, title, created_at, updated_at, metadata')
        .eq('org_id', orgId)
        .filter('metadata->>session_id', 'eq', sessionId)
        .filter('metadata->>role', 'eq', role)
        .not('status', 'in', '("completed","failed","cancelled")')
        .order('created_at', { ascending: false })
        .limit(1),
      // Agent registry row (status, current task, heartbeat)
      this.db.admin
        .from('dev_agents')
        .select('id, role, name, status, current_task_id, last_heartbeat_at, branch_name, runtime, container_id, node_id, metadata')
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .eq('role', role)
        .maybeSingle(),
    ]);

    const tasks = (tasksRes.data ?? []) as Record<string, unknown>[];
    const backing = ((backingRes.data ?? []) as Record<string, unknown>[])[0] ?? null;
    const agent = (agentRes.data ?? null) as Record<string, unknown> | null;

    // Events for this role — filter by the role's studio task IDs (dev_events has
    // no `actor` column; events are tagged with the studio task_id they belong to).
    const studioTaskIds = tasks.map((t) => t.id as string).filter(Boolean);
    let events: Record<string, unknown>[] = [];
    if (studioTaskIds.length > 0) {
      const { data: evData } = await this.db.admin
        .from('dev_events')
        .select('id, event_type, message, payload, created_at, task_id, iteration_id')
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .in('task_id', studioTaskIds)
        .order('created_at', { ascending: false })
        .limit(80);
      events = ((evData ?? []) as Record<string, unknown>[]).map((e) => ({ ...e, actor: role }));
    }

    // Completed backing tasks for history
    const { data: allBacking } = await this.db.admin
      .from('tasks')
      .select('id, status, title, created_at, updated_at')
      .eq('org_id', orgId)
      .filter('metadata->>session_id', 'eq', sessionId)
      .filter('metadata->>role', 'eq', role)
      .order('created_at', { ascending: false })
      .limit(20);

    return {
      role,
      sessionId,
      agent,
      studioTasks: tasks,
      events,
      activeBackingTask: backing,
      allBackingTasks: (allBacking ?? []) as Record<string, unknown>[],
    };
  }

  /**
   * Task events (step logs) for the most recent backing task of a given role.
   */
  async getAgentLogs(sessionId: string, orgId: string, role: string, limit = 200): Promise<Record<string, unknown>[]> {
    // Get most recent backing task id for this role in this session
    const { data: tasks } = await this.db.admin
      .from('tasks')
      .select('id')
      .eq('org_id', orgId)
      .filter('metadata->>session_id', 'eq', sessionId)
      .filter('metadata->>role', 'eq', role)
      .order('created_at', { ascending: false })
      .limit(1);

    const taskId = ((tasks ?? []) as { id: string }[])[0]?.id;
    if (!taskId) return [];

    // task_events columns: id, event_type, payload, created_at (NOT step/type/content).
    // Reshape into the { step, type, content } shape the UI renders.
    const { data } = await this.db.admin
      .from('task_events')
      .select('id, event_type, payload, created_at')
      .eq('task_id', taskId)
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .limit(limit);

    return ((data ?? []) as Array<{ id: string; event_type: string; payload: Record<string, unknown>; created_at: string }>)
      .map((e, i) => ({
        id: e.id,
        step: (e.payload?.step as number) ?? i + 1,
        type: mapEventToLogType(e.event_type, e.payload),
        event_type: e.event_type,
        content: e.payload ?? {},
        created_at: e.created_at,
      }));
  }

  /**
   * Live flow state for the diagram: per-agent current task + how long it's been
   * without progress (stuck), the most recent instruction on each communication
   * edge (who told whom to do what, and when), and a single "where is it stuck"
   * summary. Lets the UI show exactly what each agent is doing and where work is
   * blocked instead of just a static topology.
   */
  async getFlowState(sessionId: string, orgId: string): Promise<{
    assigner: string;
    iterationObjective: string | null;
    agents: Array<{
      role: string; status: string; name: string;
      currentTaskId: string | null; currentTaskTitle: string | null; currentTaskStatus: string | null;
      lastUpdateAt: string | null; stuckMs: number | null;
    }>;
    handoffs: Array<{ from: string; to: string; instruction: string; at: string | null; taskId: string | null; status: string }>;
    stuck: { role: string; reason: string; sinceMs: number | null; taskTitle: string | null } | null;
  }> {
    const [session, agents, tasks] = await Promise.all([
      this.findById(sessionId, orgId),
      this.listAgents(sessionId, orgId),
      this.listStudioTasks(sessionId, orgId),
    ]);
    const now = Date.now();

    // The "assigner" of dev work: the architect when present, else the PM.
    const hasArchitect = agents.some((a) => a.role === 'architect');
    const assigner = hasArchitect ? 'architect' : 'project_manager';

    // Current iteration objective = the instruction PM → architect.
    let iterationObjective: string | null = null;
    let iterationStartedAt: string | null = null;
    if (session?.current_iteration_id) {
      const { data } = await this.db.admin
        .from('dev_iterations')
        .select('title, objective, started_at')
        .eq('id', session.current_iteration_id)
        .maybeSingle();
      const it = data as { title?: string; objective?: string; started_at?: string } | null;
      iterationObjective = it?.objective ?? it?.title ?? null;
      iterationStartedAt = it?.started_at ?? null;
    }

    const ts = (t: Record<string, unknown>) =>
      new Date((t.updated_at as string) ?? (t.created_at as string) ?? 0).getTime();

    const tasksByRole = new Map<string, Record<string, unknown>[]>();
    for (const t of tasks) {
      const r = (t.role as string) ?? 'backend';
      const arr = tasksByRole.get(r) ?? [];
      arr.push(t);
      tasksByRole.set(r, arr);
    }

    const ACTIVE_TASK = new Set(['running', 'assigned', 'needs_review']);
    const STUCK_STATUS = new Set(['running', 'blocked', 'assigned', 'waiting_for_dependency']);

    const agentRows = agents.map((a) => {
      const roleTasks = (tasksByRole.get(a.role) ?? []).slice().sort((x, y) => ts(y) - ts(x));
      const current = roleTasks.find((t) => ACTIVE_TASK.has(t.status as string)) ?? roleTasks[0] ?? null;
      const lastUpdateAt =
        (a.last_heartbeat_at as string | null) ?? (current?.updated_at as string | undefined) ?? null;
      const stuckMs =
        STUCK_STATUS.has(a.status) && lastUpdateAt ? now - new Date(lastUpdateAt).getTime() : null;
      return {
        role: a.role,
        status: a.status,
        name: a.name,
        currentTaskId: (current?.id as string | undefined) ?? null,
        currentTaskTitle: (current?.title as string | undefined) ?? null,
        currentTaskStatus: (current?.status as string | undefined) ?? null,
        lastUpdateAt,
        stuckMs,
      };
    });

    // Handoffs: the latest instruction on each communication edge.
    const handoffs: Array<{ from: string; to: string; instruction: string; at: string | null; taskId: string | null; status: string }> = [];
    if (hasArchitect && iterationObjective) {
      handoffs.push({ from: 'project_manager', to: 'architect', instruction: iterationObjective, at: iterationStartedAt, taskId: null, status: session?.status ?? 'in_progress' });
    }
    for (const [role, list] of tasksByRole) {
      if (role === assigner) continue;
      const latest = list.slice().sort((x, y) =>
        new Date((y.created_at as string) ?? 0).getTime() - new Date((x.created_at as string) ?? 0).getTime(),
      )[0];
      if (!latest) continue;
      handoffs.push({
        from: assigner,
        to: role,
        instruction: (latest.title as string) ?? '',
        at: (latest.created_at as string) ?? null,
        taskId: (latest.id as string) ?? null,
        status: (latest.status as string) ?? 'queued',
      });
    }

    // Where is it stuck? Priority: blocked/failed agent → waiting on human → slow agent.
    const STUCK_THRESHOLD_MS = 90_000;
    let stuck: { role: string; reason: string; sinceMs: number | null; taskTitle: string | null } | null = null;
    const blocked = agentRows.find((a) => a.status === 'blocked' || a.status === 'failed');
    if (blocked) {
      stuck = {
        role: blocked.role,
        reason: blocked.status === 'failed' ? 'tarea fallida' : 'bloqueado — requiere intervención',
        sinceMs: blocked.stuckMs,
        taskTitle: blocked.currentTaskTitle,
      };
    } else if (session && session.status.startsWith('waiting_for_human')) {
      stuck = { role: 'human', reason: 'esperando acción humana', sinceMs: null, taskTitle: null };
    } else {
      const slow = agentRows
        .filter((a) => (a.stuckMs ?? 0) > STUCK_THRESHOLD_MS)
        .sort((x, y) => (y.stuckMs ?? 0) - (x.stuckMs ?? 0))[0];
      if (slow) stuck = { role: slow.role, reason: 'sin avance reciente', sinceMs: slow.stuckMs, taskTitle: slow.currentTaskTitle };
    }

    return { assigner, iterationObjective, agents: agentRows, handoffs, stuck };
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Dev Studio: failed at ${scope}`);
  }
}
