import { Module } from '@nestjs/common';
import { IntentRouterController } from './intent-router.controller';
import { IntentRouterService } from './intent-router.service';
import { IntentRouterRepository } from './intent-router.repository';
import { ModelRouterModule } from '../model-router/model-router.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports:     [DatabaseModule, ModelRouterModule],
  controllers: [IntentRouterController],
  providers:   [IntentRouterService, IntentRouterRepository],
  exports:     [IntentRouterService],
})
export class IntentRouterModule {}
