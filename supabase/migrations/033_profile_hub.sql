-- 033_profile_hub.sql
-- Structured user-owned Profile Hub: todos, notes, goals, suggestions and
-- encrypted private vault hints. Every row is org-scoped.

CREATE TABLE IF NOT EXISTS profile_todos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','in_progress','done')),
  due_date         DATE,
  priority         INT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','eva','digester','import')),
  confidence       REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  evidence_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  position         INT NOT NULL DEFAULT 0,
  sensitivity      TEXT NOT NULL DEFAULT 'normal'
                     CHECK (sensitivity IN ('normal','personal','sensitive')),
  sensitive_hint   TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT,
  content          TEXT NOT NULL,
  color            TEXT NOT NULL DEFAULT 'slate',
  pinned           BOOLEAN NOT NULL DEFAULT false,
  position         JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_visible    BOOLEAN NOT NULL DEFAULT true,
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','eva','digester','import')),
  confidence       REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  evidence_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  sensitivity      TEXT NOT NULL DEFAULT 'normal'
                     CHECK (sensitivity IN ('normal','personal','sensitive')),
  sensitive_hint   TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_goals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','paused','dropped')),
  deadline         DATE,
  progress         INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  category         TEXT,
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','eva','digester','import')),
  confidence       REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  evidence_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  sensitivity      TEXT NOT NULL DEFAULT 'normal'
                     CHECK (sensitivity IN ('normal','personal','sensitive')),
  sensitive_hint   TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_private_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'note',
  label            TEXT NOT NULL,
  ciphertext       TEXT NOT NULL,
  hint             TEXT NOT NULL,
  sensitivity      TEXT NOT NULL DEFAULT 'sensitive'
                     CHECK (sensitivity IN ('personal','sensitive')),
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','eva','digester','import')),
  evidence_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_suggestions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fact_type        TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  evidence_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','accepted','dismissed')),
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_private_access_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  private_item_id UUID NOT NULL REFERENCES profile_private_items(id) ON DELETE CASCADE,
  revealed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profile_todos_org_status
  ON profile_todos(org_id, status, due_date NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_profile_notes_org_pinned
  ON profile_notes(org_id, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_goals_org_status
  ON profile_goals(org_id, status, deadline NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_profile_private_items_org
  ON profile_private_items(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_suggestions_org_status
  ON profile_suggestions(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_private_access_logs_org_item
  ON profile_private_access_logs(org_id, private_item_id, created_at DESC);

DROP TRIGGER IF EXISTS profile_todos_updated_at ON profile_todos;
CREATE TRIGGER profile_todos_updated_at
  BEFORE UPDATE ON profile_todos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS profile_notes_updated_at ON profile_notes;
CREATE TRIGGER profile_notes_updated_at
  BEFORE UPDATE ON profile_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS profile_goals_updated_at ON profile_goals;
CREATE TRIGGER profile_goals_updated_at
  BEFORE UPDATE ON profile_goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS profile_private_items_updated_at ON profile_private_items;
CREATE TRIGGER profile_private_items_updated_at
  BEFORE UPDATE ON profile_private_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS profile_suggestions_updated_at ON profile_suggestions;
CREATE TRIGGER profile_suggestions_updated_at
  BEFORE UPDATE ON profile_suggestions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backfill legacy soul goals into the structured table once per org.
INSERT INTO profile_goals (
  org_id, title, description, status, deadline, progress, source, confidence, created_at
)
SELECT
  s.org_id,
  COALESCE(g.value->>'title', 'Meta importada'),
  g.value->>'description',
  CASE
    WHEN g.value->>'status' IN ('active','completed','paused','dropped') THEN g.value->>'status'
    ELSE 'active'
  END,
  NULLIF(g.value->>'deadline', '')::date,
  LEAST(100, GREATEST(0, COALESCE(NULLIF(regexp_replace(COALESCE(g.value->>'progress', '0'), '[^0-9]', '', 'g'), '')::int, 0))),
  'import',
  0.8,
  COALESCE(NULLIF(g.value->>'created_at', '')::timestamptz, now())
FROM agent_souls s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.goals, '[]'::jsonb)) AS g(value)
WHERE NOT EXISTS (
  SELECT 1 FROM profile_goals existing WHERE existing.org_id = s.org_id
);

ALTER TABLE profile_todos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_notes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_goals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_private_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_suggestions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_private_access_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profile_todos_org" ON profile_todos
  FOR ALL TO authenticated
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "profile_notes_org" ON profile_notes
  FOR ALL TO authenticated
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "profile_goals_org" ON profile_goals
  FOR ALL TO authenticated
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "profile_private_items_org" ON profile_private_items
  FOR SELECT TO authenticated
  USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "profile_suggestions_org" ON profile_suggestions
  FOR ALL TO authenticated
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "profile_private_access_logs_org" ON profile_private_access_logs
  FOR SELECT TO authenticated
  USING (org_id = ANY(public.user_org_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_todos       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile_notes       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile_goals       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile_suggestions TO authenticated;

GRANT SELECT (
  id, org_id, kind, label, hint, sensitivity, source, evidence_task_id,
  created_by, created_at, updated_at
) ON profile_private_items TO authenticated;

GRANT SELECT (
  id, org_id, private_item_id, revealed_by, reason, created_at
) ON profile_private_access_logs TO authenticated;
