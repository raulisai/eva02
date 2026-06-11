import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventsModule } from '../events/events.module';
import { TasksModule } from '../tasks/tasks.module';
import { ScheduledJobsRepository } from './scheduled-jobs.repository';
import { ScheduledJobsService } from './scheduled-jobs.service';
import { JobSchedulerService } from './job-scheduler.service';
import { JobsController } from './jobs.controller';

@Module({
  imports: [DatabaseModule, EventsModule, TasksModule],
  controllers: [JobsController],
  providers: [ScheduledJobsRepository, ScheduledJobsService, JobSchedulerService],
  exports: [ScheduledJobsService],
})
export class JobsModule {}
