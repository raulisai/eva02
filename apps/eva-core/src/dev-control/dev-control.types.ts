export type DevTaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'waiting_approval'
  | 'testing'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'blocked';

export type ClaudeCodeSessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'closed';

export interface Project {
  id: string;
  org_id: string;
  name: string;
  repo_path: string | null;
  node_id: string | null;
  stack: string[];
  status: string;
  main_branch: string;
  dev_command: string | null;
  test_command: string | null;
  build_command: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DevTask {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: DevTaskStatus;
  prompt: string | null;
  diff_summary: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaudeCodeSession {
  id: string;
  org_id: string;
  project_id: string;
  dev_task_id: string | null;
  node_id: string | null;
  status: ClaudeCodeSessionStatus;
  transport: 'websocket';
  output: string;
  metadata: Record<string, unknown>;
  started_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: number;
  org_id: string;
  project_id: string;
  dev_task_id: string | null;
  command: string | null;
  ok: boolean;
  output: string;
  created_at: string;
}

export interface RoadmapItem {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: string;
  priority: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const DEV_TASK_TRANSITIONS: Record<DevTaskStatus, DevTaskStatus[]> = {
  backlog: ['ready', 'blocked', 'failed'],
  ready: ['in_progress', 'blocked', 'failed'],
  in_progress: ['waiting_approval', 'testing', 'reviewing', 'done', 'blocked', 'failed'],
  waiting_approval: ['in_progress', 'blocked', 'failed'],
  testing: ['reviewing', 'done', 'in_progress', 'blocked', 'failed'],
  reviewing: ['done', 'in_progress', 'blocked', 'failed'],
  done: [],
  failed: ['ready', 'blocked'],
  blocked: ['ready', 'failed'],
};

export function isValidDevTaskTransition(current: DevTaskStatus, next: DevTaskStatus): boolean {
  return current === next || DEV_TASK_TRANSITIONS[current].includes(next);
}
