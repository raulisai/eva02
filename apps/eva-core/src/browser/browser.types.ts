export interface BrowserProfile {
  id: string;
  org_id: string;
  service: string;
  label: string | null;
  encrypted_state: string | null;
  kms_key_ref: string;
  created_at: string;
  updated_at: string;
}

export interface BrowserSession {
  id: string;
  org_id: string;
  profile_id: string;
  task_id: string | null;
  status: 'open' | 'closed' | 'failed';
  current_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BrowserScreenshot {
  id: string;
  org_id: string;
  session_id: string;
  task_id: string | null;
  image_base64: string;
  mime_type: string;
  created_at: string;
}

export interface BrowserActionPreparation {
  id: string;
  org_id: string;
  session_id: string;
  task_id: string | null;
  approval_id: string | null;
  screenshot_id: string | null;
  action_type: string;
  payload: Record<string, unknown>;
  action_hash: string;
  nonce: string;
  status: 'pending_approval' | 'approved' | 'executed' | 'rejected' | 'expired';
  created_by: string;
  created_at: string;
}

export const BROWSER_RUNTIME = Symbol('BROWSER_RUNTIME');
