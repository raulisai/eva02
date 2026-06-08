-- Browser Agent (Phase 7)

CREATE TABLE IF NOT EXISTS browser_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  service         TEXT NOT NULL,
  label           TEXT,
  encrypted_state TEXT,
  kms_key_ref     TEXT NOT NULL DEFAULT 'dev-kms-mock',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, service)
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  profile_id  UUID NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'closed', 'failed')),
  current_url TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS browser_screenshots (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  image_base64 TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT 'image/png',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS browser_action_preparations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id    UUID NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  task_id       UUID REFERENCES tasks(id) ON DELETE SET NULL,
  approval_id   UUID REFERENCES approvals(id) ON DELETE SET NULL,
  screenshot_id UUID REFERENCES browser_screenshots(id) ON DELETE SET NULL,
  action_type   TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  action_hash   TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval', 'approved', 'executed', 'rejected', 'expired')),
  created_by    UUID NOT NULL REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_profiles_org_service
  ON browser_profiles(org_id, service);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_org_status
  ON browser_sessions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_browser_screenshots_session
  ON browser_screenshots(org_id, session_id);
CREATE INDEX IF NOT EXISTS idx_browser_preparations_session
  ON browser_action_preparations(org_id, session_id);
CREATE INDEX IF NOT EXISTS idx_browser_preparations_hash
  ON browser_action_preparations(org_id, action_hash);

DROP TRIGGER IF EXISTS browser_profiles_updated_at ON browser_profiles;
CREATE TRIGGER browser_profiles_updated_at
  BEFORE UPDATE ON browser_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS browser_sessions_updated_at ON browser_sessions;
CREATE TRIGGER browser_sessions_updated_at
  BEFORE UPDATE ON browser_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
