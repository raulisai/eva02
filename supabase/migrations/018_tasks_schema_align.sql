-- Add columns that the application code expects but are missing from the live table.
-- All additions are non-destructive; existing columns (user_id, type, payload, etc.) are kept.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS created_by    UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS title         TEXT,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS metadata      JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error         TEXT;

-- Back-fill created_by from user_id for any existing rows
UPDATE tasks SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;

-- Reload PostgREST schema cache so the new columns are visible immediately
NOTIFY pgrst, 'reload schema';
