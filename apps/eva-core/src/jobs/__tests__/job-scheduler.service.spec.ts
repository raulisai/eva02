import { EventBusService } from '../../events/event-bus.service';
import { TasksService } from '../../tasks/tasks.service';
import { JobSchedulerService } from '../job-scheduler.service';
import { ScheduledJobsRepository } from '../scheduled-jobs.repository';
import { ScheduledJob } from '../scheduled-job.types';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const dueJob: ScheduledJob = {
  id: 'job-1',
  org_id: ORG,
  name: 'Daily brief',
  description: null,
  job_type: 'briefing',
  schedule_type: 'cron',
  cron_expr: '0 7 * * *',
  run_at: null,
  interval_minutes: null,
  timezone: 'UTC',
  task_input: 'summarize the day',
  status: 'active',
  last_run_at: null,
  next_run_at: '2024-01-01T07:00:00.000Z',
  run_count: 0,
  payload: {},
  created_by: USER,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

describe('JobSchedulerService', () => {
  it('emits scheduler debug logs when a background job fires', async () => {
    const repo = {
      findDue: jest.fn().mockResolvedValue([dueJob]),
      recordRun: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScheduledJobsRepository>;
    const events = {
      publish: jest.fn().mockResolvedValue('0-1'),
    } as unknown as jest.Mocked<EventBusService>;
    const tasks = {
      createTask: jest.fn().mockResolvedValue({ id: TASK }),
    } as unknown as jest.Mocked<TasksService>;

    const service = new JobSchedulerService(repo, events, tasks);

    await service.tick();

    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        scheduled_job_id: dueJob.id,
        job_type: dueJob.job_type,
        job_name: dueJob.name,
        scheduled_job_payload: dueJob.payload,
      }),
    }), USER, ORG);

    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.log',
      orgId: ORG,
      payload: expect.objectContaining({
        scope: 'scheduler',
        module: 'JobSchedulerService',
        action: 'scheduled_job.fire.start',
        scheduledJobId: dueJob.id,
      }),
    }));
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.log',
      orgId: ORG,
      taskId: TASK,
      payload: expect.objectContaining({
        scope: 'scheduler',
        module: 'JobSchedulerService',
        action: 'scheduled_job.fire.done',
        scheduledJobId: dueJob.id,
      }),
    }));
  });
});
