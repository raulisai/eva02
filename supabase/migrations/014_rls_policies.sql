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

CREATE POLICY "approvals_delete" ON approvals
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

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

-- ── Communication Hub ─────────────────────────────────────
ALTER TABLE communication_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "communication_channels_select" ON communication_channels
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "communication_channels_insert" ON communication_channels
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "communication_channels_update" ON communication_channels
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "communication_accounts_select" ON communication_accounts
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "communication_accounts_insert" ON communication_accounts
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "communication_accounts_update" ON communication_accounts
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "conversations_select" ON conversations
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "conversations_insert" ON conversations
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "conversations_update" ON conversations
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "messages_select" ON messages
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "messages_insert" ON messages
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "notifications_select" ON notifications
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "notifications_insert" ON notifications
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "notifications_update" ON notifications
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

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

-- ── Skill System ──────────────────────────────────────────
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skills_select" ON skills
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skills_insert" ON skills
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skills_update" ON skills
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_versions_select" ON skill_versions
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "skill_versions_insert" ON skill_versions
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tools_select" ON tools
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tools_insert" ON tools
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tools_update" ON tools
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tool_calls_select" ON tool_calls
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tool_calls_insert" ON tool_calls
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "tool_calls_update" ON tool_calls
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

-- ── Wear Fast Path ────────────────────────────────────────
ALTER TABLE wear_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_fast_path_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fast_path_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wear_sessions_select" ON wear_sessions
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_sessions_insert" ON wear_sessions
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_sessions_update" ON wear_sessions
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_tokens_select" ON wear_tokens
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_tokens_insert" ON wear_tokens
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_tokens_update" ON wear_tokens
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_fast_path_logs_select" ON wear_fast_path_logs
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_fast_path_logs_insert" ON wear_fast_path_logs
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "fast_path_policies_select" ON fast_path_policies
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

CREATE POLICY "fast_path_policies_insert" ON fast_path_policies
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "fast_path_policies_update" ON fast_path_policies
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Agent Intelligence ───────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.agent_trajectories') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE agent_trajectories ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "agent_trajectories_select" ON agent_trajectories';
    EXECUTE 'DROP POLICY IF EXISTS "agent_trajectories_insert" ON agent_trajectories';
    EXECUTE 'DROP POLICY IF EXISTS "agent_trajectories_update" ON agent_trajectories';

    EXECUTE 'CREATE POLICY "agent_trajectories_select" ON agent_trajectories
      FOR SELECT USING (org_id = ANY(public.user_org_ids()))';

    EXECUTE 'CREATE POLICY "agent_trajectories_insert" ON agent_trajectories
      FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()))';

    EXECUTE 'CREATE POLICY "agent_trajectories_update" ON agent_trajectories
      FOR UPDATE
      USING (org_id = ANY(public.user_org_ids()))
      WITH CHECK (org_id = ANY(public.user_org_ids()))';

    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON agent_trajectories TO authenticated';
  END IF;
END $$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'skill_embeddings',
    'agent_input_requests',
    'agent_runtime_artifacts',
    'org_agent_settings'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %I', table_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %I', table_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %I', table_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON %I', table_name, table_name);

      IF table_name = 'org_agent_settings' THEN
        EXECUTE format('CREATE POLICY "%s_select" ON %I FOR SELECT USING (org_id = ANY(public.user_org_ids()))', table_name, table_name);
        EXECUTE format('CREATE POLICY "%s_insert" ON %I FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()))', table_name, table_name);
        EXECUTE format('CREATE POLICY "%s_update" ON %I FOR UPDATE USING (org_id = ANY(public.user_org_ids())) WITH CHECK (org_id = ANY(public.user_org_ids()))', table_name, table_name);
      ELSE
        EXECUTE format('CREATE POLICY "%s_select" ON %I FOR SELECT USING (org_id = ANY(public.user_org_ids()))', table_name, table_name);
        EXECUTE format('CREATE POLICY "%s_insert" ON %I FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()))', table_name, table_name);
        EXECUTE format('CREATE POLICY "%s_update" ON %I FOR UPDATE USING (org_id = ANY(public.user_org_ids())) WITH CHECK (org_id = ANY(public.user_org_ids()))', table_name, table_name);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── Grants: allow authenticated role to access tables via Data API ─────────
GRANT USAGE ON SCHEMA public TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, users, tasks, task_steps, task_events,
  approvals, memories, memory_embeddings, intent_routes,
  communication_channels, communication_accounts, conversations,
  messages, notifications,
  browser_profiles, browser_sessions, browser_action_preparations,
  skills, skill_versions, tools, tool_calls,
  projects, dev_tasks, roadmap_items,
  wear_sessions, wear_tokens, fast_path_policies
TO authenticated;

GRANT SELECT, INSERT ON
  browser_screenshots, build_runs, test_runs, code_reviews,
  wear_fast_path_logs
TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- anon only needs read on organizations (e.g. slug lookup at login)
GRANT SELECT ON organizations TO anon;

GRANT EXECUTE ON FUNCTION public.user_org_ids() TO authenticated;
