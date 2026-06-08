export interface ToolDefinition {
  name:          string;
  capabilities:  string[];
  costPerToken:  number;    // relative cost units (lower = cheaper)
  avgLatencyMs:  number;
  maxTokens:     number;
  available:     boolean;
  description:   string;
}

export interface RouteDecision {
  tool:           ToolDefinition;
  matchedCapability: string;
  alternates:     ToolDefinition[];
  score:          number;         // combined cost+latency score (lower = better)
}

export interface RouteOptions {
  budget?:        'cheap' | 'balanced' | 'powerful';
  maxLatencyMs?:  number;
  excludeTools?:  string[];
}

// ── Built-in tool registry ────────────────────────────────────────────────────

export const DEFAULT_TOOLS: ToolDefinition[] = [
  {
    name:         'llm-generate',
    capabilities: ['generate', 'summarize', 'analyze', 'classify', 'answer', 'explain'],
    costPerToken:  10,
    avgLatencyMs:  2000,
    maxTokens:     8192,
    available:     true,
    description:   'General-purpose LLM text generation and analysis',
  },
  {
    name:         'code-executor',
    capabilities: ['code', 'bash', 'python', 'execute', 'run', 'compute'],
    costPerToken:  5,
    avgLatencyMs:  500,
    maxTokens:     4096,
    available:     true,
    description:   'Execute code in a sandboxed environment',
  },
  {
    name:         'web-search',
    capabilities: ['search', 'web', 'lookup', 'news', 'find'],
    costPerToken:  2,
    avgLatencyMs:  800,
    maxTokens:     2048,
    available:     true,
    description:   'Search the web for current information',
  },
  {
    name:         'file-reader',
    capabilities: ['read', 'parse', 'extract', 'file', 'document'],
    costPerToken:  1,
    avgLatencyMs:  100,
    maxTokens:     16384,
    available:     true,
    description:   'Read and extract content from files and documents',
  },
  {
    name:         'memory-recall',
    capabilities: ['recall', 'remember', 'memory', 'search-memory', 'context'],
    costPerToken:  3,
    avgLatencyMs:  200,
    maxTokens:     4096,
    available:     true,
    description:   'Retrieve relevant memories via semantic search',
  },
  {
    name:         'approval-gate',
    capabilities: ['approve', 'review', 'authorize', 'confirm', 'human-in-the-loop'],
    costPerToken:  0,
    avgLatencyMs:  0,
    maxTokens:     0,
    available:     true,
    description:   'Request human approval for sensitive actions',
  },
  {
    name:         'data-query',
    capabilities: ['query', 'database', 'sql', 'data', 'aggregate'],
    costPerToken:  4,
    avgLatencyMs:  300,
    maxTokens:     8192,
    available:     true,
    description:   'Query structured data sources',
  },
  {
    name:         'api-call',
    capabilities: ['api', 'http', 'webhook', 'integration', 'external'],
    costPerToken:  2,
    avgLatencyMs:  600,
    maxTokens:     4096,
    available:     true,
    description:   'Call external APIs and webhooks',
  },
];
