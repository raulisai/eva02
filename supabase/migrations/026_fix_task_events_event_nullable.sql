-- 026_fix_task_events_event_nullable.sql
-- Alter the legacy event column of task_events to be nullable.
-- This ensures that new event persistence queries (which only populate event_type and payload) do not fail.

ALTER TABLE task_events
  ALTER COLUMN event DROP NOT NULL;
