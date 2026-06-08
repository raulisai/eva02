-- Domain events persisted for audit / replay
CREATE TABLE IF NOT EXISTS domain_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_events_org_id     ON domain_events(org_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_task_id    ON domain_events(task_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_event_type ON domain_events(event_type);
CREATE INDEX IF NOT EXISTS idx_domain_events_created_at ON domain_events(created_at DESC);
