import { Module } from '@nestjs/common';
import { BehaviorPatternService } from './behavior-pattern.service';
import { CapabilityGateModule } from '../capability-gate/capability-gate.module';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';
import { MemoryModule } from '../memory/memory.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { TasksModule } from '../tasks/tasks.module';
import { ToolRouterModule } from '../tool-router/tool-router.module';
import { AgentRunnerService } from './agent-runner.service';
import { ConversationDigesterService } from './conversation-digester.service';
import { GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDriveService } from './google-drive.service';
import { MediaService } from './media.service';
import { MemoryRecallService } from './memory-recall.service';
import { ResearchToolsService } from './research-tools.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { SoulContextService } from './soul-context.service';

@Module({
  imports: [
    DatabaseModule, EventsModule, IntegrationsModule, CapabilityGateModule,
    TasksModule, IntentRouterModule, ModelRouterModule, ToolRouterModule,
    MemoryModule,
  ],
  providers: [
    AgentRunnerService,
    MediaService,
    ResearchToolsService,
    ScriptForgeService,
    SoulContextService,
    GmailService,
    GoogleCalendarService,
    GoogleDriveService,
    ScheduleService,
    BehaviorPatternService,
    MemoryRecallService,
    ConversationDigesterService,
  ],
  exports: [
    AgentRunnerService,
    MediaService,
    SoulContextService,
    GmailService,
    GoogleCalendarService,
    GoogleDriveService,
    ScheduleService,
    BehaviorPatternService,
  ],
})
export class AgentModule {}
