import {
  Body, Controller, Get, HttpCode, HttpStatus, Param,
  ParseUUIDPipe, Post, Req, Query, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { DevSessionService } from './dev-session.service';
import { DevOrchestratorService } from './dev-orchestrator.service';
import { ClaudeCodeRunnerService, CLAUDE_AUTH_OPTIONS, ClaudeAuthMethod } from './claude-code-runner.service';
import { machineSpecForRole } from './agent-machines';
import { CreateSessionDto } from './dto/create-session.dto';
import { ApproveGoalsDto } from './dto/approve-goals.dto';
import { SubmitHumanTaskDto } from './dto/submit-human-task.dto';
import { SteerSessionDto } from './dto/steer-session.dto';
import { MergeActionDto } from './dto/merge-action.dto';

@Controller('dev-studio')
export class DevStudioController {
  constructor(
    private readonly sessions: DevSessionService,
    private readonly orchestrator: DevOrchestratorService,
    private readonly claudeCode: ClaudeCodeRunnerService,
  ) {}

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
    const result = await this.claudeCode.startOAuthFlow(orgId, agent.id);
    if ('error' in result) throw new BadRequestException(result.error);
    return { url: result.url, agentId: agent.id };
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
      // No active flow — return whether the org already has a credential.
      const configured = await this.claudeCode.hasCredential(orgId);
      return { status: configured ? 'completed' : 'idle', configured, url: null, error: null };
    }
    // When completed, tick the session so any waiting provisioning task resumes.
    if (state.configured) {
      const pending = await this.sessions.listHumanTasks(id, orgId, 'pending');
      for (const t of pending) {
        if ((t.instructions as Record<string, unknown>)?.kind === 'claude_code_auth') {
          await this.sessions.submitHumanTask(t.id, orgId, { method: 'oauth', configured: true });
          await this.sessions.verifyHumanTask(t.id, orgId);
        }
      }
      void this.orchestrator.tick(id, orgId);
    }
    return state;
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
    const updated = await this.sessions.updateMergeProposal(id, req.user.orgId, {
      status: 'approved',
      reviewer_notes: dto.reviewer_notes,
    });
    return updated;
  }

  @Post('merge-proposals/:id/reject')
  @HttpCode(HttpStatus.ACCEPTED)
  async rejectMerge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const updated = await this.sessions.updateMergeProposal(id, req.user.orgId, {
      status: 'rejected',
      reviewer_notes: dto.reviewer_notes,
    });
    return updated;
  }

  // ── Orchestrator manual tick (debug/resume) ────────────────────────────────

  @Post('sessions/:id/tick')
  @HttpCode(HttpStatus.ACCEPTED)
  async manualTick(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.orchestrator.tick(id, req.user.orgId);
  }
}
