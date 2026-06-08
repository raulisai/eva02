-- =========================================================
-- RLS policies — EVERY table filtered by org membership.
-- auth.uid() returns the sub from the current JWT.
--
-- Real table names (remote schema):
--   organizations  (was: orgs)
--   users          (was: org_members) — id = auth.uid()
--   task_events    (was: domain_events)
-- =========================================================

-- Helper: returns all org IDs the current user belongs to
CREATE OR REPLACE FUNCTION public.user_org_ids()
RETURNS UUID[] AS $$
BEGIN
  RETURN COALESCE(
    ARRAY(SELECT org_id FROM public.users WHERE id = auth.uid()),
    ARRAY[]::UUID[]
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ── organizations ─────────────────────────────────────────
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "organizations_select" ON organizations
  FOR SELECT USING (id = ANY(public.user_org_ids()));

CREATE POLICY "organizations_update" ON organizations
  FOR UPDATE
  USING (id = ANY(public.user_org_ids()))
  WITH CHECK (id = ANY(public.user_org_ids()));

-- ── users (org members) ───────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select" ON users
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "users_insert" ON users
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "users_delete" ON users
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── tasks ─────────────────────────────────────────────────
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Drop pre-existing policies to avoid duplicates
DROP POLICY IF EXISTS "org_isolation_select" ON tasks;
DROP POLICY IF EXISTS "org_isolation_mod"    ON tasks;

CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tasks_delete" ON tasks
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── task_steps ────────────────────────────────────────────
ALTER TABLE task_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_steps_select" ON task_steps
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "task_steps_insert" ON task_steps
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── task_events ───────────────────────────────────────────
ALTER TABLE task_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_events_select" ON task_events
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "task_events_insert" ON task_events
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── approvals ─────────────────────────────────────────────
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "approvals_select" ON approvals
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "approvals_insert" ON approvals
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "approvals_update" ON approvals
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── memories ──────────────────────────────────────────────
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memories_select" ON memories
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "memories_insert" ON memories
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "memories_update" ON memories
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "memories_delete" ON memories
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── memory_embeddings ─────────────────────────────────────
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memory_embeddings_select" ON memory_embeddings
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "memory_embeddings_insert" ON memory_embeddings
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "memory_embeddings_delete" ON memory_embeddings
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── intent_routes ─────────────────────────────────────────
ALTER TABLE intent_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "intent_routes_select" ON intent_routes
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "intent_routes_insert" ON intent_routes
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Browser Agent ─────────────────────────────────────────
ALTER TABLE browser_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_action_preparations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "browser_profiles_select" ON browser_profiles
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_profiles_insert" ON browser_profiles
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_profiles_update" ON browser_profiles
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_sessions_select" ON browser_sessions
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_sessions_insert" ON browser_sessions
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_sessions_update" ON browser_sessions
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_screenshots_select" ON browser_screenshots
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_screenshots_insert" ON browser_screenshots
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_preparations_select" ON browser_action_preparations
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_preparations_insert" ON browser_action_preparations
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "browser_preparations_update" ON browser_action_preparations
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── projects ──────────────────────────────────────────────
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_select" ON projects
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "projects_insert" ON projects
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "projects_update" ON projects
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "projects_delete" ON projects
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── dev_tasks ─────────────────────────────────────────────
ALTER TABLE dev_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dev_tasks_select" ON dev_tasks
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "dev_tasks_insert" ON dev_tasks
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "dev_tasks_update" ON dev_tasks
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "dev_tasks_delete" ON dev_tasks
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── build_runs ────────────────────────────────────────────
ALTER TABLE build_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "build_runs_select" ON build_runs
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "build_runs_insert" ON build_runs
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── test_runs ─────────────────────────────────────────────
ALTER TABLE test_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "test_runs_select" ON test_runs
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "test_runs_insert" ON test_runs
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── code_reviews ──────────────────────────────────────────
ALTER TABLE code_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "code_reviews_select" ON code_reviews
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "code_reviews_insert" ON code_reviews
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── roadmap_items ─────────────────────────────────────────
ALTER TABLE roadmap_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "roadmap_items_select" ON roadmap_items
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "roadmap_items_insert" ON roadmap_items
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "roadmap_items_update" ON roadmap_items
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Grants: allow authenticated role to access tables via Data API ─────────
GRANT USAGE ON SCHEMA public TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, users, tasks, task_steps, task_events,
  approvals, memories, memory_embeddings, intent_routes,
  browser_profiles, browser_sessions, browser_action_preparations,
  projects, dev_tasks, roadmap_items
TO authenticated;

GRANT SELECT, INSERT ON
  browser_screenshots, build_runs, test_runs, code_reviews
TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- anon only needs read on organizations (e.g. slug lookup at login)
GRANT SELECT ON organizations TO anon;

GRANT EXECUTE ON FUNCTION public.user_org_ids() TO authenticated;
