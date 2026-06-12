-- 031_soul_private_context.sql
-- Separates user-owned personal context from agent/model preferences and adds
-- an encrypted private context block that is only decrypted by eva-core.

ALTER TABLE agent_souls
  ADD COLUMN IF NOT EXISTS private_context_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS private_context_hint TEXT;

COMMENT ON COLUMN agent_souls.persona_context IS
  'User-owned profile/context JSON: personal_profile, cowork_context, relationship_map, expectations, routines, preferences';

COMMENT ON COLUMN agent_souls.private_context_ciphertext IS
  'AES-256-GCM ciphertext written only by eva-core; plaintext is injected server-side for model context and never returned by Data API';

COMMENT ON COLUMN agent_souls.private_context_hint IS
  'Safe display hint for encrypted private context; never contains plaintext secrets or personal details';

-- Tighten Data API grants so encrypted private context behaves like model keys.
-- RLS still limits rows by org_id; column grants limit readable columns.
REVOKE SELECT, INSERT, UPDATE ON agent_souls FROM authenticated;

GRANT SELECT (
  id, org_id, name, persona, directives, autonomy_level, model_prefs, goals,
  persona_context, private_context_hint, created_at, updated_at
) ON agent_souls TO authenticated;

GRANT INSERT (
  org_id, name, persona, directives, autonomy_level, model_prefs, goals,
  persona_context
) ON agent_souls TO authenticated;

GRANT UPDATE (
  name, persona, directives, autonomy_level, model_prefs, goals,
  persona_context
) ON agent_souls TO authenticated;
