export type Intent = 'fast_path' | 'core_path' | 'core_path_approval';

export type ClassifierKind = 'rules' | 'llm' | 'hybrid';

export interface IntentClassification {
  intent:     Intent;
  confidence: number;      // 0–1
  classifier: ClassifierKind;
  reasons:    string[];    // human-readable list of signals that fired
}

export interface IntentRoute {
  id:         string;
  org_id:     string;
  task_id:    string | null;
  input_hash: string;
  intent:     Intent;
  confidence: number;
  classifier: string;
  metadata:   Record<string, unknown>;
  created_at: string;
}

// Signals that force approval regardless of other signals
export const APPROVAL_SIGNALS = [
  'delete all', 'drop table', 'truncate', 'deploy to prod', 'deploy to production',
  'send money', 'transfer funds', 'wire transfer', 'bulk delete', 'bulk update',
  'reset passwords', 'revoke all', 'grant admin', 'remove all users', 'wipe',
] as const;

// Signals that suggest lightweight fast-path handling
export const FAST_PATH_SIGNALS = [
  'what is', 'what are', 'how do', 'explain', 'list', 'show me', 'tell me',
  'describe', 'summarize', 'status', 'ping', 'health', 'version',
] as const;
