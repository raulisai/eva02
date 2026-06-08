import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ClaudeCodeSession, ClaudeCodeSessionStatus, DevTask, DevTaskStatus, Project, RoadmapItem, RunRecord } from './dev-control.types';
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateDevTaskDto } from './dto/create-dev-task.dto';

@Injectable()
export class DevControlRepository {
  private readonly logger = new Logger(DevControlRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async createProject(dto: CreateProjectDto, orgId: string): Promise<Project> {
    const { data, error } = await this.db.admin
      .from('projects')
      .insert({
        org_id: orgId,
        name: dto.name,
        repo_path: dto.repo_path ?? null,
        node_id: dto.node_id ?? null,
        stack: dto.stack ?? [],
        main_branch: dto.main_branch ?? 'main',
        dev_command: dto.dev_command ?? null,
        test_command: dto.test_command ?? null,
        build_command: dto.build_command ?? null,
        metadata: dto.metadata ?? {},
      })
      .select()
      .single();

    if (error) this.fail('projects.create', error);
    return data as Project;
  }

  async findProject(projectId: string, orgId: string): Promise<Project | null> {
    const { data, error } = await this.db.admin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('projects.find', error);
    return data as Project | null;
  }

  async findProjectOrThrow(projectId: string, orgId: string): Promise<Project> {
    const project = await this.findProject(projectId, orgId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  async createDevTask(dto: CreateDevTaskDto, orgId: string, userId: string): Promise<DevTask> {
    await this.findProjectOrThrow(dto.project_id, orgId);
    const { data, error } = await this.db.admin
      .from('dev_tasks')
      .insert({
        org_id: orgId,
        project_id: dto.project_id,
        title: dto.title,
        prompt: dto.prompt ?? null,
        metadata: dto.metadata ?? {},
        created_by: userId,
      })
      .select()
      .single();

    if (error) this.fail('dev_tasks.create', error);
    return data as DevTask;
  }

  async findDevTask(devTaskId: string, orgId: string): Promise<DevTask | null> {
    const { data, error } = await this.db.admin
      .from('dev_tasks')
      .select('*')
      .eq('id', devTaskId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('dev_tasks.find', error);
    return data as DevTask | null;
  }

  async findDevTaskOrThrow(devTaskId: string, orgId: string): Promise<DevTask> {
    const task = await this.findDevTask(devTaskId, orgId);
    if (!task) throw new NotFoundException(`Dev task ${devTaskId} not found`);
    return task;
  }

  async updateDevTaskStatus(devTaskId: string, orgId: string, status: DevTaskStatus, extras: Partial<Pick<DevTask, 'diff_summary'>> = {}): Promise<DevTask> {
    const { data, error } = await this.db.admin
      .from('dev_tasks')
      .update({ status, ...extras })
      .eq('id', devTaskId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) this.fail('dev_tasks.updateStatus', error);
    return data as DevTask;
  }

  async createClaudeSession(input: {
    orgId: string;
    projectId: string;
    devTaskId?: string;
    nodeId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ClaudeCodeSession> {
    await this.findProjectOrThrow(input.projectId, input.orgId);
    if (input.devTaskId) await this.findDevTaskOrThrow(input.devTaskId, input.orgId);

    const { data, error } = await this.db.admin
      .from('claude_code_sessions')
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        dev_task_id: input.devTaskId ?? null,
        node_id: input.nodeId ?? null,
        status: 'starting',
        metadata: input.metadata ?? {},
      })
      .select()
      .single();

    if (error) this.fail('cc_sessions.create', error);
    return data as ClaudeCodeSession;
  }

  async findClaudeSession(sessionId: string, orgId: string): Promise<ClaudeCodeSession | null> {
    const { data, error } = await this.db.admin
      .from('claude_code_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('cc_sessions.find', error);
    return data as ClaudeCodeSession | null;
  }

  async findClaudeSessionOrThrow(sessionId: string, orgId: string): Promise<ClaudeCodeSession> {
    const session = await this.findClaudeSession(sessionId, orgId);
    if (!session) throw new NotFoundException(`Claude Code session ${sessionId} not found`);
    return session;
  }

  async updateClaudeSession(sessionId: string, orgId: string, patch: Partial<Pick<ClaudeCodeSession, 'status' | 'output' | 'metadata'>>): Promise<ClaudeCodeSession> {
    const { data, error } = await this.db.admin
      .from('claude_code_sessions')
      .update(patch)
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) this.fail('cc_sessions.update', error);
    return data as ClaudeCodeSession;
  }

  async insertRun(table: 'build_runs' | 'test_runs', input: {
    orgId: string;
    projectId: string;
    devTaskId?: string;
    command?: string;
    ok: boolean;
    output: string;
  }): Promise<RunRecord> {
    await this.findProjectOrThrow(input.projectId, input.orgId);
    if (input.devTaskId) await this.findDevTaskOrThrow(input.devTaskId, input.orgId);

    const { data, error } = await this.db.admin
      .from(table)
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        dev_task_id: input.devTaskId ?? null,
        command: input.command ?? null,
        ok: input.ok,
        output: input.output,
      })
      .select()
      .single();

    if (error) this.fail(`${table}.insert`, error);
    return data as RunRecord;
  }

  async createRoadmapItem(input: {
    orgId: string;
    projectId: string;
    title: string;
    priority: number;
    metadata?: Record<string, unknown>;
  }): Promise<RoadmapItem> {
    await this.findProjectOrThrow(input.projectId, input.orgId);
    const { data, error } = await this.db.admin
      .from('roadmap_items')
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        title: input.title,
        priority: input.priority,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();

    if (error) this.fail('roadmap_items.create', error);
    return data as RoadmapItem;
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Failed to write ${scope}`);
  }
}
