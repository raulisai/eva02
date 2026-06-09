import { Injectable } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { TasksService } from '../tasks/tasks.service';

@Injectable()
export class CoreFallbackManager {
  constructor(
    private readonly tasks: TasksService,
    private readonly events: EventBusService,
  ) {}

  async forward(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    requestType: string;
    text: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }) {
    const task = await this.tasks.createTask({
      title: `Wear fallback: ${input.requestType}`,
      description: input.text,
      metadata: {
        source: 'wear_fast_path',
        device_id: input.deviceId,
        request_type: input.requestType,
        fallback_reason: input.reason,
        ...(input.metadata ?? {}),
      },
    }, input.userId, input.orgId);

    await this.events.publish({
      type: 'wear.fast_path.fallback',
      orgId: input.orgId,
      taskId: task.id,
      payload: {
        taskId: task.id,
        deviceId: input.deviceId,
        requestType: input.requestType,
        reason: input.reason,
      },
    });

    return task;
  }
}
