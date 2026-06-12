-- Skill catalog learning + graph intelligence.
-- Tenant scoped by org_id. No production/data action is performed here.

CREATE TABLE IF NOT EXISTS skill_usage_stats (
  org_id            UUID NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('bundled', 'generated')),
  skill_slug        TEXT NOT NULL,
  context_key       TEXT NOT NULL DEFAULT '__global__',
  attempts          INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  successes         INT NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures          INT NOT NULL DEFAULT 0 CHECK (failures >= 0),
  positive_feedback INT NOT NULL DEFAULT 0 CHECK (positive_feedback >= 0),
  negative_feedback INT NOT NULL DEFAULT 0 CHECK (negative_feedback >= 0),
  active_runs       INT NOT NULL DEFAULT 0 CHECK (active_runs >= 0),
  avg_score         NUMERIC(8, 4),
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, source, skill_slug, context_key)
);

CREATE TABLE IF NOT EXISTS skill_graph_edges (
  org_id             UUID NOT NULL,
  from_skill_slug    TEXT NOT NULL,
  to_skill_slug      TEXT NOT NULL,
  relation           TEXT NOT NULL DEFAULT 'co_selected'
                       CHECK (relation IN ('supports', 'precedes', 'validates', 'fallback', 'co_selected')),
  weight             NUMERIC(8, 4) NOT NULL DEFAULT 0,
  evidence_count     INT NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  metadata           JSONB NOT NULL DEFAULT '{}',
  last_reinforced_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, from_skill_slug, to_skill_slug, relation)
);

CREATE TABLE IF NOT EXISTS skill_selection_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  task_id        UUID REFERENCES tasks(id) ON DELETE SET NULL,
  skill_slug     TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('bundled', 'generated')),
  context_key    TEXT NOT NULL DEFAULT '__global__',
  selected_score NUMERIC(8, 4) NOT NULL DEFAULT 0,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'skipped')),
  tools_used     JSONB NOT NULL DEFAULT '[]',
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_stats_org_context
  ON skill_usage_stats(org_id, context_key, source);

CREATE INDEX IF NOT EXISTS idx_skill_graph_edges_to
  ON skill_graph_edges(org_id, to_skill_slug, relation);

CREATE INDEX IF NOT EXISTS idx_skill_selection_events_task
  ON skill_selection_events(org_id, task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_selection_events_skill
  ON skill_selection_events(org_id, skill_slug, source, created_at DESC);

DROP TRIGGER IF EXISTS skill_usage_stats_updated_at ON skill_usage_stats;
CREATE TRIGGER skill_usage_stats_updated_at
  BEFORE UPDATE ON skill_usage_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS skill_graph_edges_updated_at ON skill_graph_edges;
CREATE TRIGGER skill_graph_edges_updated_at
  BEFORE UPDATE ON skill_graph_edges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE skill_usage_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_selection_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_usage_stats_select" ON skill_usage_stats
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_usage_stats_insert" ON skill_usage_stats
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_usage_stats_update" ON skill_usage_stats
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_graph_edges_select" ON skill_graph_edges
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_graph_edges_insert" ON skill_graph_edges
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_graph_edges_update" ON skill_graph_edges
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_selection_events_select" ON skill_selection_events
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_selection_events_insert" ON skill_selection_events
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

GRANT SELECT, INSERT, UPDATE ON skill_usage_stats, skill_graph_edges TO authenticated;
GRANT SELECT, INSERT ON skill_selection_events TO authenticated;
