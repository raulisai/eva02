-- 019_fix_missing_rls_and_grants.sql
-- Recuperado de Supabase (versión 20260609011304).
-- Corrige la ejecución parcial de 014: browser RLS deshabilitado,
-- políticas de wear/communication/skills nunca creadas,
-- GRANTs fallidos porque las tablas communication/skills no existían aún.

-- ── approvals: missing delete policy ────────────────────
DROP POLICY IF EXISTS "approvals_delete" ON approvals;
CREATE POLICY "approvals_delete" ON approvals
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

-- ── Browser Agent (RLS was disabled) ────────────────────
ALTER TABLE browser_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_action_preparations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "browser_profiles_select" ON browser_profiles;
CREATE POLICY "browser_profiles_select" ON browser_profiles
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_profiles_insert" ON browser_profiles;
CREATE POLICY "browser_profiles_insert" ON browser_profiles
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_profiles_update" ON browser_profiles;
CREATE POLICY "browser_profiles_update" ON browser_profiles
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_sessions_select" ON browser_sessions;
CREATE POLICY "browser_sessions_select" ON browser_sessions
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_sessions_insert" ON browser_sessions;
CREATE POLICY "browser_sessions_insert" ON browser_sessions
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_sessions_update" ON browser_sessions;
CREATE POLICY "browser_sessions_update" ON browser_sessions
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_screenshots_select" ON browser_screenshots;
CREATE POLICY "browser_screenshots_select" ON browser_screenshots
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_screenshots_insert" ON browser_screenshots;
CREATE POLICY "browser_screenshots_insert" ON browser_screenshots
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_preparations_select" ON browser_action_preparations;
CREATE POLICY "browser_preparations_select" ON browser_action_preparations
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_preparations_insert" ON browser_action_preparations;
CREATE POLICY "browser_preparations_insert" ON browser_action_preparations
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "browser_preparations_update" ON browser_action_preparations;
CREATE POLICY "browser_preparations_update" ON browser_action_preparations
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Communication Hub ────────────────────────────────────
ALTER TABLE communication_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "communication_channels_select" ON communication_channels;
CREATE POLICY "communication_channels_select" ON communication_channels
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "communication_channels_insert" ON communication_channels;
CREATE POLICY "communication_channels_insert" ON communication_channels
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "communication_channels_update" ON communication_channels;
CREATE POLICY "communication_channels_update" ON communication_channels
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "communication_accounts_select" ON communication_accounts;
CREATE POLICY "communication_accounts_select" ON communication_accounts
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "communication_accounts_insert" ON communication_accounts;
CREATE POLICY "communication_accounts_insert" ON communication_accounts
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "communication_accounts_update" ON communication_accounts;
CREATE POLICY "communication_accounts_update" ON communication_accounts
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "conversations_select" ON conversations;
CREATE POLICY "conversations_select" ON conversations
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "conversations_insert" ON conversations;
CREATE POLICY "conversations_insert" ON conversations
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "conversations_update" ON conversations;
CREATE POLICY "conversations_update" ON conversations
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "messages_select" ON messages;
CREATE POLICY "messages_select" ON messages
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "messages_insert" ON messages;
CREATE POLICY "messages_insert" ON messages
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "notifications_select" ON notifications;
CREATE POLICY "notifications_select" ON notifications
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "notifications_insert" ON notifications;
CREATE POLICY "notifications_insert" ON notifications
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "notifications_update" ON notifications;
CREATE POLICY "notifications_update" ON notifications
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Skill System ─────────────────────────────────────────
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "skills_select" ON skills;
CREATE POLICY "skills_select" ON skills
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "skills_insert" ON skills;
CREATE POLICY "skills_insert" ON skills
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "skills_update" ON skills;
CREATE POLICY "skills_update" ON skills
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "skill_versions_select" ON skill_versions;
CREATE POLICY "skill_versions_select" ON skill_versions
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "skill_versions_insert" ON skill_versions;
CREATE POLICY "skill_versions_insert" ON skill_versions
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "tools_select" ON tools;
CREATE POLICY "tools_select" ON tools
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "tools_insert" ON tools;
CREATE POLICY "tools_insert" ON tools
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "tools_update" ON tools;
CREATE POLICY "tools_update" ON tools
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "tool_calls_select" ON tool_calls;
CREATE POLICY "tool_calls_select" ON tool_calls
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "tool_calls_insert" ON tool_calls;
CREATE POLICY "tool_calls_insert" ON tool_calls
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "tool_calls_update" ON tool_calls;
CREATE POLICY "tool_calls_update" ON tool_calls
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Wear Fast Path (RLS enabled, policies missing) ───────
ALTER TABLE wear_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_fast_path_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fast_path_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wear_sessions_select" ON wear_sessions;
CREATE POLICY "wear_sessions_select" ON wear_sessions
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_sessions_insert" ON wear_sessions;
CREATE POLICY "wear_sessions_insert" ON wear_sessions
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_sessions_update" ON wear_sessions;
CREATE POLICY "wear_sessions_update" ON wear_sessions
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_tokens_select" ON wear_tokens;
CREATE POLICY "wear_tokens_select" ON wear_tokens
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_tokens_insert" ON wear_tokens;
CREATE POLICY "wear_tokens_insert" ON wear_tokens
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_tokens_update" ON wear_tokens;
CREATE POLICY "wear_tokens_update" ON wear_tokens
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_fast_path_logs_select" ON wear_fast_path_logs;
CREATE POLICY "wear_fast_path_logs_select" ON wear_fast_path_logs
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "wear_fast_path_logs_insert" ON wear_fast_path_logs;
CREATE POLICY "wear_fast_path_logs_insert" ON wear_fast_path_logs
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "fast_path_policies_select" ON fast_path_policies;
CREATE POLICY "fast_path_policies_select" ON fast_path_policies
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "fast_path_policies_insert" ON fast_path_policies;
CREATE POLICY "fast_path_policies_insert" ON fast_path_policies
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "fast_path_policies_update" ON fast_path_policies;
CREATE POLICY "fast_path_policies_update" ON fast_path_policies
  FOR UPDATE
  USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── GRANTs (re-run now that all tables exist) ─────────────
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

GRANT SELECT ON organizations TO anon;

GRANT EXECUTE ON FUNCTION public.user_org_ids() TO authenticated;
