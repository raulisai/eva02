import { Module } from '@nestjs/common';
import { PlannerController } from './planner.controller';
import { PlannerService } from './planner.service';
import { ModelRouterModule } from '../model-router/model-router.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';

@Module({
  imports:     [ModelRouterModule, IntentRouterModule],
  controllers: [PlannerController],
  providers:   [PlannerService],
  exports:     [PlannerService],
})
export class PlannerModule {}
