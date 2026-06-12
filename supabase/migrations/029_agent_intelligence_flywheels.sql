-- Agent intelligence flywheels: skill embeddings, user-input pauses, settings, and run artifacts.
-- Tenant scoped by org_id; additive only.

CREATE TABLE IF NOT EXISTS skill_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  skill_id    UUID REFERENCES skills(id) ON DELETE CASCADE,
  skill_slug  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('bundled', 'generated')),
  content     TEXT NOT NULL,
  embedding   vector(1536) NOT NULL,
  model       TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  checksum    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, source, skill_slug)
);

CREATE INDEX IF NOT EXISTS idx_skill_embeddings_org_slug
  ON skill_embeddings(org_id, source, skill_slug);

CREATE INDEX IF NOT EXISTS idx_skill_embeddings_vector
  ON skill_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS agent_input_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  options      JSONB NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'answered', 'timed_out', 'cancelled')),
  answer       TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_input_requests_task
  ON agent_input_requests(org_id, task_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runtime_artifacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL
              CHECK (kind IN ('memory_playbook', 'failure_digest', 'heartbeat_brief', 'security_review', 'replay_example')),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_artifacts_org_kind
  ON agent_runtime_artifacts(org_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS org_agent_settings (
  org_id                       UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token_cap_per_task           INT NOT NULL DEFAULT 0 CHECK (token_cap_per_task >= 0),
  tool_rate_limit_per_minute   INT NOT NULL DEFAULT 0 CHECK (tool_rate_limit_per_minute >= 0),
  sandbox_network_allowlist    TEXT[] NOT NULL DEFAULT '{}',
  heartbeat_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  heartbeat_hour               INT NOT NULL DEFAULT 7 CHECK (heartbeat_hour >= 0 AND heartbeat_hour <= 23),
  heartbeat_last_sent_at       TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS skill_embeddings_updated_at ON skill_embeddings;
CREATE TRIGGER skill_embeddings_updated_at
  BEFORE UPDATE ON skill_embeddings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS agent_input_requests_updated_at ON agent_input_requests;
CREATE TRIGGER agent_input_requests_updated_at
  BEFORE UPDATE ON agent_input_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS org_agent_settings_updated_at ON org_agent_settings;
CREATE TRIGGER org_agent_settings_updated_at
  BEFORE UPDATE ON org_agent_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE skill_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_input_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_agent_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_embeddings_select" ON skill_embeddings
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "skill_embeddings_insert" ON skill_embeddings
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "skill_embeddings_update" ON skill_embeddings
  FOR UPDATE USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "skill_embeddings_delete" ON skill_embeddings
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "agent_input_requests_select" ON agent_input_requests
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "agent_input_requests_insert" ON agent_input_requests
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "agent_input_requests_update" ON agent_input_requests
  FOR UPDATE USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "agent_runtime_artifacts_select" ON agent_runtime_artifacts
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "agent_runtime_artifacts_insert" ON agent_runtime_artifacts
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "org_agent_settings_select" ON org_agent_settings
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "org_agent_settings_insert" ON org_agent_settings
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "org_agent_settings_update" ON org_agent_settings
  FOR UPDATE USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON skill_embeddings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON agent_input_requests TO authenticated;
GRANT SELECT, INSERT ON agent_runtime_artifacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON org_agent_settings TO authenticated;
