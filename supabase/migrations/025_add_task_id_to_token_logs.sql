-- 025_add_task_id_to_token_logs.sql
-- Add task_id reference to token_logs table for task-level analytics.

ALTER TABLE token_logs
  ADD COLUMN task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

-- Index for querying token logs by task
CREATE INDEX IF NOT EXISTS token_logs_task_idx
  ON token_logs(task_id);
