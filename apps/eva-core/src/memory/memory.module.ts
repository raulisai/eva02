import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { MemoryAgentService } from './memory-agent.service';
import { MemoriesRepository } from './memories.repository';
import { ModelRouterService } from './model-router/model-router.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [MemoryController],
  providers: [MemoryService, MemoryAgentService, MemoriesRepository, ModelRouterService],
  exports: [MemoryService, MemoryAgentService],
})
export class MemoryModule {}
