import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

export type EvaEventType =
  | 'task.created'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'approval.requested'
  | 'approval.resolved'
  | 'dev.task.created'
  | 'dev.task.updated'
  | 'dev.task.completed'
  | 'dev.task.failed'
  | 'browser.screenshot.created'
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

  onModuleInit() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.publisher = new Redis(url, { lazyConnect: true });
    this.subscriber = new Redis(url, { lazyConnect: true });

    this.publisher.on('error', (err) => this.logger.error('Redis publisher error', err));
    this.subscriber.on('error', (err) => this.logger.error('Redis subscriber error', err));
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
      return id;
    } catch (err) {
      this.logger.error(`Failed to publish ${event.type}`, err);
      return null;
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

    this.consuming = true;
    this.consumeLoop(consumerName).catch((err) =>
      this.logger.error('Consume loop crashed', err),
    );
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
