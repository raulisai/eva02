-- 011_wear_fast_path.sql
-- Wear OS Fast Path: ephemeral tokens, sessions, policy, and usage logs.

CREATE TABLE IF NOT EXISTS wear_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wear_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id UUID REFERENCES wear_sessions(id) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'wear_fast_path',
  model TEXT NOT NULL DEFAULT 'gpt-realtime',
  max_tokens INT NOT NULL DEFAULT 500,
  token_hash TEXT NOT NULL,
  realtime_session_id TEXT,
  realtime_expires_at TIMESTAMPTZ,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  memory_access BOOLEAN NOT NULL DEFAULT false,
  actions_allowed BOOLEAN NOT NULL DEFAULT false,
  used BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wear_tokens_scope_check CHECK (scope = 'wear_fast_path'),
  CONSTRAINT wear_tokens_max_tokens_check CHECK (max_tokens <= 500),
  CONSTRAINT wear_tokens_no_tools_check CHECK (jsonb_array_length(tools) = 0),
  CONSTRAINT wear_tokens_no_memory_check CHECK (memory_access = false),
  CONSTRAINT wear_tokens_no_actions_check CHECK (actions_allowed = false)
);

CREATE TABLE IF NOT EXISTS wear_fast_path_logs (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id UUID REFERENCES wear_sessions(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL,
  model TEXT NOT NULL,
  latency_ms INT NOT NULL DEFAULT 0,
  tokens_used INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0,
  fell_back BOOLEAN NOT NULL DEFAULT false,
  fallback_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fast_path_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,
  allowed JSONB NOT NULL DEFAULT '[
    "short_conversation",
    "translation",
    "simple_summary",
    "rewrite",
    "suggested_reply",
    "brief_explanation",
    "quick_tts",
    "simple_question"
  ]'::jsonb,
  disallowed JSONB NOT NULL DEFAULT '[
    "uber",
    "purchase",
    "send_money",
    "personal_browser",
    "whatsapp_web",
    "gmail_full",
    "claude_code",
    "execute_command",
    "deploy",
    "secret_access",
    "database_write",
    "permanent_memory"
  ]'::jsonb,
  per_session_limit INT NOT NULL DEFAULT 500,
  per_day_limit INT NOT NULL DEFAULT 2000,
  per_session_cost_limit_usd NUMERIC(12, 8) NOT NULL DEFAULT 0.05,
  per_day_cost_limit_usd NUMERIC(12, 8) NOT NULL DEFAULT 0.25,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wear_sessions_org_device_idx
  ON wear_sessions(org_id, device_id, started_at DESC);

CREATE INDEX IF NOT EXISTS wear_tokens_org_device_expires_idx
  ON wear_tokens(org_id, device_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS wear_fast_path_logs_org_device_created_idx
  ON wear_fast_path_logs(org_id, device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wear_fast_path_logs_org_session_idx
  ON wear_fast_path_logs(org_id, session_id, created_at DESC);
