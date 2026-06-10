import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { TasksModule } from '../tasks/tasks.module';
import { ToolRouterModule } from '../tool-router/tool-router.module';
import { AgentRunnerService } from './agent-runner.service';

@Module({
  imports: [EventsModule, TasksModule, IntentRouterModule, ModelRouterModule, ToolRouterModule],
  providers: [AgentRunnerService],
  exports: [AgentRunnerService],
})
export class AgentModule {}
