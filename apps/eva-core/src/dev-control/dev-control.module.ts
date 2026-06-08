import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { GatewayModule } from '../gateway/gateway.module';
import { BuildTestRunnerService } from './build-test-runner.service';
import { ClaudeCodeControllerService } from './claude-code-controller.service';
import { DevControlController } from './dev-control.controller';
import { DevControlRepository } from './dev-control.repository';
import { DevTaskQueueService } from './dev-task-queue.service';
import { ProgressReporterService } from './progress-reporter.service';
import { ProjectRegistryService } from './project-registry.service';
import { RepoManagerService } from './repo-manager.service';
import { RoadmapAgentService } from './roadmap-agent.service';

@Module({
  imports: [DatabaseModule, EventsModule, GatewayModule],
  controllers: [DevControlController],
  providers: [
    DevControlRepository,
    ProjectRegistryService,
    DevTaskQueueService,
    RepoManagerService,
    ClaudeCodeControllerService,
    BuildTestRunnerService,
    ProgressReporterService,
    RoadmapAgentService,
  ],
  exports: [
    ProjectRegistryService,
    DevTaskQueueService,
    ClaudeCodeControllerService,
    BuildTestRunnerService,
    ProgressReporterService,
    RoadmapAgentService,
  ],
})
export class DevControlModule {}
