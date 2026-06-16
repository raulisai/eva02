-- Alignment migration to resolve schema drift for projects and dev_tasks tables
-- Adds missing columns (metadata, created_by, updated_at) and triggers

-- 1. Align projects table
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS metadata    JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. Align dev_tasks table
ALTER TABLE dev_tasks
  ADD COLUMN IF NOT EXISTS created_by   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS metadata     JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. Triggers for updated_at
DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS dev_tasks_updated_at ON dev_tasks;
CREATE TRIGGER dev_tasks_updated_at
  BEFORE UPDATE ON dev_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Reload schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
