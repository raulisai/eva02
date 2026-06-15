-- Development Studio: goal-driven autonomous dev sessions
-- Extends dev_tasks (010), adds sessions/goals/iterations/agents/human-tasks/events/merge-proposals.
-- NOTE: Apply manually via Supabase dashboard — never auto-applied by eva-core.

-- ── 1. Extend dev_task_status enum ───────────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'queued';
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'assigned';
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'needs_review';
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'changes_requested';
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'approved';
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'merged';
  ALTER TYPE dev_task_status ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ── 2. New ENUMs ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE dev_session_studio_status AS ENUM (
    'idea_intake',
    'planning',
    'awaiting_goals_approval',
    'awaiting_architecture_approval',
    'running',
    'waiting_for_human_setup',
    'waiting_for_human_secret',
    'waiting_for_human_review',
    'waiting_for_human_validation',
    'paused',
    'blocked',
    'ready_for_release',
    'ready_for_deploy',
    'completed',
    'failed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dev_goal_status AS ENUM (
    'proposed',
    'approved',
    'in_progress',
    'blocked',
    'needs_user_decision',
    'ready_for_validation',
    'validated',
    'completed',
    'paused',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dev_iteration_status AS ENUM (
    'planned',
    'running',
    'evaluating',
    'needs_more_work',
    'needs_user_decision',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dev_agent_status AS ENUM (
    'idle',
    'running',
    'blocked',
    'quota_exhausted',
    'rate_limited',
    'waiting_for_dependency',
    'completed',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dev_human_task_status AS ENUM (
    'pending',
    'in_progress',
    'waiting_user',
    'submitted',
    'verified',
    'rejected',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. dev_sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_sessions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL,
  project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  original_prompt     TEXT NOT NULL,
  north_star          TEXT,
  definition_of_done  JSONB NOT NULL DEFAULT '[]',
  status              dev_session_studio_status NOT NULL DEFAULT 'idea_intake',
  repo_url            TEXT,
  base_branch         TEXT NOT NULL DEFAULT 'main',
  session_branch      TEXT,
  current_goal_id     UUID,
  current_iteration_id UUID,
  continuation_policy JSONB NOT NULL DEFAULT '{
    "default": "continue_until_goals_completed",
    "never_stop_just_because_tasks_are_empty": true,
    "ask_user_when": ["all_goals_completed", "blocked_by_human_more_than_once", "budget_or_quota_exhausted", "destructive_migration_required"],
    "auto_create_iteration_when": ["goal_incomplete_and_no_active_tasks", "iteration_failed_but_goal_still_valid", "tests_failed_with_fixable_errors"],
    "max_iterations_per_goal": 10,
    "budget_token_limit": 500000
  }',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. dev_goals ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_goals (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id        UUID NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  status            dev_goal_status NOT NULL DEFAULT 'proposed',
  priority          INT NOT NULL DEFAULT 0,
  success_criteria  JSONB NOT NULL DEFAULT '[]',
  current_score     NUMERIC NOT NULL DEFAULT 0,
  target_score      NUMERIC NOT NULL DEFAULT 1,
  owner_agent_role  TEXT NOT NULL DEFAULT 'project_manager',
  iteration_count   INT NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 5. dev_iterations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_iterations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id        UUID NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
  goal_id           UUID REFERENCES dev_goals(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  status            dev_iteration_status NOT NULL DEFAULT 'planned',
  objective         TEXT NOT NULL,
  planned_outputs   JSONB NOT NULL DEFAULT '[]',
  completed_outputs JSONB NOT NULL DEFAULT '[]',
  evaluation        JSONB NOT NULL DEFAULT '{}',
  created_by        TEXT NOT NULL DEFAULT 'project_manager',
  number            INT NOT NULL DEFAULT 1,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 6. Extend dev_tasks (existing table from 010) ────────────────────────────
ALTER TABLE dev_tasks
  ADD COLUMN IF NOT EXISTS session_id       UUID REFERENCES dev_sessions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS goal_id          UUID REFERENCES dev_goals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS iteration_id     UUID REFERENCES dev_iterations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS parent_task_id   UUID,
  ADD COLUMN IF NOT EXISTS role             TEXT,
  ADD COLUMN IF NOT EXISTS priority_studio  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS depends_on       UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS assigned_agent_id   UUID,
  ADD COLUMN IF NOT EXISTS branch_name     TEXT,
  ADD COLUMN IF NOT EXISTS result_summary  TEXT,
  ADD COLUMN IF NOT EXISTS artifacts       JSONB NOT NULL DEFAULT '[]';

-- ── 7. dev_agents ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_agents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id       UUID NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  name             TEXT NOT NULL,
  status           dev_agent_status NOT NULL DEFAULT 'idle',
  runtime          TEXT NOT NULL DEFAULT 'anthropic_model',
  node_id          UUID,
  current_task_id  UUID,
  branch_name      TEXT,
  container_id     TEXT,
  budget           JSONB NOT NULL DEFAULT '{}',
  last_heartbeat_at TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 8. dev_human_tasks ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_human_tasks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id       UUID NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
  goal_id          UUID REFERENCES dev_goals(id) ON DELETE CASCADE,
  iteration_id     UUID REFERENCES dev_iterations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  status           dev_human_task_status NOT NULL DEFAULT 'pending',
  required_output  TEXT,
  sensitive        BOOLEAN NOT NULL DEFAULT FALSE,
  blocks_task_ids  UUID[] NOT NULL DEFAULT '{}',
  instructions     JSONB NOT NULL DEFAULT '{}',
  submitted_result JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

-- ── 9. dev_events (session timeline) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_events (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id   UUID NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
  goal_id      UUID,
  iteration_id UUID,
  task_id      UUID,
  agent_id     UUID,
  event_type   TEXT NOT NULL,
  message      TEXT,
  payload      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 10. dev_merge_proposals ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dev_merge_proposals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id     UUID NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
  task_id        UUID REFERENCES dev_tasks(id) ON DELETE CASCADE,
  source_branch  TEXT NOT NULL,
  target_branch  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  diff_summary   TEXT,
  risk_level     TEXT,
  test_result    JSONB NOT NULL DEFAULT '{}',
  reviewer_notes TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 11. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dev_sessions_org           ON dev_sessions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_sessions_user          ON dev_sessions(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_dev_goals_session_status   ON dev_goals(org_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_iterations_session     ON dev_iterations(org_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_tasks_session          ON dev_tasks(org_id, session_id, status) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dev_agents_session         ON dev_agents(org_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_human_tasks_session    ON dev_human_tasks(org_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_events_session         ON dev_events(org_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_merge_proposals_session ON dev_merge_proposals(org_id, session_id, status);

-- ── 12. updated_at triggers ───────────────────────────────────────────────────
DROP TRIGGER IF EXISTS dev_sessions_updated_at ON dev_sessions;
CREATE TRIGGER dev_sessions_updated_at
  BEFORE UPDATE ON dev_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS dev_goals_updated_at ON dev_goals;
CREATE TRIGGER dev_goals_updated_at
  BEFORE UPDATE ON dev_goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS dev_merge_proposals_updated_at ON dev_merge_proposals;
CREATE TRIGGER dev_merge_proposals_updated_at
  BEFORE UPDATE ON dev_merge_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 13. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE dev_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_goals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_iterations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_human_tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_merge_proposals ENABLE ROW LEVEL SECURITY;

-- Pattern: same as 014_rls_policies — org_id from JWT app_metadata
CREATE POLICY dev_sessions_org_isolation        ON dev_sessions        FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
CREATE POLICY dev_goals_org_isolation           ON dev_goals           FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
CREATE POLICY dev_iterations_org_isolation      ON dev_iterations      FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
CREATE POLICY dev_agents_org_isolation          ON dev_agents          FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
CREATE POLICY dev_human_tasks_org_isolation     ON dev_human_tasks     FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
CREATE POLICY dev_events_org_isolation          ON dev_events          FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
CREATE POLICY dev_merge_proposals_org_isolation ON dev_merge_proposals FOR ALL USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
