import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { TasksRepository } from './tasks.repository';
import { EventBusService } from '../events/event-bus.service';
import { Task, TaskStatus, isValidTransition } from './task.types';
import { CreateTaskDto } from './dto/create-task.dto';

@Injectable()
export class TasksService {
  constructor(
    private readonly repo: TasksRepository,
    private readonly events: EventBusService,
  ) {}

  async createTask(dto: CreateTaskDto, userId: string, orgId: string): Promise<Task> {
    const task = await this.repo.create(dto, userId, orgId);

    await this.events.publish({
      type: 'task.created',
      orgId,
      taskId: task.id,
      payload: { taskId: task.id, title: task.title },
    });

    return task;
  }

  async getTask(taskId: string, orgId: string): Promise<Task> {
    return this.repo.findByIdOrThrow(taskId, orgId);
  }

  /**
   * Inject a live steer message into a running task. The agent loop drains it at
   * the start of its next step (mid-loop intervention — no restart). Only valid
   * while the task is actively executing.
   */
  async steer(taskId: string, orgId: string, message: string): Promise<{ accepted: true }> {
    const task = await this.repo.findByIdOrThrow(taskId, orgId);

    if (task.status !== 'running' && task.status !== 'planning') {
      throw new ConflictException(
        `Cannot steer a task in '${task.status}' — only running/planning tasks accept live steering`,
      );
    }

    await this.events.pushSteer(taskId, message);
    await this.events.publish({
      type: 'task.steer',
      orgId,
      taskId,
      payload: { taskId, message },
    });

    return { accepted: true };
  }

  async findStuck(opts: { pendingOlderThanMs: number; runningOlderThanMs: number }): Promise<Task[]> {
    const pendingSince = new Date(Date.now() - opts.pendingOlderThanMs).toISOString();
    const runningSince = new Date(Date.now() - opts.runningOlderThanMs).toISOString();
    return this.repo.findStuck(pendingSince, runningSince);
  }

  async transition(
    taskId: string,
    orgId: string,
    nextStatus: TaskStatus,
    outcome: Partial<Pick<Task, 'result' | 'error'>> = {},
  ): Promise<Task> {
    const task = await this.repo.findByIdOrThrow(taskId, orgId);

    if (!isValidTransition(task.status, nextStatus)) {
      throw new BadRequestException(
        `Cannot transition task from '${task.status}' to '${nextStatus}'`,
      );
    }

    const now = new Date().toISOString();
    const extras: Parameters<typeof this.repo.updateStatus>[3] = { ...outcome };

    if (nextStatus === 'running' && !task.started_at) extras.started_at = now;
    if (nextStatus === 'completed' || nextStatus === 'failed') extras.completed_at = now;
    if (nextStatus === 'pending') {
      extras.started_at = null;
      extras.completed_at = null;
      extras.error = null;
      extras.result = null;
    }

    const updated = await this.repo.updateStatus(taskId, orgId, nextStatus, extras);

    if (nextStatus === 'pending') {
      await this.events.publish({
        type: 'task.created',
        orgId,
        taskId,
        payload: { taskId, title: updated.title },
      });
    }

    const eventTypeMap: Partial<Record<TaskStatus, 'task.started' | 'task.completed' | 'task.failed' | 'task.cancelled' | 'task.waiting_approval' | 'task.waiting_input'>> = {
      running:   'task.started',
      completed: 'task.completed',
      failed:    'task.failed',
      cancelled: 'task.cancelled',
      waiting_for_approval: 'task.waiting_approval',
      waiting_for_input: 'task.waiting_input',
    };

    const eventType = eventTypeMap[nextStatus];
    if (eventType) {
      await this.events.publish({
        type: eventType,
        orgId,
        taskId,
        payload: { taskId, status: nextStatus, ...(outcome.error ? { error: outcome.error } : {}) },
      });
    }

    return updated;
  }
}
