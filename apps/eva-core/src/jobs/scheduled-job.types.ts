export type JobType = 'briefing' | 'email_check' | 'price_monitor' | 'url_monitor' | 'stock_monitor' | 'file_validator' | 'custom';
export type JobStatus = 'active' | 'paused' | 'completed';
export type ScheduleType = 'cron' | 'once' | 'interval';

export interface ScheduledJob {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  job_type: JobType;
  schedule_type: ScheduleType;
  cron_expr: string | null;
  run_at: string | null;
  interval_minutes: number | null;
  timezone: string;
  task_input: string;
  status: JobStatus;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  payload: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateScheduledJobInput {
  name: string;
  description?: string;
  job_type?: JobType;
  schedule_type: ScheduleType;
  cron_expr?: string;
  run_at?: string;
  interval_minutes?: number;
  timezone?: string;
  task_input: string;
  payload?: Record<string, unknown>;
}
