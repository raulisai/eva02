import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { TasksModule } from '../tasks/tasks.module';
import { CoreFallbackManager } from './core-fallback.manager';
import { FastPathCostGuard } from './fast-path-cost.guard';
import { FastPathPolicyManager } from './fast-path-policy.manager';
import { WearFastPathController } from './wear-fast-path.controller';
import { WearFastPathRepository } from './wear-fast-path.repository';
import { WearFastPathService } from './wear-fast-path.service';
import { WearRealtimeTokenProvider } from './wear-realtime-token.provider';

@Module({
  imports: [DatabaseModule, EventsModule, TasksModule],
  controllers: [WearFastPathController],
  providers: [
    WearFastPathService,
    WearFastPathRepository,
    WearRealtimeTokenProvider,
    FastPathPolicyManager,
    FastPathCostGuard,
    CoreFallbackManager,
  ],
  exports: [WearFastPathService],
})
export class WearFastPathModule {}
