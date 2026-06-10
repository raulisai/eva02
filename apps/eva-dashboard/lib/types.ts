export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: string;
  org_id: string;
  created_by: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  metadata: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NodeInfo {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'offline';
  last_seen: string;
  current_task_id: string | null;
  cpu_pct: number;
  mem_pct: number;
  version: string;
}

export interface EvaEvent {
  id?: string;
  type: string;
  orgId: string;
  taskId?: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface Approval {
  id: string;
  org_id: string;
  task_id: string | null;
  level: 0 | 1 | 2 | 3;
  action_type: string;
  action_hash: string;
  nonce: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  payload: Record<string, unknown>;
  summary: string | null;
  screenshot_ref: string | null;
  source: 'core_path' | 'fast_path' | 'browser' | 'dev_manager' | 'system';
  requested_by: string;
  reviewed_by: string | null;
  reviewed_by_2: string | null;
  reviewed_at: string | null;
  nonce_used_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface ApprovalScreenshot {
  id: string;
  image_base64: string;
  mime_type: string;
}

export type IntegrationKind = 'model' | 'channel' | 'credential';
export type IntegrationStatus = 'active' | 'disabled' | 'error';

/** Masked view returned by eva-core / readable columns in Supabase. */
export interface Integration {
  id: string;
  kind: IntegrationKind;
  provider: string;
  label: string | null;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  secret_hint: string | null;
  has_secret?: boolean;
  updated_at: string;
}

export interface McpConnection {
  id: string;
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  endpoint: string;
  enabled: boolean;
  status: 'disconnected' | 'connected' | 'error';
  tools: Array<Record<string, unknown>>;
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface Artifact {
  id: string;
  org_id: string;
  task_id: string | null;
  kind: 'text' | 'markdown' | 'code' | 'json' | 'image' | 'file' | 'url';
  title: string;
  content: string | null;
  uri: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AgentSoul {
  id?: string;
  org_id: string;
  name: string;
  persona: string;
  directives: string[];
  autonomy_level: 0 | 1 | 2 | 3;
  model_prefs: Record<string, unknown>;
  updated_at?: string;
}

export interface SkillTool {
  id: string;
  skill_id: string;
  name: string;
  capability: string;
  description: string | null;
  approval_level: 0 | 1 | 2 | 3;
  enabled: boolean;
}

export interface ToolRouteDecision {
  tool: { name: string; description: string; capabilities: string[]; costPerToken: number; avgLatencyMs: number };
  matchedCapability: string;
  alternates: Array<{ name: string }>;
  score: number;
}

export interface WearCommand {
  id: string;
  direction: 'watch_to_core' | 'core_to_watch';
  label: string;
  description: string;
  category: 'agent' | 'web' | 'media' | 'apps' | 'system' | 'sensors';
  approval_level: 0 | 1 | 2 | 3;
  example: Record<string, unknown>;
}

export interface WearDevice {
  id: string;
  label: string | null;
  status: string | null;
  created_at: string;
}

export interface WearOverview {
  status: IntegrationStatus;
  enabled_commands: string[];
  commands: WearCommand[];
  devices: WearDevice[];
  endpoints: Record<string, string>;
}

export interface Skill {
  id: string;
  org_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  status: 'draft' | 'active' | 'disabled' | 'archived';
  latest_version: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
}
