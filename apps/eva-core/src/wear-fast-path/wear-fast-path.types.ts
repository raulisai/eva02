export const WEAR_FAST_PATH_SCOPE = 'wear_fast_path' as const;
export const WEAR_TOKEN_TTL_SECONDS = 300;
export const WEAR_MAX_TOKENS = 500;
export const WEAR_DEFAULT_MODEL = 'gpt-realtime';

export type FastPathDecision = 'fast_path' | 'core_fallback';

export interface WearTokenRecord {
  id: string;
  org_id: string;
  user_id: string;
  device_id: string;
  session_id: string | null;
  scope: typeof WEAR_FAST_PATH_SCOPE;
  model: string;
  max_tokens: number;
  token_hash: string;
  realtime_session_id: string | null;
  realtime_expires_at: string | null;
  tools: string[];
  memory_access: boolean;
  actions_allowed: boolean;
  used: boolean;
  expires_at: string;
  created_at: string;
}

export interface WearSessionRecord {
  id: string;
  org_id: string;
  user_id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface FastPathPolicy {
  id: string;
  org_id: string;
  allowed: string[];
  disallowed: string[];
  per_session_limit: number;
  per_day_limit: number;
  per_session_cost_limit_usd: number;
  per_day_cost_limit_usd: number;
  created_at: string;
  updated_at: string;
}

export interface FastPathUsageLog {
  id: number;
  org_id: string;
  user_id: string;
  device_id: string;
  session_id: string | null;
  request_type: string;
  model: string;
  latency_ms: number;
  tokens_used: number;
  cost_usd: number;
  fell_back: boolean;
  fallback_reason: string | null;
  created_at: string;
}

export interface RealtimeEphemeralKey {
  value: string;
  expiresAt: number;
  sessionId: string | null;
}

export interface FastPathEvaluation {
  allowed: boolean;
  reason: string;
}

export interface FastPathTotals {
  sessionCostUsd: number;
  dayCostUsd: number;
  sessionTokens: number;
  dayTokens: number;
}

export const DEFAULT_FAST_PATH_ALLOWED = [
  'short_conversation',
  'translation',
  'simple_summary',
  'rewrite',
  'suggested_reply',
  'brief_explanation',
  'quick_tts',
  'simple_question',
];

export const DEFAULT_FAST_PATH_DISALLOWED = [
  'uber',
  'purchase',
  'send_money',
  'personal_browser',
  'whatsapp_web',
  'gmail_full',
  'claude_code',
  'execute_command',
  'deploy',
  'secret_access',
  'database_write',
  'permanent_memory',
];

export const DEFAULT_FAST_PATH_POLICY: Omit<FastPathPolicy, 'id' | 'org_id' | 'created_at' | 'updated_at'> = {
  allowed: DEFAULT_FAST_PATH_ALLOWED,
  disallowed: DEFAULT_FAST_PATH_DISALLOWED,
  per_session_limit: 500,
  per_day_limit: 2_000,
  per_session_cost_limit_usd: 0.05,
  per_day_cost_limit_usd: 0.25,
};
