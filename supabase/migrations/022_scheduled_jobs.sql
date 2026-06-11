-- ── Scheduled Jobs ────────────────────────────────────────────────────────────
-- Stores recurring and one-time jobs that EVA executes as tasks automatically.
-- Examples: el mañanero (daily briefing), URL health checks, price monitors.

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  description       TEXT,
  job_type          TEXT        NOT NULL DEFAULT 'custom'
                    CHECK (job_type IN ('briefing', 'email_check', 'price_monitor', 'url_monitor', 'custom')),

  -- Schedule: exactly one of cron_expr / run_at / interval_minutes must be set.
  schedule_type     TEXT        NOT NULL DEFAULT 'cron'
                    CHECK (schedule_type IN ('cron', 'once', 'interval')),
  cron_expr         TEXT,            -- 5-field cron: "0 7 * * *"
  run_at            TIMESTAMPTZ,     -- one-time execution
  interval_minutes  INTEGER     CHECK (interval_minutes > 0),
  timezone          TEXT        NOT NULL DEFAULT 'America/Mexico_City',

  -- What EVA will do when the job fires (natural-language task prompt)
  task_input        TEXT        NOT NULL,

  -- State
  status            TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'completed')),
  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  run_count         INTEGER     NOT NULL DEFAULT 0,

  -- Extra config for specific job types (URL, price threshold, etc.)
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_by        UUID        NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT scheduled_jobs_schedule_chk CHECK (
    (schedule_type = 'cron'     AND cron_expr       IS NOT NULL) OR
    (schedule_type = 'once'     AND run_at           IS NOT NULL) OR
    (schedule_type = 'interval' AND interval_minutes IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_org_idx
  ON scheduled_jobs(org_id);

CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
  ON scheduled_jobs(next_run_at)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS scheduled_jobs_updated_at ON scheduled_jobs;
CREATE TRIGGER scheduled_jobs_updated_at
  BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;

-- Users see and manage only their own org's jobs
CREATE POLICY "scheduled_jobs: org members read"
  ON scheduled_jobs FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "scheduled_jobs: org members write"
  ON scheduled_jobs FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

-- Service role bypasses RLS (used by the backend scheduler)
GRANT ALL ON scheduled_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_jobs TO authenticated;
