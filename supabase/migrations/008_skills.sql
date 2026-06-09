-- Skill System (Phase 10)

CREATE TABLE IF NOT EXISTS skills (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  slug           TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  latest_version TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  skill_id        UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  manifest        JSONB NOT NULL,
  instructions    TEXT NOT NULL DEFAULT '',
  tools           JSONB NOT NULL DEFAULT '[]',
  permissions     JSONB NOT NULL DEFAULT '{}',
  examples        JSONB NOT NULL DEFAULT '[]',
  tests           JSONB NOT NULL DEFAULT '[]',
  memory_policy   JSONB NOT NULL DEFAULT '{}',
  approval_policy JSONB NOT NULL DEFAULT '{}',
  checksum        TEXT NOT NULL,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, skill_id, version)
);

CREATE TABLE IF NOT EXISTS tools (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  skill_id         UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version_id UUID NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  capability       TEXT NOT NULL,
  description      TEXT,
  approval_level   INT NOT NULL DEFAULT 0 CHECK (approval_level >= 0 AND approval_level <= 3),
  schema           JSONB NOT NULL DEFAULT '{}',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, skill_version_id, name)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  task_id          UUID REFERENCES tasks(id) ON DELETE SET NULL,
  skill_id         UUID REFERENCES skills(id) ON DELETE SET NULL,
  skill_version_id UUID REFERENCES skill_versions(id) ON DELETE SET NULL,
  tool_name        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'running', 'completed', 'failed', 'rejected')),
  input            JSONB NOT NULL DEFAULT '{}',
  output           JSONB,
  approval_id      UUID REFERENCES approvals(id) ON DELETE SET NULL,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_skills_org_slug         ON skills(org_id, slug);
CREATE INDEX IF NOT EXISTS idx_skills_org_status       ON skills(org_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill    ON skill_versions(org_id, skill_id, version);
CREATE INDEX IF NOT EXISTS idx_tools_skill_version     ON tools(org_id, skill_version_id);
CREATE INDEX IF NOT EXISTS idx_tools_capability        ON tools(org_id, capability);
CREATE INDEX IF NOT EXISTS idx_tool_calls_task         ON tool_calls(org_id, task_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_skill        ON tool_calls(org_id, skill_id);

DROP TRIGGER IF EXISTS skills_updated_at ON skills;
CREATE TRIGGER skills_updated_at
  BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
