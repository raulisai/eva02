import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { TaskEngineService } from './task-engine.service';
import { GatewayModule } from '../gateway/gateway.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';
import { PlannerModule } from '../planner/planner.module';
import { ModelRouterModule } from '../model-router/model-router.module';

@Module({
  imports: [GatewayModule, IntentRouterModule, PlannerModule, ModelRouterModule],
  controllers: [TasksController],
  providers: [TasksService, TasksRepository, TaskEngineService],
  exports: [TasksService],
})
export class TasksModule {}
