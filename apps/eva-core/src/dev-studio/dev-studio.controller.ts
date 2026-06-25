import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param,
  ParseUUIDPipe, Post, Req, Query, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { DevSessionService } from './dev-session.service';
import { DevOrchestratorService } from './dev-orchestrator.service';
import { DevProjectManagerService } from './dev-project-manager.service';
import { ClaudeCodeRunnerService, CLAUDE_AUTH_OPTIONS, ClaudeAuthMethod } from './claude-code-runner.service';
import { GithubService } from './github/github.service';
import { machineSpecForRole } from './agent-machines';
import { CreateSessionDto } from './dto/create-session.dto';
import { PlanSessionDto } from './dto/plan-session.dto';
import { ApproveGoalsDto } from './dto/approve-goals.dto';
import { SubmitHumanTaskDto } from './dto/submit-human-task.dto';
import { SteerSessionDto } from './dto/steer-session.dto';
import { MergeActionDto } from './dto/merge-action.dto';
import { ConnectRepoDto } from './dto/connect-repo.dto';
import { DevAgent } from './dev-studio.types';

@Controller('dev-studio')
export class DevStudioController {
  constructor(
    private readonly sessions: DevSessionService,
    private readonly orchestrator: DevOrchestratorService,
    private readonly claudeCode: ClaudeCodeRunnerService,
    private readonly pm: DevProjectManagerService,
    private readonly github: GithubService,
  ) {}

  /**
   * Persist a machine-local Claude login and release every auth-specific wait
   * attached to this session. This is shared by the explicit re-check button
   * and OAuth polling so a login completed in the terminal resumes work too.
   */
  private async reconcileAuthenticatedMachine(
    sessionId: string,
    orgId: string,
    agent: DevAgent,
  ): Promise<void> {
    const pending = await this.sessions.listHumanTasks(sessionId, orgId, 'pending');
    const authTasks = pending.filter(
      (task) => (task.instructions as Record<string, unknown> | undefined)?.kind === 'claude_code_auth',
    );
    const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
    const machine = (metadata.machine ?? {}) as Record<string, unknown>;
    const resetBlocked = agent.status === 'blocked' && (authTasks.length > 0 || machine.authOk === false);

    await this.sessions.updateAgentStatus(agent.id, orgId, resetBlocked ? 'idle' : (agent.status ?? 'idle'), {
      current_task_id: resetBlocked ? null : agent.current_task_id,
      metadata: {
        ...metadata,
        machine: {
          ...machine,
          authOk: true,
          authError: null,
          checkedAt: new Date().toISOString(),
        },
      },
    });

    for (const task of authTasks) {
      await this.sessions.submitHumanTask(task.id, orgId, { method: 'oauth', configured: true });
      await this.sessions.verifyHumanTask(task.id, orgId);
    }

    if (authTasks.length > 0 || resetBlocked) {
      void this.orchestrator.tick(sessionId, orgId);
    }
  }

  // ── Project planning preview (no session created) ─────────────────────────

  @Post('sessions/plan')
  @HttpCode(HttpStatus.OK)
  async planSession(@Body() dto: PlanSessionDto, @Req() req: AuthenticatedRequest) {
    return this.pm.previewPlan(dto.description, req.user.orgId);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  async createSession(@Body() dto: CreateSessionDto, @Req() req: AuthenticatedRequest) {
    const { orgId, userId } = req.user;
    const title = dto.title ?? dto.prompt.slice(0, 80);
    const session = await this.sessions.create({
      orgId,
      userId,
      title,
      originalPrompt: dto.prompt,
      projectId: dto.project_id,
    });
    // If a wizard pre-approved plan was provided, seed goals immediately and run
    if (dto.preplan?.autoApprove && dto.preplan.goals?.length) {
      void this.orchestrator.startSessionWithPreplan(session.id, orgId, dto.preplan as any);
    }
    return session;
  }

  @Get('sessions')
  listSessions(@Req() req: AuthenticatedRequest) {
    return this.sessions.list(req.user.orgId, req.user.userId);
  }

  @Get('sessions/:id')
  getSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.findByIdOrThrow(id, req.user.orgId);
  }

  @Post('sessions/:id/start')
  @HttpCode(HttpStatus.ACCEPTED)
  async startSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    await this.orchestrator.startSession(id, req.user.orgId);
    return { accepted: true, sessionId: id };
  }

  @Post('sessions/:id/pause')
  pauseSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.pause(id, req.user.orgId);
  }

  @Post('sessions/:id/resume')
  async resumeSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    const session = await this.sessions.resume(id, req.user.orgId);
    void this.orchestrator.tick(id, req.user.orgId);
    return session;
  }

  @Post('sessions/:id/cancel')
  async cancelSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    const result = await this.sessions.cancel(id, req.user.orgId);
    void this.orchestrator.shutdownSessionMachines(id, req.user.orgId);
    return result;
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    try {
      await this.sessions.deleteSession(id, req.user.orgId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('sessions/:id/steer')
  @HttpCode(HttpStatus.ACCEPTED)
  async steerSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SteerSessionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.orchestrator.steerSession(id, req.user.orgId, dto.message);
    return { accepted: true };
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  @Get('sessions/:id/goals')
  listGoals(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.listGoals(id, req.user.orgId);
  }

  @Post('sessions/:id/goals/approve')
  @HttpCode(HttpStatus.ACCEPTED)
  async approveGoals(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveGoalsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.orchestrator.approveGoalsAndRun(id, req.user.orgId, dto.goal_ids);
    return { accepted: true, approvedGoals: dto.goal_ids.length };
  }

  @Post('goals/:id/validate')
  @HttpCode(HttpStatus.ACCEPTED)
  async validateGoal(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    await this.sessions.updateGoalStatus(id, orgId, 'validated');
    // Human validated → tick the session
    const goal = await this.sessions.findGoalById(id, orgId);
    if (goal) void this.orchestrator.tick(goal.session_id, orgId);
    return { validated: true };
  }

  // ── Iterations ────────────────────────────────────────────────────────────

  @Get('sessions/:id/iterations')
  listIterations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('goal_id') goalId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.listIterations(id, req.user.orgId, goalId);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  @Get('sessions/:id/tasks')
  listTasks(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.listStudioTasks(id, req.user.orgId, status);
  }

  @Post('tasks/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retryTask(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    const { orgId } = req.user;
    const task = await this.sessions.retryStudioTask(id, orgId);
    const sessionId = task?.session_id as string | undefined;
    if (sessionId) void this.orchestrator.tick(sessionId, orgId);
    return { ok: true, task };
  }

  @Delete('tasks/:id')
  @HttpCode(HttpStatus.OK)
  async deleteTask(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    await this.sessions.deleteStudioTask(id, req.user.orgId);
    return { ok: true };
  }

  @Get('tasks/:id/events')
  getTaskEvents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.listTaskEvents(id, req.user.orgId, limit ? parseInt(limit, 10) : 100);
  }

  /**
   * Force-requeue all tasks currently frozen in `assigned` or `running` for a
   * session. Designed for the "Desatasca" button in the UI when tasks are
   * visibly stuck and the heartbeat hasn't recovered them yet.
   * Safe to call at any time — requeued tasks will be re-dispatched on the
   * next tick, which this endpoint triggers immediately.
   */
  @Post('sessions/:id/unstick')
  @HttpCode(HttpStatus.OK)
  async unstickSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    const { orgId } = req.user;
    const result = await this.sessions.unstickSession(id, orgId);
    void this.orchestrator.tick(id, orgId);
    return { ok: true, ...result };
  }

  // ── Human Tasks ───────────────────────────────────────────────────────────

  @Get('sessions/:id/human-tasks')
  listHumanTasks(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.listHumanTasks(id, req.user.orgId, status);
  }

  @Post('human-tasks/:id/submit')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitHumanTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitHumanTaskDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const task = await this.sessions.submitHumanTask(id, orgId, { ...dto.result, notes: dto.notes });
    return task;
  }

  @Post('human-tasks/:id/verify')
  @HttpCode(HttpStatus.ACCEPTED)
  async verifyHumanTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const task = await this.sessions.verifyHumanTask(id, orgId);
    // After verification, tick the session
    void this.orchestrator.tick(task.session_id, orgId);
    return task;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  @Get('sessions/:id/agents')
  listAgents(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.listAgents(id, req.user.orgId);
  }

  @Delete('agents/:id')
  @HttpCode(HttpStatus.OK)
  async deleteAgent(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    const { orgId } = req.user;
    await this.claudeCode.destroyMachine(id).catch(() => undefined);
    await this.sessions.deleteAgent(id, orgId);
    return { ok: true };
  }

  /**
   * Live flow state for the diagram: per-agent current task + stuck timing, the
   * last instruction on each communication edge, and a "where is it stuck" hint.
   */
  @Get('sessions/:id/flow')
  getFlowState(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.getFlowState(id, req.user.orgId);
  }

  /**
   * Full agent detail: current task, history, backing task id, communications.
   * Used by the flow diagram's agent detail panel.
   */
  @Get('sessions/:id/agents/:role/detail')
  async getAgentDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const detail = await this.sessions.getAgentDetail(id, orgId, role);
    // Enrich with live machine state (image, container, whether it's up right now).
    const agent = detail.agent as { id?: string; runtime?: string; metadata?: Record<string, unknown> } | null;
    const live = agent?.id ? this.claudeCode.machineInfo(agent.id) : null;
    const spec = machineSpecForRole(role);
    const machineMeta = (agent?.metadata?.machine ?? {}) as { authOk?: boolean | null; authError?: string };
    detail.machine = {
      key: agent?.id ?? null,
      image: live?.image ?? null,
      defaultImage: spec.image,
      tooling: spec.toolingLabel,
      containerName: live?.containerName ?? null,
      up: Boolean(live),
      runtime: agent?.runtime ?? null,
      // null = not a code role / not checked; true = logged in; false = bad token.
      authOk: machineMeta.authOk ?? null,
      authError: machineMeta.authError ?? null,
    };
    return detail;
  }

  /**
   * Re-check Claude Code auth state for an agent's machine without running a
   * full task. Detects both env-var tokens AND credentials written by manual
   * `claude auth login`, then persists the result to dev_agents.metadata.
   */
  @Post('sessions/:id/agents/:role/machine/check-auth')
  @HttpCode(HttpStatus.OK)
  async checkAgentAuth(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const agent = await this.sessions.getAgent(id, orgId, role);
    if (!agent) return { ok: false, authOk: false, error: 'Agente no encontrado' };

    // If the machine isn't in the in-memory map, try to boot/reconnect it first.
    if (!this.claudeCode.hasContainer(agent.id)) {
      await this.claudeCode.bootMachine({ orgId, key: agent.id, role });
    }

    const check = await this.claudeCode.verifyAuth(orgId, agent.id);

    if (check.ok) {
      await this.reconcileAuthenticatedMachine(id, orgId, agent);
      return { ok: true, authOk: true, error: null };
    }

    // Persist the result so the UI badge updates without a full session tick.
    const existing = (agent.metadata ?? {}) as Record<string, unknown>;
    await this.sessions.updateAgentStatus(agent.id, orgId, agent.status ?? 'idle', {
      metadata: {
        ...existing,
        machine: {
          ...((existing.machine ?? {}) as Record<string, unknown>),
          authOk: check.ok,
          authError: check.error ?? null,
          checkedAt: new Date().toISOString(),
        },
      },
    });

    return { ok: check.ok, authOk: check.ok, error: check.error ?? null };
  }

  /** Manually (re)boot an agent's machine — lets the user spin it up on demand. */
  @Post('sessions/:id/agents/:role/machine/boot')
  @HttpCode(HttpStatus.ACCEPTED)
  async bootAgentMachine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const agent = await this.sessions.ensureAgent({
      orgId, sessionId: id, role, name: `${role} Agent`,
    });
    const result = await this.claudeCode.bootMachine({ orgId, key: agent.id, role });
    if (result.ok) {
      await this.sessions.updateAgentStatus(agent.id, orgId, agent.status ?? 'idle', {
        runtime: result.image ? `docker:${result.image}` : 'docker',
        container_id: result.containerName ?? null,
      });
    }
    return { agentId: agent.id, ...result };
  }

  /**
   * Start an OAuth device-code flow for an agent's machine.
   * The backend runs `claude setup-token` inside the container and returns the
   * auth URL the user must open in their browser. Poll /oauth/status to check
   * when authentication completes and the token has been saved.
   */
  @Post('sessions/:id/agents/:role/machine/oauth/start')
  @HttpCode(HttpStatus.OK)
  async startAgentOAuth(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const agent = await this.sessions.ensureAgent({ orgId, sessionId: id, role, name: `${role} Agent` });

    // Boot the machine if it isn't already up — OAuth needs a running container.
    if (!this.claudeCode.hasContainer(agent.id)) {
      const boot = await this.claudeCode.bootMachine({ orgId, key: agent.id, role });
      if (!boot.ok) throw new BadRequestException(`No se pudo levantar la máquina: ${boot.error}`);
    }

    // The user may already have completed `claude auth login` in this machine.
    // Reconcile it instead of starting a second OAuth process.
    if (await this.claudeCode.hasCredential(orgId, agent.id)) {
      await this.reconcileAuthenticatedMachine(id, orgId, agent);
      return { ok: true, url: null, agentId: agent.id, error: null, useTerminal: false, configured: true };
    }

    const result = await this.claudeCode.startOAuthFlow(orgId, agent.id);
    if ('error' in result) {
      // Return structured error so the UI can decide to show the terminal instead.
      // Use 200 with ok:false rather than 400 so the frontend can read the message.
      return { ok: false, url: null, agentId: agent.id, error: result.error, useTerminal: true };
    }
    return { ok: true, url: result.url, agentId: agent.id, error: null, useTerminal: false };
  }

  /** Poll the OAuth flow status after startAgentOAuth. */
  @Get('sessions/:id/agents/:role/machine/oauth/status')
  async getAgentOAuthStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const agent = await this.sessions.getAgent(id, orgId, role);
    if (!agent) throw new NotFoundException('Agente no encontrado');
    const state = this.claudeCode.pollOAuthResult(agent.id);
    if (!state) {
      // No active flow — accept either an org credential or this machine's
      // local Claude login.
      const configured = await this.claudeCode.hasCredential(orgId, agent.id);
      if (configured) await this.reconcileAuthenticatedMachine(id, orgId, agent);
      return { status: configured ? 'completed' : 'idle', configured, url: null, error: null };
    }
    // When completed, tick the session so any waiting provisioning task resumes.
    if (state.configured) {
      await this.reconcileAuthenticatedMachine(id, orgId, agent);
    }
    return state;
  }

  /**
   * Submit the authorization code obtained after visiting the OAuth URL.
   * The code is piped to the running `claude auth login` process so it can
   * exchange it for a token without the user needing to use the terminal.
   */
  @Post('sessions/:id/agents/:role/machine/oauth/code')
  @HttpCode(HttpStatus.OK)
  async submitAgentOAuthCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Body() body: { code: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    const agent = await this.sessions.getAgent(id, orgId, role);
    if (!agent) throw new NotFoundException('Agente no encontrado');
    if (!body?.code?.trim()) throw new BadRequestException('El campo `code` es requerido');
    const ok = this.claudeCode.submitOAuthCode(agent.id, body.code.trim());
    if (!ok) {
      const configured = await this.claudeCode.hasCredential(orgId, agent.id);
      if (configured) return { ok: true, alreadyConfigured: true };
      throw new BadRequestException('No hay un flujo OAuth activo esperando el código. Reinicia el flujo.');
    }
    return { ok: true };
  }

  /**
   * Logs for a specific agent's current/last backing task (task_events).
   */
  @Get('sessions/:id/agents/:role/logs')
  async getAgentLogs(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;
    return this.sessions.getAgentLogs(id, orgId, role, limit ? parseInt(limit, 10) : 100);
  }

  // ── Claude Code provisioning ──────────────────────────────────────────────

  /** The auth methods offered the first time a code agent needs Claude Code. */
  @Get('claude-code/options')
  claudeCodeOptions() {
    return { options: CLAUDE_AUTH_OPTIONS };
  }

  /** Whether the org already has a Claude Code credential + image readiness. */
  @Get('claude-code/status')
  async claudeCodeStatus(@Req() req: AuthenticatedRequest) {
    const [configured, baseImage] = await Promise.all([
      this.claudeCode.hasCredential(req.user.orgId),
      this.claudeCode.resolveImage('project_manager'),
    ]);
    return { configured, imageReady: Boolean(baseImage), baseImage };
  }

  /** Save the chosen auth method + token, then resume any blocked session. */
  @Post('sessions/:id/claude-code/credential')
  @HttpCode(HttpStatus.OK)
  async saveClaudeCodeCredential(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { method: ClaudeAuthMethod; token: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const { orgId } = req.user;

    // Validate the token before storing it — a clearly-invalid/expired token is
    // rejected with a reason; infra-only failures (no docker/image) don't block.
    const check = await this.claudeCode.verifyToken(body.method, body.token);
    if (check.authFailed) {
      throw new BadRequestException(`Token de Claude Code inválido: ${check.error ?? 'rechazado por la API'}`);
    }

    await this.claudeCode.saveCredential(orgId, body.method, body.token);

    // Verify any pending claude_code_auth human task for this session, then tick.
    const pending = await this.sessions.listHumanTasks(id, orgId, 'pending');
    for (const t of pending) {
      if ((t.instructions as Record<string, unknown> | undefined)?.kind === 'claude_code_auth') {
        await this.sessions.submitHumanTask(t.id, orgId, { method: body.method, configured: true });
        await this.sessions.verifyHumanTask(t.id, orgId);
      }
    }
    void this.orchestrator.tick(id, orgId);
    return { ok: true };
  }

  // ── Events (timeline) ─────────────────────────────────────────────────────

  @Get('sessions/:id/events')
  listEvents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.listEvents(id, req.user.orgId, limit ? parseInt(limit, 10) : 100);
  }

  // ── Merge Proposals ───────────────────────────────────────────────────────

  @Get('sessions/:id/merge-proposals')
  listMergeProposals(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.listMergeProposals(id, req.user.orgId);
  }

  @Post('merge-proposals/:id/approve')
  @HttpCode(HttpStatus.ACCEPTED)
  async approveMerge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Performs the real GitHub merge when the proposal is backed by a PR.
    return this.orchestrator.approveMergeProposal(id, req.user.orgId, dto.reviewer_notes);
  }

  @Post('merge-proposals/:id/reject')
  @HttpCode(HttpStatus.ACCEPTED)
  async rejectMerge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Closes the PR on GitHub when the proposal is backed by one.
    return this.orchestrator.rejectMergeProposal(id, req.user.orgId, dto.reviewer_notes);
  }

  // ── GitHub connection + repo browsing ───────────────────────────────────────

  /** Org-level GitHub token status (login + scopes) for the connection UI. */
  @Get('github/status')
  async githubStatus(@Req() req: AuthenticatedRequest) {
    return this.github.validateToken(req.user.orgId);
  }

  /** Connect an existing repo (by URL) or create a new one, then bind it to the session. */
  @Post('sessions/:id/repo/connect')
  @HttpCode(HttpStatus.OK)
  async connectRepo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectRepoDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orchestrator.connectRepo(id, req.user.orgId, dto);
  }

  /** Read-only file tree for a branch (defaults to the integration branch). */
  @Get('sessions/:id/repo/tree')
  async repoTree(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('ref') ref: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const session = await this.sessions.findByIdOrThrow(id, req.user.orgId);
    const coords = this.repoCoords(session);
    if (!coords) return [];
    return this.github.getTree(req.user.orgId, coords.owner, coords.repo, ref || session.integration_branch || 'develop');
  }

  /** Read-only file content at a path/ref (decoded UTF-8; large/binary flagged). */
  @Get('sessions/:id/repo/file')
  async repoFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('path') path: string | undefined,
    @Query('ref') ref: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const session = await this.sessions.findByIdOrThrow(id, req.user.orgId);
    const coords = this.repoCoords(session);
    if (!coords || !path) throw new BadRequestException('Repo no conectado o path faltante');
    return this.github.getContent(req.user.orgId, coords.owner, coords.repo, path, ref || session.integration_branch || 'develop');
  }

  /** Diff (changed files + patches) for the PR backing a merge proposal. */
  @Get('merge-proposals/:id/files')
  async mergeProposalFiles(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    const proposal = await this.sessions.getMergeProposal(id, req.user.orgId);
    if (!proposal?.pr_number) return [];
    const session = await this.sessions.findByIdOrThrow(proposal.session_id, req.user.orgId);
    const coords = this.repoCoords(session);
    if (!coords) return [];
    return this.github.getPullRequestFiles(req.user.orgId, coords.owner, coords.repo, proposal.pr_number);
  }

  /** Resolve owner/repo from stored columns, falling back to parsing repo_url. */
  private repoCoords(session: { repo_owner: string | null; repo_name: string | null; repo_url: string | null }):
    | { owner: string; repo: string }
    | null {
    if (session.repo_owner && session.repo_name) return { owner: session.repo_owner, repo: session.repo_name };
    if (session.repo_url) {
      try {
        return GithubService.parseRepoUrl(session.repo_url);
      } catch {
        return null;
      }
    }
    return null;
  }

  // ── Orchestrator manual tick (debug/resume) ────────────────────────────────

  @Post('sessions/:id/tick')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualTick(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.orchestrator.tick(id, req.user.orgId);
  }
}
