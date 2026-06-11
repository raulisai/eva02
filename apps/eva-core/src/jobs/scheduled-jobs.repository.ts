import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScheduledJob, CreateScheduledJobInput, JobStatus } from './scheduled-job.types';
import { computeNextRunAt } from './cron-utils';

@Injectable()
export class ScheduledJobsRepository {
  private readonly logger = new Logger(ScheduledJobsRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateScheduledJobInput & { org_id: string; created_by: string }): Promise<ScheduledJob> {
    const next = computeNextRunAt({
      schedule_type: input.schedule_type,
      cron_expr: input.cron_expr,
      run_at: input.run_at,
      interval_minutes: input.interval_minutes,
      timezone: input.timezone ?? 'America/Mexico_City',
    });

    const { data, error } = await this.db.admin
      .from('scheduled_jobs')
      .insert({
        org_id: input.org_id,
        created_by: input.created_by,
        name: input.name,
        description: input.description ?? null,
        job_type: input.job_type ?? 'custom',
        schedule_type: input.schedule_type,
        cron_expr: input.cron_expr ?? null,
        run_at: input.run_at ?? null,
        interval_minutes: input.interval_minutes ?? null,
        timezone: input.timezone ?? 'America/Mexico_City',
        task_input: input.task_input,
        payload: input.payload ?? {},
        status: 'active',
        next_run_at: next,
      })
      .select()
      .single();

    if (error) {
      this.logger.error('scheduled_jobs.create', error);
      throw new InternalServerErrorException('Failed to create scheduled job');
    }
    return data as ScheduledJob;
  }

  async findAll(orgId: string): Promise<ScheduledJob[]> {
    const { data, error } = await this.db.admin
      .from('scheduled_jobs')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error('scheduled_jobs.findAll', error);
      throw new InternalServerErrorException('Failed to list scheduled jobs');
    }
    return (data ?? []) as ScheduledJob[];
  }

  async findById(id: string, orgId: string): Promise<ScheduledJob | null> {
    const { data, error } = await this.db.admin
      .from('scheduled_jobs')
      .select('*')
      .eq('id', id)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      this.logger.error('scheduled_jobs.findById', error);
      throw new InternalServerErrorException('Failed to find scheduled job');
    }
    return data as ScheduledJob | null;
  }

  async findByIdOrThrow(id: string, orgId: string): Promise<ScheduledJob> {
    const job = await this.findById(id, orgId);
    if (!job) throw new NotFoundException(`Scheduled job ${id} not found`);
    return job;
  }

  /** Returns all active jobs whose next_run_at is now or in the past. */
  async findDue(): Promise<ScheduledJob[]> {
    const now = new Date().toISOString();
    const { data, error } = await this.db.admin
      .from('scheduled_jobs')
      .select('*')
      .eq('status', 'active')
      .lte('next_run_at', now);

    if (error) {
      this.logger.error('scheduled_jobs.findDue', error);
      return [];
    }
    return (data ?? []) as ScheduledJob[];
  }

  async setStatus(id: string, orgId: string, status: JobStatus): Promise<ScheduledJob> {
    const { data, error } = await this.db.admin
      .from('scheduled_jobs')
      .update({ status })
      .eq('id', id)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) {
      this.logger.error('scheduled_jobs.setStatus', error);
      throw new InternalServerErrorException('Failed to update job status');
    }
    return data as ScheduledJob;
  }

  /** Called after a job fires: advances timestamps and increments run_count. */
  async recordRun(id: string, orgId: string, nextRunAt: string | null): Promise<void> {
    const { data: current } = await this.db.admin
      .from('scheduled_jobs')
      .select('run_count')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();

    const { error } = await this.db.admin
      .from('scheduled_jobs')
      .update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextRunAt,
        status: nextRunAt ? 'active' : 'completed',
        run_count: ((current as { run_count?: number } | null)?.run_count ?? 0) + 1,
      })
      .eq('id', id)
      .eq('org_id', orgId);

    if (error) this.logger.warn(`recordRun failed for job ${id}: ${error.message}`);
  }

  async delete(id: string, orgId: string): Promise<void> {
    const { error } = await this.db.admin
      .from('scheduled_jobs')
      .delete()
      .eq('id', id)
      .eq('org_id', orgId);

    if (error) {
      this.logger.error('scheduled_jobs.delete', error);
      throw new InternalServerErrorException('Failed to delete scheduled job');
    }
  }

  async countByOrg(orgId: string): Promise<number> {
    const { count, error } = await this.db.admin
      .from('scheduled_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);

    if (error) return 0;
    return count ?? 0;
  }
}
