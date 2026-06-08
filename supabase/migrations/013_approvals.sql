-- Approval Engine: money/production/data actions require explicit approval
CREATE TABLE IF NOT EXISTS approvals (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_type  TEXT NOT NULL,
  action_hash  TEXT NOT NULL,     -- SHA-256(action_type + payload + nonce)
  nonce        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  payload      JSONB NOT NULL DEFAULT '{}',
  requested_by UUID NOT NULL REFERENCES auth.users(id),
  reviewed_by  UUID REFERENCES auth.users(id),
  reviewed_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_nonce   ON approvals(nonce);
CREATE INDEX        IF NOT EXISTS idx_approvals_org_id  ON approvals(org_id);
CREATE INDEX        IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);
CREATE INDEX        IF NOT EXISTS idx_approvals_status  ON approvals(status);
