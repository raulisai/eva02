import {
  Body, Controller, Get, HttpCode, HttpStatus, Param,
  ParseUUIDPipe, Post, Req, Query,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { DevSessionService } from './dev-session.service';
import { DevOrchestratorService } from './dev-orchestrator.service';
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
  cancelSession(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.sessions.cancel(id, req.user.orgId);
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
    return this.sessions.getAgentDetail(id, orgId, role);
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
