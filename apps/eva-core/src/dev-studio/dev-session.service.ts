import { Injectable, InternalServerErrorException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EventBusService } from '../events/event-bus.service';
import {
  DevSession, DevSessionStatus, isValidSessionTransition,
  DevGoal, DevIteration, DevHumanTask, DevAgent, DevMergeProposal,
} from './dev-studio.types';

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
      payload: { iterationId, status },
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

  /**
   * Aggregate view of a single agent (role) for the flow diagram detail panel.
   * Returns studio tasks for this role, their communications from dev_events,
   * and the backing task id (if any is currently running).
   */
  async getAgentDetail(sessionId: string, orgId: string, role: string): Promise<Record<string, unknown>> {
    const [tasksRes, eventsRes, backingRes] = await Promise.all([
      this.db.admin
        .from('dev_tasks')
        .select('id, title, status, branch_name, created_at, updated_at, acceptance_criteria, iteration_id')
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .eq('role', role)
        .order('created_at', { ascending: true }),
      this.db.admin
        .from('dev_events')
        .select('id, event_type, message, actor, created_at, metadata')
        .eq('session_id', sessionId)
        .eq('org_id', orgId)
        .or(`actor.eq.${role},metadata->>target_role.eq.${role}`)
        .order('created_at', { ascending: false })
        .limit(50),
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
    ]);

    const tasks = (tasksRes.data ?? []) as Record<string, unknown>[];
    const events = (eventsRes.data ?? []) as Record<string, unknown>[];
    const backing = ((backingRes.data ?? []) as Record<string, unknown>[])[0] ?? null;

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
      studioTasks: tasks,
      events,
      activeBackingTask: backing,
      allBackingTasks: (allBacking ?? []) as Record<string, unknown>[],
    };
  }

  /**
   * Task events (step logs) for the most recent backing task of a given role.
   */
  async getAgentLogs(sessionId: string, orgId: string, role: string, limit = 100): Promise<Record<string, unknown>[]> {
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

    const { data } = await this.db.admin
      .from('task_events')
      .select('id, step, type, content, created_at')
      .eq('task_id', taskId)
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .limit(limit);

    return (data ?? []) as Record<string, unknown>[];
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Dev Studio: failed at ${scope}`);
  }
}
