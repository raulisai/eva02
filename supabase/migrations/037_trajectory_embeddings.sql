-- Add semantic embedding to agent_trajectories for similarity-based replay.
-- Replaces the O(N) lexical Jaccard scan with a pgvector cosine search.
-- Column is nullable so existing rows and the checkpoint writes are unaffected
-- until the completion path starts writing embeddings.

ALTER TABLE agent_trajectories
  ADD COLUMN IF NOT EXISTS goal_embedding vector(1536);

-- IVFFlat index — cosine distance.  lists=50 is appropriate for the expected
-- row count per org (typically < 10 k rows before truncation kicks in).
CREATE INDEX IF NOT EXISTS idx_agent_trajectories_embedding
  ON agent_trajectories USING ivfflat (goal_embedding vector_cosine_ops)
  WITH (lists = 50);

-- RPC used by AgentIntelligenceService.replayExample / replayFailureExample.
-- Returns trajectories with cosine similarity >= p_threshold, ordered by score desc.
CREATE OR REPLACE FUNCTION match_trajectories(
  p_org_id    UUID,
  p_embedding vector(1536),
  p_outcome   TEXT,
  p_limit     INT     DEFAULT 5,
  p_threshold FLOAT   DEFAULT 0.72
)
RETURNS TABLE (
  id          UUID,
  goal        TEXT,
  steps       JSONB,
  tools_used  TEXT[],
  outcome     TEXT,
  similarity  FLOAT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    id,
    goal,
    steps,
    tools_used,
    outcome,
    1 - (goal_embedding <=> p_embedding) AS similarity
  FROM agent_trajectories
  WHERE org_id      = p_org_id
    AND outcome     = p_outcome
    AND goal_embedding IS NOT NULL
    AND 1 - (goal_embedding <=> p_embedding) >= p_threshold
  ORDER BY goal_embedding <=> p_embedding
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION match_trajectories TO authenticated, service_role;
