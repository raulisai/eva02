import { Module } from '@nestjs/common';
import { BehaviorPatternService } from './behavior-pattern.service';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BrowserModule } from '../browser/browser.module';
import { CapabilityGateModule } from '../capability-gate/capability-gate.module';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { IntentRouterModule } from '../intent-router/intent-router.module';
import { MemoryModule } from '../memory/memory.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { TasksModule } from '../tasks/tasks.module';
import { ToolRouterModule } from '../tool-router/tool-router.module';
import { AgentLoopService } from './agent-loop.service';
import { PipelineRunnerService } from './pipeline-runner.service';
import { AgentFeedbackController } from './agent-feedback.controller';
import { AgentIntelligenceService } from './agent-intelligence.service';
import { AgentMetricsController } from './agent-metrics.controller';
import { AgentRunnerService } from './agent-runner.service';
import { AgentTrajectoryService } from './agent-trajectory.service';
import { ProfileController } from './profile.controller';
import { ProfileFactsService } from './profile-facts.service';
import { SensitivityClassifierService } from './sensitivity-classifier.service';
import { SoulController } from './soul.controller';
import { ConversationDigesterService } from './conversation-digester.service';
import { GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDriveService } from './google-drive.service';
import { MediaService } from './media.service';
import { MemoryRecallService } from './memory-recall.service';
import { ResearchToolsService } from './research-tools.service';
import { SandboxService } from './sandbox.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { SkillLibraryService } from './skill-library.service';
import { SoulContextService } from './soul-context.service';
import { JobsModule } from '../jobs/jobs.module';
import { CommunicationModule } from '../communication/communication.module';

@Module({
  imports: [
    DatabaseModule, EventsModule, IntegrationsModule, CapabilityGateModule,
    TasksModule, IntentRouterModule, ModelRouterModule, ToolRouterModule,
    MemoryModule, BrowserModule, ApprovalsModule, JobsModule, CommunicationModule,
  ],
  providers: [
    AgentLoopService,
    PipelineRunnerService,
    AgentRunnerService,
    AgentTrajectoryService,
    AgentIntelligenceService,
    MediaService,
    ResearchToolsService,
    SandboxService,
    ScriptForgeService,
    SkillLibraryService,
    SoulContextService,
    GmailService,
    GoogleCalendarService,
    GoogleDriveService,
    ScheduleService,
    BehaviorPatternService,
    MemoryRecallService,
    ConversationDigesterService,
    SensitivityClassifierService,
    ProfileFactsService,
  ],
  controllers: [AgentFeedbackController, AgentMetricsController, SoulController, ProfileController],
  exports: [
    AgentRunnerService,
    MediaService,
    SandboxService,
    SoulContextService,
    GmailService,
    GoogleCalendarService,
    GoogleDriveService,
    ScheduleService,
    BehaviorPatternService,
    ProfileFactsService,
  ],
})
export class AgentModule {}
