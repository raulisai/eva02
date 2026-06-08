export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalSource = 'core_path' | 'fast_path' | 'browser' | 'dev_manager' | 'system';

export interface Approval {
  id: string;
  org_id: string;
  task_id: string | null;
  level: 0 | 1 | 2 | 3;
  action_type: string;
  action_hash: string;
  nonce: string;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  summary: string | null;
  screenshot_ref: string | null;
  source: ApprovalSource;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_by_2: string | null;
  reviewed_at: string | null;
  nonce_used_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface ApprovalDecision {
  approval: Approval;
  completed: boolean;
}
