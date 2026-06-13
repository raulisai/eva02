import { Test, TestingModule } from '@nestjs/testing';
import {
  AGENT_AUTONOMY_JOB_KEY,
  AGENT_AUTONOMY_TASK_INPUT,
  MANERO_TASK_INPUT,
  ScheduledJobsService,
} from '../scheduled-jobs.service';
import { ScheduledJobsRepository } from '../scheduled-jobs.repository';
import { ScheduledJob } from '../scheduled-job.types';

const mockJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-uuid-1',
  org_id: 'org-1',
  name: 'Mañanero 🌅',
  description: null,
  job_type: 'briefing',
  schedule_type: 'cron',
  cron_expr: '0 7 * * *',
  run_at: null,
  interval_minutes: null,
  timezone: 'America/Mexico_City',
  task_input: MANERO_TASK_INPUT,
  status: 'active',
  last_run_at: null,
  next_run_at: null,
  run_count: 0,
  payload: { is_default: true },
  created_by: 'user-1',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

describe('ScheduledJobsService', () => {
  let service: ScheduledJobsService;
  let repo: jest.Mocked<ScheduledJobsRepository>;

  beforeEach(async () => {
    const repoMock: jest.Mocked<ScheduledJobsRepository> = {
      create: jest.fn(),
      findAll: jest.fn(),
      findById: jest.fn(),
      findByIdOrThrow: jest.fn(),
      findDue: jest.fn(),
      setStatus: jest.fn(),
      recordRun: jest.fn(),
      delete: jest.fn(),
      countByOrg: jest.fn(),
    } as unknown as jest.Mocked<ScheduledJobsRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledJobsService,
        { provide: ScheduledJobsRepository, useValue: repoMock },
      ],
    }).compile();

    service = module.get(ScheduledJobsService);
    repo = module.get(ScheduledJobsRepository);
  });

  // ── ensureDefaultJobs ───────────────────────────────────────────────────

  describe('ensureDefaultJobs', () => {
    it('creates mañanero when org has no jobs', async () => {
      repo.countByOrg.mockResolvedValue(0);
      repo.create.mockResolvedValue(mockJob());

      await service.ensureDefaultJobs('org-1', 'user-1');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        job_type: 'briefing',
        schedule_type: 'cron',
        cron_expr: '0 7 * * *',
        task_input: MANERO_TASK_INPUT,
      }));
    });

    it('skips creation when org already has jobs', async () => {
      repo.countByOrg.mockResolvedValue(2);

      await service.ensureDefaultJobs('org-1', 'user-1');

      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // ── ensureAgentAutonomyJobs ─────────────────────────────────────────────

  describe('ensureAgentAutonomyJobs', () => {
    it('creates the internal autonomy job when missing', async () => {
      repo.findAll.mockResolvedValue([]);
      repo.create.mockResolvedValue(mockJob({
        name: 'Autonomía de EVA',
        job_type: 'custom',
        schedule_type: 'interval',
        interval_minutes: 360,
        task_input: AGENT_AUTONOMY_TASK_INPUT,
        payload: { system_job: AGENT_AUTONOMY_JOB_KEY, visible_control_plane: true },
      }));

      await service.ensureAgentAutonomyJobs([{ orgId: 'org-1', userId: 'user-1' }], 360);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        org_id: 'org-1',
        created_by: 'user-1',
        job_type: 'custom',
        schedule_type: 'interval',
        interval_minutes: 360,
        task_input: AGENT_AUTONOMY_TASK_INPUT,
        payload: expect.objectContaining({
          system_job: AGENT_AUTONOMY_JOB_KEY,
          visible_control_plane: true,
        }),
      }));
    });

    it('skips creation when an autonomy row already exists', async () => {
      repo.findAll.mockResolvedValue([mockJob({
        job_type: 'custom',
        payload: { system_job: AGENT_AUTONOMY_JOB_KEY },
      })]);

      await service.ensureAgentAutonomyJobs([{ orgId: 'org-1', userId: 'user-1' }], 360);

      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // ── activateManero ──────────────────────────────────────────────────────

  describe('activateManero', () => {
    it('creates mañanero at default 7am when no existing job', async () => {
      repo.findAll.mockResolvedValue([]);
      repo.create.mockResolvedValue(mockJob());

      await service.activateManero('org-1', 'user-1');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        cron_expr: '0 7 * * *',
        job_type: 'briefing',
      }));
    });

    it('replaces existing briefing job with new hour', async () => {
      const existing = mockJob({ id: 'old-job', status: 'active' });
      repo.findAll.mockResolvedValue([existing]);
      repo.delete.mockResolvedValue();
      repo.create.mockResolvedValue(mockJob({ cron_expr: '0 8 * * *' }));

      await service.activateManero('org-1', 'user-1', 8);

      expect(repo.delete).toHaveBeenCalledWith('old-job', 'org-1');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        cron_expr: '0 8 * * *',
      }));
    });
  });

  // ── createFromNl ────────────────────────────────────────────────────────

  describe('createFromNl', () => {
    it('detects url_monitor type', async () => {
      repo.create.mockResolvedValue(mockJob({ job_type: 'url_monitor', name: 'Monitor de URL 🌐' }));

      const { job } = await service.createFromNl(
        'avísame si https://example.com está caída cada hora', 'org-1', 'user-1',
      );

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        job_type: 'url_monitor',
        schedule_type: 'interval',
        interval_minutes: 60,
      }));
      expect(job.name).toBe('Monitor de URL 🌐');
    });

    it('detects price_monitor type', async () => {
      repo.create.mockResolvedValue(mockJob({ job_type: 'price_monitor' }));

      await service.createFromNl('monitorea el precio de https://amazon.com/prod cada día', 'org-1', 'user-1');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        job_type: 'price_monitor',
        payload: { url: 'https://amazon.com/prod', threshold: null },
      }));
    });

    it('detects email_check type', async () => {
      repo.create.mockResolvedValue(mockJob({ job_type: 'email_check' }));

      await service.createFromNl('revisa mis correos importantes cada 2 horas', 'org-1', 'user-1');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        job_type: 'email_check',
        interval_minutes: 120,
      }));
    });

    it('uses parsed hour for cron schedule', async () => {
      repo.create.mockResolvedValue(mockJob({ cron_expr: '0 9 * * *' }));

      await service.createFromNl('avísame a las 9am todos los días', 'org-1', 'user-1');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        schedule_type: 'cron',
        cron_expr: '0 9 * * *',
      }));
    });

    it('returns human-readable summary', async () => {
      const job = mockJob({ cron_expr: '0 7 * * *' });
      repo.create.mockResolvedValue(job);

      const { summary } = await service.createFromNl('briefing diario', 'org-1', 'user-1');

      expect(summary).toContain('7:00');
      expect(summary).toContain('todos los días');
    });
  });

  // ── describeSchedule ────────────────────────────────────────────────────

  describe('describeSchedule', () => {
    it('describes cron daily', () => {
      const job = mockJob({ cron_expr: '0 7 * * *' });
      expect(service.describeSchedule(job)).toContain('7:00');
      expect(service.describeSchedule(job)).toContain('todos los días');
    });

    it('describes cron weekdays', () => {
      const job = mockJob({ cron_expr: '0 9 * * 1-5' });
      expect(service.describeSchedule(job)).toContain('lunes a viernes');
    });

    it('describes interval', () => {
      const job = mockJob({ schedule_type: 'interval', interval_minutes: 90, cron_expr: null });
      expect(service.describeSchedule(job)).toContain('1h 30min');
    });

    it('describes once', () => {
      const job = mockJob({
        schedule_type: 'once', cron_expr: null, run_at: '2024-06-01T13:00:00Z',
      });
      expect(service.describeSchedule(job)).toMatch(/programado para/);
    });
  });

  // ── pause / resume / delete ──────────────────────────────────────────────

  it('pause calls repo.setStatus with paused', async () => {
    repo.findByIdOrThrow.mockResolvedValue(mockJob());
    repo.setStatus.mockResolvedValue(mockJob({ status: 'paused' }));

    const result = await service.pause('job-uuid-1', 'org-1');

    expect(repo.setStatus).toHaveBeenCalledWith('job-uuid-1', 'org-1', 'paused');
    expect(result.status).toBe('paused');
  });

  it('delete calls repo.delete after 404 guard', async () => {
    repo.findByIdOrThrow.mockResolvedValue(mockJob());
    repo.delete.mockResolvedValue();

    await service.delete('job-uuid-1', 'org-1');

    expect(repo.findByIdOrThrow).toHaveBeenCalledWith('job-uuid-1', 'org-1');
    expect(repo.delete).toHaveBeenCalledWith('job-uuid-1', 'org-1');
  });
});
