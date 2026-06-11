import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { MemoryAgentService } from './memory-agent.service';
import { MemoriesRepository } from './memories.repository';
import { ModelRouterModule } from '../model-router/model-router.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule, ModelRouterModule],
  controllers: [MemoryController],
  providers: [MemoryService, MemoryAgentService, MemoriesRepository],
  exports: [MemoryService, MemoryAgentService],
})
export class MemoryModule {}
