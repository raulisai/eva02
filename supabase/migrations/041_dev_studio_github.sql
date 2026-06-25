-- Development Studio: real GitHub backing for sessions/agents/PRs.
-- Adds repo coordinates per session, git author identity per agent, and PR
-- tracking columns on dev_merge_proposals (reused as the PR record).
-- NOTE: Apply manually via Supabase dashboard — never auto-applied by eva-core.
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS). No new tables, no new
-- RLS policies needed (org_id policies from 038_dev_studio already cover these).

-- ── 1. dev_sessions: repo coordinates + integration branch ───────────────────
-- repo_url / base_branch / session_branch already exist from 038.
ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS repo_owner         TEXT,
  ADD COLUMN IF NOT EXISTS repo_name          TEXT,
  ADD COLUMN IF NOT EXISTS repo_provider      TEXT NOT NULL DEFAULT 'github',
  ADD COLUMN IF NOT EXISTS integration_branch TEXT NOT NULL DEFAULT 'develop';

-- ── 2. dev_agents: stable git author identity per agent ──────────────────────
-- branch_name already exists from 038. Author name/email make every commit
-- attributable to the agent that produced it; github_login is informational.
ALTER TABLE dev_agents
  ADD COLUMN IF NOT EXISTS git_author_name  TEXT,
  ADD COLUMN IF NOT EXISTS git_author_email TEXT,
  ADD COLUMN IF NOT EXISTS github_login     TEXT;

-- ── 3. dev_merge_proposals: real PR tracking ─────────────────────────────────
-- source_branch / target_branch / status / diff_summary / risk_level / test_result
-- already exist from 038. These columns bind a proposal to its GitHub PR.
ALTER TABLE dev_merge_proposals
  ADD COLUMN IF NOT EXISTS pr_number   INT,
  ADD COLUMN IF NOT EXISTS pr_url      TEXT,
  ADD COLUMN IF NOT EXISTS pr_state    TEXT,
  ADD COLUMN IF NOT EXISTS head_sha    TEXT,
  ADD COLUMN IF NOT EXISTS kind        TEXT NOT NULL DEFAULT 'feature',  -- feature | release
  ADD COLUMN IF NOT EXISTS approval_id UUID;  -- release PRs gate through the Approval Engine

CREATE INDEX IF NOT EXISTS idx_dev_merge_proposals_pr
  ON dev_merge_proposals(org_id, session_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_dev_merge_proposals_approval
  ON dev_merge_proposals(org_id, approval_id) WHERE approval_id IS NOT NULL;

-- ── 4. Reload schema cache for PostgREST ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
