import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Task, TaskStatus } from './task.types';
import { CreateTaskDto } from './dto/create-task.dto';

@Injectable()
export class TasksRepository {
  private readonly logger = new Logger(TasksRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async create(dto: CreateTaskDto, userId: string, orgId: string): Promise<Task> {
    const { data, error } = await this.db.admin
      .from('tasks')
      .insert({
        org_id: orgId,
        created_by: userId,
        title: dto.title,
        description: dto.description ?? null,
        metadata: dto.metadata ?? {},
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      this.logger.error('tasks.create', error);
      throw new InternalServerErrorException('Failed to create task');
    }
    return data as Task;
  }

  async findById(taskId: string, orgId: string): Promise<Task | null> {
    const { data, error } = await this.db.admin
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('org_id', orgId)    // ← mandatory org filter
      .maybeSingle();

    if (error) {
      this.logger.error('tasks.findById', error);
      throw new InternalServerErrorException('Failed to fetch task');
    }
    return (data as Task | null);
  }

  async findByIdOrThrow(taskId: string, orgId: string): Promise<Task> {
    const task = await this.findById(taskId, orgId);
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    return task;
  }

  async findStuck(pendingSince: string, runningSince: string): Promise<Task[]> {
    const { data, error } = await this.db.admin
      .from('tasks')
      .select('*')
      .or(
        `and(status.eq.pending,created_at.lt.${pendingSince}),` +
        `and(status.in.(planning,running),created_at.lt.${runningSince})`,
      );
    if (error) {
      this.logger.error('tasks.findStuck', error);
      return [];
    }
    return (data ?? []) as Task[];
  }

  async updateStatus(
    taskId: string,
    orgId: string,
    status: TaskStatus,
    extras: Partial<Pick<Task, 'result' | 'error' | 'started_at' | 'completed_at'>> = {},
  ): Promise<Task> {
    const { data, error } = await this.db.admin
      .from('tasks')
      .update({ status, ...extras })
      .eq('id', taskId)
      .eq('org_id', orgId)    // ← mandatory org filter
      .select()
      .single();

    if (error) {
      this.logger.error('tasks.updateStatus', error);
      throw new InternalServerErrorException('Failed to update task');
    }
    return data as Task;
  }
}
