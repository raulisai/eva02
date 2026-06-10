-- 016_integrations_soul_artifacts.sql
-- Org-level integrations (model provider keys + channel credentials),
-- MCP connections, artifacts, and the agent soul (persona + autonomy).
--
-- SECURITY: *_ciphertext columns hold AES-256-GCM ciphertext written ONLY by
-- eva-core (service role). Column-level grants below ensure the `authenticated`
-- role can never read ciphertext through the Data API.

-- ── org_integrations ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_integrations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind                      TEXT NOT NULL CHECK (kind IN ('model', 'channel')),
  provider                  TEXT NOT NULL,
  label                     TEXT,
  status                    TEXT NOT NULL DEFAULT 'disabled'
                              CHECK (status IN ('active', 'disabled', 'error')),
  config                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext         TEXT,
  secret_hint               TEXT,
  webhook_secret_ciphertext TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, provider)
);

CREATE INDEX IF NOT EXISTS org_integrations_org_kind_idx
  ON org_integrations(org_id, kind, provider);

DROP TRIGGER IF EXISTS org_integrations_updated_at ON org_integrations;
CREATE TRIGGER org_integrations_updated_at
  BEFORE UPDATE ON org_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── mcp_connections ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mcp_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  transport       TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('http', 'sse', 'stdio')),
  endpoint        TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  status          TEXT NOT NULL DEFAULT 'disconnected'
                    CHECK (status IN ('disconnected', 'connected', 'error')),
  auth_ciphertext TEXT,
  tools           JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS mcp_connections_org_idx ON mcp_connections(org_id, enabled);

DROP TRIGGER IF EXISTS mcp_connections_updated_at ON mcp_connections;
CREATE TRIGGER mcp_connections_updated_at
  BEFORE UPDATE ON mcp_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── artifacts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES tasks(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'text'
               CHECK (kind IN ('text', 'markdown', 'code', 'json', 'image', 'file', 'url')),
  title      TEXT NOT NULL,
  content    TEXT,
  uri        TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_org_task_idx ON artifacts(org_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_org_kind_idx ON artifacts(org_id, kind, created_at DESC);

-- ── agent_souls ────────────────────────────────────────────
-- One soul per org: persona, standing directives and autonomy (agency) level.
--   0 = observer (everything needs approval)
--   1 = assisted (default; sensitive actions need approval)
--   2 = semi-autonomous (only money/production/data actions need approval)
--   3 = autonomous (only L3 actions need approval)
CREATE TABLE IF NOT EXISTS agent_souls (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT 'EVA',
  persona        TEXT NOT NULL DEFAULT '',
  directives     JSONB NOT NULL DEFAULT '[]'::jsonb,
  autonomy_level INT NOT NULL DEFAULT 1 CHECK (autonomy_level >= 0 AND autonomy_level <= 3),
  model_prefs    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS agent_souls_updated_at ON agent_souls;
CREATE TRIGGER agent_souls_updated_at
  BEFORE UPDATE ON agent_souls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_souls ENABLE ROW LEVEL SECURITY;

-- Read-only for org members; ALL writes go through eva-core (service role)
CREATE POLICY "org_integrations_select" ON org_integrations
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "mcp_connections_select" ON mcp_connections
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "artifacts_select" ON artifacts
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "artifacts_insert" ON artifacts
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "agent_souls_select" ON agent_souls
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "agent_souls_insert" ON agent_souls
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "agent_souls_update" ON agent_souls
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Grants ─────────────────────────────────────────────────
-- Column-level SELECT: ciphertext columns are NEVER readable via the Data API.
GRANT SELECT (id, org_id, kind, provider, label, status, config, secret_hint, created_at, updated_at)
  ON org_integrations TO authenticated;

GRANT SELECT (id, org_id, name, transport, endpoint, enabled, status, tools, last_checked_at, last_error, created_at, updated_at)
  ON mcp_connections TO authenticated;

GRANT SELECT, INSERT ON artifacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON agent_souls TO authenticated;
