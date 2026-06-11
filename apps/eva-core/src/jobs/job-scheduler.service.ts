import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ScheduledJobsRepository } from './scheduled-jobs.repository';
import { EventBusService } from '../events/event-bus.service';
import { TasksService } from '../tasks/tasks.service';
import { ScheduledJob } from './scheduled-job.types';
import { computeNextRunAt } from './cron-utils';
import { CreateTaskDto } from '../tasks/dto/create-task.dto';

const TICK_INTERVAL_MS = 60_000; // 1 minute

@Injectable()
export class JobSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: ScheduledJobsRepository,
    private readonly events: EventBusService,
    private readonly tasks: TasksService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error('Scheduler tick error', err));
    }, TICK_INTERVAL_MS);
    this.logger.log(`Job scheduler started — polling every ${TICK_INTERVAL_MS / 1000}s`);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Called by tests to drive a manual tick without the timer. */
  async tick(): Promise<void> {
    let due: ScheduledJob[];
    try {
      due = await this.repo.findDue();
    } catch (err) {
      this.logger.error('findDue failed', err);
      return;
    }

    if (due.length === 0) return;
    this.logger.log(`Scheduler: ${due.length} due job(s)`);

    await Promise.allSettled(due.map(job => this.fire(job)));
  }

  private async fire(job: ScheduledJob): Promise<void> {
    try {
      // Create a system task on behalf of the org (created_by is the owner user)
      const dto: CreateTaskDto = {
        title: `[⏰ Job] ${job.name}`,
        description: job.task_input,
        metadata: { scheduled_job_id: job.id, job_type: job.job_type, job_name: job.name },
      };
      const task = await this.tasks.createTask(dto, job.created_by, job.org_id);

      // Publish so the agent runner picks it up
      await this.events.publish({
        type: 'task.created',
        orgId: job.org_id,
        taskId: task.id,
        payload: { scheduled_job_id: job.id },
      });

      // Advance the job's run record
      const nextRunAt = computeNextRunAt(job);
      await this.repo.recordRun(job.id, job.org_id, nextRunAt);

      this.logger.log(`Fired job "${job.name}" (${job.id}) → task ${task.id}. next=${nextRunAt ?? 'none (completed)'}`);
    } catch (err) {
      this.logger.error(`Failed to fire job "${job.name}" (${job.id})`, err);
    }
  }
}
