import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { BuildTestRunnerService } from './build-test-runner.service';
import { ClaudeCodeControllerService } from './claude-code-controller.service';
import { CreateDevTaskDto } from './dto/create-dev-task.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { RunCommandDto } from './dto/run-command.dto';
import { SendClaudeTaskDto, StartClaudeSessionDto } from './dto/claude-code.dto';
import { TransitionDevTaskDto } from './dto/transition-dev-task.dto';
import { DevTaskQueueService } from './dev-task-queue.service';
import { ProgressReporterService } from './progress-reporter.service';
import { ProjectRegistryService } from './project-registry.service';
import { RepoManagerService } from './repo-manager.service';
import { RoadmapAgentService } from './roadmap-agent.service';

@Controller('dev-control')
export class DevControlController {
  constructor(
    private readonly projects: ProjectRegistryService,
    private readonly tasks: DevTaskQueueService,
    private readonly repoManager: RepoManagerService,
    private readonly claude: ClaudeCodeControllerService,
    private readonly runner: BuildTestRunnerService,
    private readonly progress: ProgressReporterService,
    private readonly roadmap: RoadmapAgentService,
  ) {}

  @Post('projects')
  @HttpCode(HttpStatus.CREATED)
  createProject(@Body() dto: CreateProjectDto, @Req() req: AuthenticatedRequest) {
    return this.projects.create(dto, req.user.orgId);
  }

  @Get('projects/:id')
  getProject(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.projects.get(id, req.user.orgId);
  }

  @Get('projects/:id/repo/status')
  repoStatus(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.repoManager.status(id, req.user.orgId);
  }

  @Get('projects/:id/repo/diff')
  repoDiff(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.repoManager.diff(id, req.user.orgId);
  }

  @Get('projects/:id/repo/log')
  repoLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.repoManager.log(id, req.user.orgId, limit ? Number(limit) : undefined);
  }

  @Post('dev-tasks')
  @HttpCode(HttpStatus.CREATED)
  createDevTask(@Body() dto: CreateDevTaskDto, @Req() req: AuthenticatedRequest) {
    return this.tasks.create(dto, req.user.orgId, req.user.userId);
  }

  @Patch('dev-tasks/:id/status')
  transitionDevTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionDevTaskDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tasks.transition(id, req.user.orgId, dto.status);
  }

  @Get('dev-tasks/:id/progress')
  reportProgress(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.progress.reportDevTask(id, req.user.orgId);
  }

  @Post('claude-code/sessions')
  @HttpCode(HttpStatus.CREATED)
  startClaudeSession(@Body() dto: StartClaudeSessionDto, @Req() req: AuthenticatedRequest) {
    return this.claude.startSession(dto, req.user.orgId);
  }

  @Post('claude-code/sessions/:id/tasks')
  sendClaudeTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendClaudeTaskDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.claude.sendTask(id, req.user.orgId, dto);
  }

  @Get('claude-code/sessions/:id/output')
  readClaudeOutput(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.claude.readOutput(id, req.user.orgId);
  }

  @Get('claude-code/sessions/:id/status')
  getClaudeStatus(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.claude.getStatus(id, req.user.orgId);
  }

  @Post('runs/build')
  runBuild(@Body() dto: RunCommandDto, @Req() req: AuthenticatedRequest) {
    return this.runner.runBuild(dto, req.user.orgId);
  }

  @Post('runs/test')
  runTest(@Body() dto: RunCommandDto, @Req() req: AuthenticatedRequest) {
    return this.runner.runTest(dto, req.user.orgId);
  }

  @Post('roadmap/:projectId/suggest-next')
  suggestNext(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: AuthenticatedRequest) {
    return this.roadmap.suggestNext(projectId, req.user.orgId);
  }
}
