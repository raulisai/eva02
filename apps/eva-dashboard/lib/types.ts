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
