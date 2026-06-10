-- =========================================================
-- Memory store: episodic/semantic/procedural/working memory
-- Embeddings via pgvector(1536) with cosine similarity search
-- =========================================================

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE memory_type AS ENUM ('episodic', 'semantic', 'procedural', 'working');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Core memory records
CREATE TABLE IF NOT EXISTS memories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id    TEXT,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  summary     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  memory_type memory_type NOT NULL DEFAULT 'episodic',
  metadata    JSONB NOT NULL DEFAULT '{}',
  accessed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_org_id     ON memories(org_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent_id   ON memories(org_id, agent_id)       WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(org_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type       ON memories(org_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created    ON memories(org_id, created_at DESC);

DROP TRIGGER IF EXISTS memories_updated_at ON memories;
CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Vector embeddings (one per memory × model)
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  org_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model     TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(memory_id, model)
);

-- IVFFlat index for ANN cosine similarity (suitable up to ~1 M rows per list)
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_vector
  ON memory_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_org ON memory_embeddings(org_id);

-- ── Semantic search function ──────────────────────────────────────────────
-- Returns top-k memories for an org ordered by cosine similarity.
-- Uses SECURITY INVOKER so RLS on memories/memory_embeddings still applies.
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding  vector(1536),
  match_org_id     UUID,
  match_count      INT  DEFAULT 5,
  match_threshold  REAL DEFAULT 0.70
) RETURNS TABLE (
  id          UUID,
  org_id      UUID,
  agent_id    TEXT,
  task_id     UUID,
  content     TEXT,
  summary     TEXT,
  importance  REAL,
  memory_type TEXT,
  metadata    JSONB,
  similarity  REAL,
  created_at  TIMESTAMPTZ
) LANGUAGE SQL STABLE SECURITY INVOKER AS $$
  SELECT
    m.id,
    m.org_id,
    m.agent_id,
    m.task_id,
    m.content,
    m.summary,
    m.importance,
    m.memory_type::TEXT,
    m.metadata,
    (1.0 - (me.embedding <=> query_embedding))::REAL AS similarity,
    m.created_at
  FROM memory_embeddings me
  JOIN memories m ON m.id = me.memory_id
  WHERE m.org_id = match_org_id
    AND (1.0 - (me.embedding <=> query_embedding)) >= match_threshold
  ORDER BY me.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Revoke public execute (only authenticated roles should call this)
REVOKE EXECUTE ON FUNCTION match_memories FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION match_memories TO authenticated, service_role;
