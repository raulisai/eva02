-- Migration to add model column and unique constraint to memory_embeddings
-- 1. Add model column with default value
ALTER TABLE memory_embeddings
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'text-embedding-3-small';

-- 2. Add UNIQUE constraint to prevent duplicate embeddings for the same memory and model
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_embeddings_memory_id_model_key'
  ) THEN
    ALTER TABLE memory_embeddings
      ADD CONSTRAINT memory_embeddings_memory_id_model_key UNIQUE (memory_id, model);
  END IF;
END $$;

-- 3. Reload schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
