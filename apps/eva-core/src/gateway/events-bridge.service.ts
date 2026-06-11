import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EvaEventType, EventBusService } from '../events/event-bus.service';
import { AppGateway } from './app.gateway';

/** Every event type that should reach dashboard/watch clients in realtime. */
const BROADCAST_EVENTS: EvaEventType[] = [
  'task.created',
  'task.update',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.waiting_approval',
  'task.say',
  'task.log',
  'task.result',
  'task.media',
  'task.form_request',
  'task.setup_required',
  'approval.requested',
  'approval.resolved',
  'dev.task.created',
  'dev.task.updated',
  'dev.task.completed',
  'dev.task.failed',
  'browser.screenshot.created',
  'communication.message.received',
  'communication.message.sent',
  'communication.send.failed',
  'wear.fast_path.started',
  'wear.fast_path.completed',
  'wear.fast_path.fallback',
  'wear.token.created',
  'wear.token.expired',
];

/**
 * Bridges the Redis event stream to the Socket.io gateway. Without this the
 * dashboard never receives live events — it is the single consumer starter.
 */
@Injectable()
export class EventsBridgeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventsBridgeService.name);

  constructor(
    private readonly events: EventBusService,
    private readonly gateway: AppGateway,
  ) {}

  async onApplicationBootstrap() {
    // Test environments stub the bus without consumer support — skip quietly.
    if (typeof this.events.on !== 'function' || typeof this.events.startConsuming !== 'function') {
      this.logger.warn('Event bus has no consumer support (test stub?) — bridge disabled');
      return;
    }
    BROADCAST_EVENTS.forEach((type) => {
      this.events.on(type, async (event) => {
        this.gateway.emitToOrg(event.orgId, event);
      });
    });

    await this.events.startConsuming(`core-${process.pid}`);
    this.logger.log(`Event bridge live — broadcasting ${BROADCAST_EVENTS.length} event types to /eva`);
  }
}
