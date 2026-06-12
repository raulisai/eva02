-- Agent intelligence telemetry: trajectories, checkpoint substrate, and metrics views.
-- Tenant scoped by org_id; no destructive operations.

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_status') THEN
    ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'waiting_for_input';
  END IF;
END $$;

ALTER TABLE skills
  DROP CONSTRAINT IF EXISTS skills_status_check;

ALTER TABLE skills
  ADD CONSTRAINT skills_status_check
  CHECK (status IN ('draft', 'active', 'provisional', 'disabled', 'archived'));

CREATE TABLE IF NOT EXISTS agent_trajectories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL,
  task_id               UUID REFERENCES tasks(id) ON DELETE SET NULL,
  goal                  TEXT NOT NULL,
  goal_key              TEXT NOT NULL DEFAULT 'general',
  steps                 JSONB NOT NULL DEFAULT '[]',
  outcome               TEXT NOT NULL DEFAULT 'running'
                        CHECK (outcome IN ('running', 'ok', 'failed', 'degraded', 'cancelled')),
  tokens_used           INT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  tools_used            TEXT[] NOT NULL DEFAULT '{}',
  depth                 INT NOT NULL DEFAULT 0 CHECK (depth >= 0),
  duration_ms           INT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  stall_count           INT NOT NULL DEFAULT 0 CHECK (stall_count >= 0),
  dod_rejections        INT NOT NULL DEFAULT 0 CHECK (dod_rejections >= 0),
  model_budget_per_step JSONB NOT NULL DEFAULT '[]',
  metadata              JSONB NOT NULL DEFAULT '{}',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_trajectories_org_created
  ON agent_trajectories(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_trajectories_org_outcome
  ON agent_trajectories(org_id, outcome, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_trajectories_org_goal_key
  ON agent_trajectories(org_id, goal_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_trajectories_tools
  ON agent_trajectories USING GIN (tools_used);

DROP TRIGGER IF EXISTS agent_trajectories_updated_at ON agent_trajectories;
CREATE TRIGGER agent_trajectories_updated_at
  BEFORE UPDATE ON agent_trajectories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE agent_trajectories ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW agent_tool_success_metrics
WITH (security_invoker = true) AS
SELECT
  org_id,
  tool_name,
  COUNT(*)::INT AS runs,
  COUNT(*) FILTER (WHERE outcome = 'ok')::INT AS ok_runs,
  COUNT(*) FILTER (WHERE outcome = 'degraded')::INT AS degraded_runs,
  COUNT(*) FILTER (WHERE outcome IN ('failed', 'cancelled'))::INT AS failed_runs,
  COALESCE(ROUND(COUNT(*) FILTER (WHERE outcome = 'ok')::NUMERIC / NULLIF(COUNT(*), 0), 4), 0) AS success_rate,
  ROUND(AVG(tokens_used), 2) AS avg_tokens,
  ROUND(AVG(jsonb_array_length(steps)), 2) AS avg_steps,
  ROUND(AVG(stall_count), 2) AS avg_stalls,
  ROUND(AVG(dod_rejections), 2) AS avg_dod_rejections
FROM agent_trajectories
CROSS JOIN LATERAL unnest(CASE WHEN cardinality(tools_used) = 0 THEN ARRAY['__none__']::TEXT[] ELSE tools_used END) AS tool_name
WHERE outcome <> 'running'
GROUP BY org_id, tool_name;

CREATE OR REPLACE VIEW agent_goal_success_metrics
WITH (security_invoker = true) AS
SELECT
  org_id,
  goal_key,
  COUNT(*)::INT AS runs,
  COUNT(*) FILTER (WHERE outcome = 'ok')::INT AS ok_runs,
  COALESCE(ROUND(COUNT(*) FILTER (WHERE outcome = 'ok')::NUMERIC / NULLIF(COUNT(*), 0), 4), 0) AS success_rate,
  ROUND(AVG(tokens_used), 2) AS avg_tokens,
  ROUND(AVG(jsonb_array_length(steps)), 2) AS avg_steps,
  ROUND(AVG(duration_ms), 2) AS avg_duration_ms
FROM agent_trajectories
WHERE outcome <> 'running'
GROUP BY org_id, goal_key;

CREATE OR REPLACE VIEW agent_defense_metrics
WITH (security_invoker = true) AS
SELECT
  org_id,
  COUNT(*)::INT AS runs,
  SUM(stall_count)::INT AS stall_count,
  SUM(dod_rejections)::INT AS dod_rejections,
  COALESCE(ROUND(SUM(stall_count)::NUMERIC / NULLIF(COUNT(*), 0), 4), 0) AS stalls_per_run,
  COALESCE(ROUND(SUM(dod_rejections)::NUMERIC / NULLIF(COUNT(*), 0), 4), 0) AS dod_rejections_per_run
FROM agent_trajectories
WHERE outcome <> 'running'
GROUP BY org_id;

CREATE OR REPLACE VIEW agent_skill_funnel_metrics
WITH (security_invoker = true) AS
SELECT
  s.org_id,
  COUNT(*)::INT AS registered,
  COUNT(*) FILTER (WHERE s.status = 'provisional')::INT AS provisional,
  COUNT(*) FILTER (WHERE s.status = 'active')::INT AS promoted_or_active,
  COUNT(DISTINCT e.skill_slug)::INT AS reused,
  COALESCE(ROUND(COUNT(DISTINCT e.skill_slug)::NUMERIC / NULLIF(COUNT(*), 0), 4), 0) AS reuse_rate
FROM skills s
LEFT JOIN skill_selection_events e
  ON e.org_id = s.org_id
 AND e.skill_slug = s.slug
 AND e.outcome = 'success'
GROUP BY s.org_id;

CREATE OR REPLACE VIEW agent_task_efficiency_metrics
WITH (security_invoker = true) AS
SELECT
  org_id,
  COUNT(*)::INT AS runs,
  ROUND(AVG(jsonb_array_length(steps)), 2) AS avg_steps,
  ROUND(AVG(tokens_used), 2) AS avg_tokens,
  ROUND(AVG(duration_ms), 2) AS avg_duration_ms,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tokens_used), 2) AS p95_tokens
FROM agent_trajectories
WHERE outcome <> 'running'
GROUP BY org_id;

GRANT SELECT, INSERT, UPDATE ON agent_trajectories TO authenticated;
GRANT SELECT ON
  agent_tool_success_metrics,
  agent_goal_success_metrics,
  agent_defense_metrics,
  agent_skill_funnel_metrics,
  agent_task_efficiency_metrics
TO authenticated;
