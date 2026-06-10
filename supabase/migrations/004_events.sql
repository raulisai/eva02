-- Task events persisted for audit / replay
CREATE TABLE IF NOT EXISTS task_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_events_org_id     ON task_events(org_id);
CREATE INDEX IF NOT EXISTS idx_task_events_task_id    ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_event_type ON task_events(event_type);
CREATE INDEX IF NOT EXISTS idx_task_events_created_at ON task_events(created_at DESC);
