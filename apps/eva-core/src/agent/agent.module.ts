import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { TasksModule } from '../tasks/tasks.module';
import { ToolRouterModule } from '../tool-router/tool-router.module';
import { AgentRunnerService } from './agent-runner.service';
import { MediaService } from './media.service';
import { ResearchToolsService } from './research-tools.service';
import { ScriptForgeService } from './script-forge.service';
import { SoulContextService } from './soul-context.service';

@Module({
  imports: [
    DatabaseModule, EventsModule, IntegrationsModule,
    TasksModule, IntentRouterModule, ModelRouterModule, ToolRouterModule,
  ],
  providers: [AgentRunnerService, MediaService, ResearchToolsService, ScriptForgeService, SoulContextService],
  exports: [AgentRunnerService, MediaService],
})
export class AgentModule {}
