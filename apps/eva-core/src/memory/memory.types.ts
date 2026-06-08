export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

export interface Memory {
  id: string;
  org_id: string;
  agent_id: string | null;
  task_id: string | null;
  content: string;
  summary: string;
  importance: number;
  memory_type: MemoryType;
  metadata: Record<string, unknown>;
  accessed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryEmbedding {
  id: string;
  memory_id: string;
  org_id: string;
  embedding: number[];
  model: string;
  created_at: string;
}

export interface MemorySearchResult extends Memory {
  similarity: number;
}

export interface SaveMemoryResult {
  stored: true;
  memory: Memory;
}

export interface RejectMemoryResult {
  stored: false;
  reason: 'below_importance_threshold' | 'invalid_summary';
}

export type MemoryResult = SaveMemoryResult | RejectMemoryResult;
