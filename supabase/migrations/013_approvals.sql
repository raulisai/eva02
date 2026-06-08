-- Approval Engine: money/production/data actions require explicit approval
CREATE TABLE IF NOT EXISTS approvals (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL,
  task_id      UUID REFERENCES tasks(id) ON DELETE CASCADE,
  level        INT NOT NULL DEFAULT 1 CHECK (level >= 0 AND level <= 3),
  action_type  TEXT NOT NULL,
  action_hash  TEXT NOT NULL,     -- SHA-256(action_type + canonical payload + nonce + expires_at)
  nonce        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  payload      JSONB NOT NULL DEFAULT '{}',
  summary      TEXT,
  screenshot_ref TEXT,
  source       TEXT NOT NULL DEFAULT 'core_path'
                 CHECK (source IN ('core_path', 'fast_path', 'browser', 'dev_manager', 'system')),
  requested_by UUID NOT NULL REFERENCES auth.users(id),
  reviewed_by  UUID REFERENCES auth.users(id),
  reviewed_by_2 UUID REFERENCES auth.users(id),
  reviewed_at  TIMESTAMPTZ,
  nonce_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_nonce   ON approvals(nonce);
CREATE INDEX        IF NOT EXISTS idx_approvals_org_id  ON approvals(org_id);
CREATE INDEX        IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);
CREATE INDEX        IF NOT EXISTS idx_approvals_status  ON approvals(status);
CREATE INDEX        IF NOT EXISTS idx_approvals_level   ON approvals(org_id, level);
CREATE INDEX        IF NOT EXISTS idx_approvals_hash    ON approvals(org_id, action_hash);
