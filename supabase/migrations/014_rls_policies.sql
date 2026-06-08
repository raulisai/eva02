-- =========================================================
-- RLS policies — EVERY table filtered by org membership.
-- auth.uid() returns the sub from the current JWT.
-- =========================================================

-- Helper: returns all org IDs the current user belongs to
CREATE OR REPLACE FUNCTION auth.user_org_ids()
RETURNS UUID[] AS $$
  SELECT COALESCE(
    ARRAY(SELECT org_id FROM org_members WHERE user_id = auth.uid()),
    ARRAY[]::UUID[]
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ── orgs ──────────────────────────────────────────────────
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orgs_select" ON orgs
  FOR SELECT USING (id = ANY(auth.user_org_ids()));

-- ── org_members ───────────────────────────────────────────
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_select" ON org_members
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

-- ── tasks ─────────────────────────────────────────────────
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "tasks_delete" ON tasks
  FOR DELETE USING (org_id = ANY(auth.user_org_ids()));

-- ── domain_events ─────────────────────────────────────────
ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "events_select" ON domain_events
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "events_insert" ON domain_events
  FOR INSERT WITH CHECK (org_id = ANY(auth.user_org_ids()));

-- ── approvals ─────────────────────────────────────────────
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "approvals_select" ON approvals
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "approvals_insert" ON approvals
  FOR INSERT WITH CHECK (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "approvals_update" ON approvals
  FOR UPDATE USING (org_id = ANY(auth.user_org_ids()));

-- ── memories ──────────────────────────────────────────────
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memories_select" ON memories
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "memories_insert" ON memories
  FOR INSERT WITH CHECK (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "memories_update" ON memories
  FOR UPDATE
  USING (org_id = ANY(auth.user_org_ids()))
  WITH CHECK (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "memories_delete" ON memories
  FOR DELETE USING (org_id = ANY(auth.user_org_ids()));

-- ── memory_embeddings ─────────────────────────────────────
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_embeddings_select" ON memory_embeddings
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "memory_embeddings_insert" ON memory_embeddings
  FOR INSERT WITH CHECK (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "memory_embeddings_delete" ON memory_embeddings
  FOR DELETE USING (org_id = ANY(auth.user_org_ids()));

-- ── intent_routes ─────────────────────────────────────────
ALTER TABLE intent_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "intent_routes_select" ON intent_routes
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));

CREATE POLICY "intent_routes_insert" ON intent_routes
  FOR INSERT WITH CHECK (org_id = ANY(auth.user_org_ids()));
