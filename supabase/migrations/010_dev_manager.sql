-- Development Control Center (Phase 6)

DO $$ BEGIN
  CREATE TYPE dev_task_status AS ENUM (
    'backlog',
    'ready',
    'in_progress',
    'waiting_approval',
    'testing',
    'reviewing',
    'done',
    'failed',
    'blocked'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dev_session_status AS ENUM (
    'starting',
    'running',
    'idle',
    'waiting_approval',
    'completed',
    'failed',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  repo_path     TEXT,
  node_id       UUID,
  stack         TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'active',
  main_branch   TEXT NOT NULL DEFAULT 'main',
  dev_command   TEXT,
  test_command  TEXT,
  build_command TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS dev_tasks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       dev_task_status NOT NULL DEFAULT 'backlog',
  prompt       TEXT,
  diff_summary TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claude_code_sessions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dev_task_id  UUID REFERENCES dev_tasks(id) ON DELETE SET NULL,
  node_id      UUID,
  status       dev_session_status NOT NULL DEFAULT 'starting',
  transport    TEXT NOT NULL DEFAULT 'websocket',
  output       TEXT NOT NULL DEFAULT '',
  metadata     JSONB NOT NULL DEFAULT '{}',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS build_runs (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dev_task_id UUID REFERENCES dev_tasks(id) ON DELETE SET NULL,
  command     TEXT,
  ok          BOOLEAN NOT NULL DEFAULT FALSE,
  output      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dev_task_id UUID REFERENCES dev_tasks(id) ON DELETE SET NULL,
  command     TEXT,
  ok          BOOLEAN NOT NULL DEFAULT FALSE,
  output      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS code_reviews (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dev_task_id UUID REFERENCES dev_tasks(id) ON DELETE SET NULL,
  risk        TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roadmap_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'todo',
  priority    INT NOT NULL DEFAULT 100,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_org_id              ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_status              ON projects(org_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_tasks_project_status     ON dev_tasks(org_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_dev_tasks_created_at         ON dev_tasks(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cc_sessions_project_status   ON claude_code_sessions(org_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_build_runs_task              ON build_runs(org_id, dev_task_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_task               ON test_runs(org_id, dev_task_id);
CREATE INDEX IF NOT EXISTS idx_code_reviews_task            ON code_reviews(org_id, dev_task_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_items_project_status ON roadmap_items(org_id, project_id, status);

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS dev_tasks_updated_at ON dev_tasks;
CREATE TRIGGER dev_tasks_updated_at
  BEFORE UPDATE ON dev_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cc_sessions_updated_at ON claude_code_sessions;
CREATE TRIGGER cc_sessions_updated_at
  BEFORE UPDATE ON claude_code_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS roadmap_items_updated_at ON roadmap_items;
CREATE TRIGGER roadmap_items_updated_at
  BEFORE UPDATE ON roadmap_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
