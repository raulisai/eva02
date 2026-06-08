-- =========================================================
-- Intent routes: audit log of every intent classification.
-- Tracks which classifier (rules/llm/hybrid) chose which path.
-- =========================================================

DO $$ BEGIN
  CREATE TYPE intent_type AS ENUM ('fast_path', 'core_path', 'core_path_approval');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS intent_routes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  input_hash  TEXT NOT NULL,
  intent      intent_type NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  classifier  TEXT NOT NULL DEFAULT 'rules',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intent_routes_org_id    ON intent_routes(org_id);
CREATE INDEX IF NOT EXISTS idx_intent_routes_task_id   ON intent_routes(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intent_routes_intent    ON intent_routes(org_id, intent);
CREATE INDEX IF NOT EXISTS idx_intent_routes_created   ON intent_routes(org_id, created_at DESC);
