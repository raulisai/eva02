-- Agent data log: persistent key-value time-series store for long-running monitoring tasks.
-- Used by the data_log tool so jobs accumulate observations between runs (stock prices,
-- file hashes, URL status, etc.) and a later aggregate job can read the history.

CREATE TABLE IF NOT EXISTS agent_data_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL,
  key         text        NOT NULL,          -- e.g. "stock:GOOGL" or "file:invoice.pdf"
  value       text        NOT NULL,          -- JSON string or plain text
  recorded_at timestamptz NOT NULL DEFAULT now(),
  job_id      text,                          -- optional link to scheduled_job
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Fast range queries: "give me all GOOGL entries from last 30 days"
CREATE INDEX IF NOT EXISTS agent_data_log_org_key_recorded
  ON agent_data_log (org_id, key, recorded_at DESC);

ALTER TABLE agent_data_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_data_log_org_isolation" ON agent_data_log
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));
