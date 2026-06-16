import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { AgentModule } from '../agent/agent.module';
import { TasksModule } from '../tasks/tasks.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { DevSessionService } from './dev-session.service';
import { DevProjectManagerService } from './dev-project-manager.service';
import { DevArchitectService } from './dev-architect.service';
import { DevOrchestratorService } from './dev-orchestrator.service';
import { ClaudeCodeRunnerService } from './claude-code-runner.service';
import { DevStudioController } from './dev-studio.controller';

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    ModelRouterModule,
    AgentModule,
    TasksModule,
    ApprovalsModule,
    IntegrationsModule,
  ],
  controllers: [DevStudioController],
  providers: [
    DevSessionService,
    DevProjectManagerService,
    DevArchitectService,
    DevOrchestratorService,
    ClaudeCodeRunnerService,
  ],
  exports: [DevSessionService, DevOrchestratorService, ClaudeCodeRunnerService],
})
export class DevStudioModule {}
