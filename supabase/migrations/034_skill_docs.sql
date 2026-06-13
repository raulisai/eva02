-- Skill Docs: Procedural Memory System (Hermes-parity)
-- Adds markdown-based skill documents (SKILL.md pattern) alongside existing
-- executable code skills. Each org accumulates a skill library that is
-- injected as a compact index into every agent-loop system prompt.

-- ── Extend skills table ────────────────────────────────────────────────────

-- content_md: the SKILL.md body — procedural knowledge the agent writes and reads.
-- category:   slug for grouping in the skills index (e.g. 'coding', 'research').
-- is_pinned:  protected from auto-deletion/archiving by the background curator.
-- kind:       'code' = existing executable skill | 'doc' = markdown runbook.
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS content_md  TEXT,
  ADD COLUMN IF NOT EXISTS category    TEXT,
  ADD COLUMN IF NOT EXISTS is_pinned   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS kind        TEXT NOT NULL DEFAULT 'code'
    CHECK (kind IN ('code', 'doc'));

-- Allow content_md to be searched and indexed
CREATE INDEX IF NOT EXISTS idx_skills_org_kind      ON skills(org_id, kind);
CREATE INDEX IF NOT EXISTS idx_skills_org_category  ON skills(org_id, category);
CREATE INDEX IF NOT EXISTS idx_skills_org_pinned    ON skills(org_id, is_pinned) WHERE is_pinned = TRUE;

-- ── skill_files: support files for doc-type skills ─────────────────────────
-- Mirrors Hermes' references/, templates/, scripts/, assets/ subdirectories.
-- The agent writes these via skill_manage(action='write_file').

CREATE TABLE IF NOT EXISTS skill_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  subdir      TEXT NOT NULL CHECK (subdir IN ('references', 'templates', 'scripts', 'assets')),
  filename    TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  size_bytes  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, skill_id, subdir, filename)
);

CREATE INDEX IF NOT EXISTS idx_skill_files_skill   ON skill_files(org_id, skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_files_subdir  ON skill_files(org_id, skill_id, subdir);

DROP TRIGGER IF EXISTS skill_files_updated_at ON skill_files;
CREATE TRIGGER skill_files_updated_at
  BEFORE UPDATE ON skill_files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS policies ───────────────────────────────────────────────────────────

ALTER TABLE skill_files ENABLE ROW LEVEL SECURITY;

-- Service role (backend) has full access
CREATE POLICY "service_role_all_skill_files"
  ON skill_files FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can read/write their own org's skill files
CREATE POLICY "org_members_select_skill_files"
  ON skill_files FOR SELECT
  TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "org_members_insert_skill_files"
  ON skill_files FOR INSERT
  TO authenticated
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "org_members_update_skill_files"
  ON skill_files FOR UPDATE
  TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

CREATE POLICY "org_members_delete_skill_files"
  ON skill_files FOR DELETE
  TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

-- ── Seed bundled doc-skills index ─────────────────────────────────────────
-- Bundled skills already have entries in bundled-skills.catalog.ts;
-- this migration does NOT duplicate them — the SkillLibraryService
-- merges catalog + DB when building the index. No seed data needed here.
