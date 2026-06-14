import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DatabaseService } from '../database/database.service';

export type EvaEventType =
  | 'task.created'
  | 'task.update'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.waiting_approval'
  | 'task.waiting_input'
  | 'task.say'      // immediate acknowledgment EVA speaks while working
  | 'task.log'      // transparent step-by-step action log
  | 'task.step'     // structured tool step selected by the agent loop
  | 'task.result'   // final answer text
  | 'task.media'    // media attachment uploaded to storage (image/audio)
  | 'task.form_request'    // server-driven form request for missing information
  | 'task.setup_required' // capability gate: integration not configured, setup instructions sent
  | 'task.steer'          // user injected a live steer message into a running task
  | 'task.steer_applied'  // the loop drained and applied a steer message mid-run
  | 'approval.requested'
  | 'approval.resolved'
  | 'dev.task.created'
  | 'dev.task.updated'
  | 'dev.task.completed'
  | 'dev.task.failed'
  | 'browser.screenshot.created'
  | 'communication.message.received'
  | 'communication.message.sent'
  | 'communication.send.failed'
  | 'agent.feedback.inferred'
  | 'wear.fast_path.started'
  | 'wear.fast_path.completed'
  | 'wear.fast_path.fallback'
  | 'wear.token.created'
  | 'wear.token.expired';

export interface EvaEvent<T = Record<string, unknown>> {
  id?: string;        // Stream entry ID, set on consume
  type: EvaEventType;
  orgId: string;
  taskId?: string;
  payload: T;
  ts: number;
}

export const EVA_STREAM = 'eva:events';
export const EVA_CONSUMER_GROUP = 'eva-core';

@Injectable()
export class EventBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventBusService.name);
  private publisher!: Redis;
  private subscriber!: Redis;
  private readonly handlers = new Map<EvaEventType, Array<(e: EvaEvent) => Promise<void>>>();
  private consuming = false;

  constructor(
    private readonly db: DatabaseService,
  ) {}

  async onModuleInit() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.publisher = new Redis(url, { lazyConnect: true });
    this.subscriber = new Redis(url, { lazyConnect: true });

    this.publisher.on('error', (err) => this.logger.error('Redis publisher error', err));
    this.subscriber.on('error', (err) => this.logger.error('Redis subscriber error', err));

    try {
      await this.publisher.connect();
      await this.subscriber.connect();
      this.logger.log(`Redis connected: ${url}`);
    } catch (err) {
      this.logger.error(`Redis connection FAILED (${url}) — app will not serve correctly`, err);
      throw err;
    }
  }

  async onModuleDestroy() {
    this.consuming = false;
    await this.publisher.quit();
    await this.subscriber.quit();
  }

  /** Publish an event to the stream. Fire-and-forget safe — logs on error. */
  async publish(event: Omit<EvaEvent, 'ts' | 'id'>): Promise<string | null> {
    try {
      const ts = Date.now();
      const id = await this.publisher.xadd(
        EVA_STREAM,
        '*',
        'type', event.type,
        'orgId', event.orgId,
        'taskId', event.taskId ?? '',
        'payload', JSON.stringify(event.payload),
        'ts', String(ts),
      );
      this.logger.debug(`Published ${event.type} [${id}]`);

      // Persist task events to the task_events database table
      if (event.taskId && event.orgId) {
        await this.db.admin
          .from('task_events')
          .insert({
            org_id: event.orgId,
            task_id: event.taskId,
            event_type: event.type,
            payload: event.payload ?? {},
          })
          .then(({ error }) => {
            if (error) {
              this.logger.error(`Failed to persist task event ${event.type} to DB`, error);
            }
          });
      }

      return id;
    } catch (err) {
      this.logger.error(`Failed to publish ${event.type}`, err);
      return null;
    }
  }

  /**
   * Steer queue — transient, per-task Redis list of live user messages injected
   * into a RUNNING task. Drained by the agent loop at the start of each step so
   * the user can redirect a long task without cancelling and restarting.
   *
   * Ephemeral by design: a 6h TTL covers the longest run; no DB persistence
   * (steer is a signal, not durable state). No Redis → no-op / empty.
   */
  private steerKey(taskId: string): string {
    return `eva:steer:${taskId}`;
  }

  async pushSteer(taskId: string, message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (!this.publisher) {
      this.logger.warn('pushSteer skipped — Redis unavailable');
      return;
    }
    try {
      const key = this.steerKey(taskId);
      await this.publisher.lpush(key, trimmed);
      await this.publisher.expire(key, 6 * 60 * 60);
    } catch (err) {
      this.logger.error(`Failed to push steer for task ${taskId}`, err);
    }
  }

  /** Atomically read + clear the steer queue, returning messages in chronological order. */
  async drainSteer(taskId: string): Promise<string[]> {
    if (!this.publisher) return [];
    try {
      const key = this.steerKey(taskId);
      const [[, range]] = (await this.publisher
        .multi()
        .lrange(key, 0, -1)
        .del(key)
        .exec()) as Array<[Error | null, unknown]>;
      const messages = (range as string[] | null) ?? [];
      // LPUSH prepends, so the list is newest-first — reverse for chronological order.
      return messages.reverse();
    } catch (err) {
      this.logger.error(`Failed to drain steer for task ${taskId}`, err);
      return [];
    }
  }

  /** Register a handler for a specific event type. */
  on<T = Record<string, unknown>>(
    type: EvaEventType,
    handler: (event: EvaEvent<T>) => Promise<void>,
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (e: EvaEvent) => Promise<void>);
    this.handlers.set(type, list);
  }

  /** Start consuming from the stream (call once on bootstrap). */
  async startConsuming(consumerName = 'core-1'): Promise<void> {
    // Ensure consumer group exists
    try {
      await this.subscriber.xgroup('CREATE', EVA_STREAM, EVA_CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err: any) {
      if (!err.message?.includes('BUSYGROUP')) throw err;
    }

    // Reclaim orphaned messages from previous consumer instances that died
    // before ACKing (e.g. process crash, restart). Idle threshold: 30 s.
    await this.recoverOrphanedMessages(consumerName);

    this.consuming = true;
    this.consumeLoop(consumerName).catch((err) =>
      this.logger.error('Consume loop crashed', err),
    );
  }

  /**
   * Claims messages that have been stuck in the PEL (Pending Entry List) for
   * longer than ORPHAN_IDLE_MS — meaning the consumer that received them is
   * dead and will never ACK them. Re-dispatches each one under the new
   * consumer name so they are processed exactly once on restart.
   */
  private async recoverOrphanedMessages(consumerName: string): Promise<void> {
    const ORPHAN_IDLE_MS = 30_000;
    try {
      // XPENDING with range returns: [id, consumer, idle_ms, delivery_count]
      const pending = await this.subscriber.xpending(
        EVA_STREAM, EVA_CONSUMER_GROUP, '-', '+', 100,
      ) as Array<[string, string, number, number]>;

      if (!pending?.length) return;

      const orphans = pending.filter(([, , idle]) => idle >= ORPHAN_IDLE_MS);
      if (!orphans.length) return;

      this.logger.warn(`Recovering ${orphans.length} orphaned PEL message(s) idle ≥ ${ORPHAN_IDLE_MS}ms`);

      for (const [entryId] of orphans) {
        try {
          // XCLAIM transfers ownership to this consumer
          const claimed = await this.subscriber.xclaim(
            EVA_STREAM, EVA_CONSUMER_GROUP, consumerName,
            ORPHAN_IDLE_MS, entryId,
          ) as Array<[string, string[]]>;

          for (const [id, fields] of claimed) {
            const event = this.parseEntry(id, fields);
            await this.dispatch(event);
            await this.subscriber.xack(EVA_STREAM, EVA_CONSUMER_GROUP, id);
          }
        } catch (err) {
          this.logger.error(`Failed to recover orphaned message ${entryId}`, err);
        }
      }
    } catch (err) {
      // Best-effort: a fresh stream with no PEL may return an error.
      this.logger.debug(`PEL recovery skipped: ${(err as Error).message}`);
    }
  }

  private async consumeLoop(consumerName: string): Promise<void> {
    while (this.consuming) {
      try {
        const results = await this.subscriber.xreadgroup(
          'GROUP', EVA_CONSUMER_GROUP, consumerName,
          'COUNT', '10',
          'BLOCK', '2000',
          'STREAMS', EVA_STREAM, '>',
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, entries] of results) {
          for (const [entryId, fields] of entries) {
            const event = this.parseEntry(entryId, fields);
            await this.dispatch(event);
            await this.subscriber.xack(EVA_STREAM, EVA_CONSUMER_GROUP, entryId);
          }
        }
      } catch (err: any) {
        if (err.message?.includes('ERR') || err.message?.includes('NOGROUP')) {
          this.logger.error('Stream error', err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  private parseEntry(id: string, fields: string[]): EvaEvent {
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      map[fields[i]] = fields[i + 1];
    }
    return {
      id,
      type: map['type'] as EvaEventType,
      orgId: map['orgId'],
      taskId: map['taskId'] || undefined,
      payload: JSON.parse(map['payload'] ?? '{}'),
      ts: parseInt(map['ts'] ?? '0', 10),
    };
  }

  private async dispatch(event: EvaEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    await Promise.all(handlers.map((h) => h(event).catch((e) =>
      this.logger.error(`Handler error for ${event.type}`, e),
    )));
  }
}
