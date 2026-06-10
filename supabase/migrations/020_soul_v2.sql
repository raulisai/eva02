-- 020_soul_v2.sql
-- Adds structured personal context to agent_souls so EVA can hold:
--   • goals[]        — active/completed goals with deadlines and progress
--   • persona_context — identity, occupation, expectations, routines (JSONB)
--   • session_date index on memories for fast daily-digest queries
--
-- No breaking changes: model_prefs stays; new columns are additive.

-- ── agent_souls: new columns ─────────────────────────────────────────────────
ALTER TABLE agent_souls
  ADD COLUMN IF NOT EXISTS goals           JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS persona_context JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN agent_souls.goals IS
  'Array of Goal objects: {id, title, status, deadline?, progress?, created_at}';

COMMENT ON COLUMN agent_souls.persona_context IS
  'Rich identity layer: occupation, bio, expectations, routines, relationships, preferences';

-- ── memories: add metadata column for rich episodic context ─────────────────
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── memories: index for session-digest queries ───────────────────────────────
-- Allows fast lookup of episodic memories by session date stored in metadata.
-- Note: live table uses `kind` (text) instead of `memory_type` enum.
CREATE INDEX IF NOT EXISTS idx_memories_session_date
  ON memories ((metadata ->> 'session_date'))
  WHERE kind = 'episodic' AND (metadata ->> 'session_date') IS NOT NULL;

-- ── RLS: new columns inherit table-level policies (no changes needed) ────────
-- The agent_souls policies in 014/016 already cover INSERT/SELECT/UPDATE.
-- Service role has full access; authenticated role can read/write via existing policies.
