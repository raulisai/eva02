import { Injectable } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { TasksService } from '../tasks/tasks.service';
import { legacyDeviceLocation, normalizeRequestLocation } from '../common/request-context';

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
    const metadata = this.normalizeFallbackMetadata(input.metadata, input.deviceId, input.requestType);
    const task = await this.tasks.createTask({
      title: `Wear fallback: ${input.requestType}`,
      description: input.text,
      metadata: {
        source: 'wear_fast_path',
        device_id: input.deviceId,
        request_type: input.requestType,
        fallback_reason: input.reason,
        ...metadata,
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

  private normalizeFallbackMetadata(
    metadata: Record<string, unknown> | undefined,
    deviceId: string,
    requestType: string,
  ): Record<string, unknown> {
    const next = { ...(metadata ?? {}) };
    const requestContext = (
      next.request_context &&
      typeof next.request_context === 'object' &&
      !Array.isArray(next.request_context)
    )
      ? { ...(next.request_context as Record<string, unknown>) }
      : {};
    const location = normalizeRequestLocation(next, 'wear_os');
    requestContext['source'] = 'wear_os';
    requestContext['device_id'] = deviceId;
    requestContext['request_type'] = requestType;
    if (location) {
      requestContext['location'] = location;
      next.device_location = legacyDeviceLocation(location);
    }
    next.request_context = requestContext;
    return next;
  }
}
