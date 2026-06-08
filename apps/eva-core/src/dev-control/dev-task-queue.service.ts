import { BadRequestException, Injectable } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { DevControlRepository } from './dev-control.repository';
import { DevTask, DevTaskStatus, isValidDevTaskTransition } from './dev-control.types';
import { CreateDevTaskDto } from './dto/create-dev-task.dto';

@Injectable()
export class DevTaskQueueService {
  constructor(
    private readonly repo: DevControlRepository,
    private readonly events: EventBusService,
  ) {}

  async create(dto: CreateDevTaskDto, orgId: string, userId: string): Promise<DevTask> {
    const task = await this.repo.createDevTask(dto, orgId, userId);
    await this.events.publish({
      type: 'dev.task.created',
      orgId,
      taskId: task.id,
      payload: { devTaskId: task.id, projectId: task.project_id, title: task.title },
    });
    return task;
  }

  async transition(devTaskId: string, orgId: string, nextStatus: DevTaskStatus): Promise<DevTask> {
    const task = await this.repo.findDevTaskOrThrow(devTaskId, orgId);
    if (!isValidDevTaskTransition(task.status, nextStatus)) {
      throw new BadRequestException(`Cannot transition dev task from '${task.status}' to '${nextStatus}'`);
    }

    const updated = await this.repo.updateDevTaskStatus(devTaskId, orgId, nextStatus);
    await this.events.publish({
      type: this.eventFor(nextStatus),
      orgId,
      taskId: devTaskId,
      payload: { devTaskId, projectId: updated.project_id, status: nextStatus },
    });
    return updated;
  }

  private eventFor(status: DevTaskStatus) {
    if (status === 'done') return 'dev.task.completed' as const;
    if (status === 'failed') return 'dev.task.failed' as const;
    if (status === 'waiting_approval') return 'approval.requested' as const;
    return 'dev.task.updated' as const;
  }
}
