-- 032_agent_tier_step_settings.sql
-- Org-level controls for agent loop step budgets by planning tier.

ALTER TABLE org_agent_settings
  ADD COLUMN IF NOT EXISTS max_steps_by_tier JSONB NOT NULL DEFAULT '{"chat":2,"quick":4,"medium":4,"long":8}'::jsonb;

COMMENT ON COLUMN org_agent_settings.max_steps_by_tier IS
  'JSON object controlling agent-loop step budgets by tier: chat, quick, medium, long. Runtime clamps values to safe bounds.';
