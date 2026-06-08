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

/** Allowed state-machine transitions */
const TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  pending:              ['planning', 'cancelled'],
  planning:             ['running', 'failed', 'cancelled'],
  running:              ['waiting_for_approval', 'completed', 'failed', 'cancelled'],
  waiting_for_approval: ['running', 'completed', 'failed', 'cancelled'],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];
