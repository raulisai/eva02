export type ModelBackend = 'openai' | 'claude' | 'auto';

export type ModelBudget = 'cheap' | 'balanced' | 'powerful';

export interface GenerateOptions {
  backend?: ModelBackend;
  budget?: ModelBudget;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface GenerateResult {
  text: string;
  model: string;
  backend: ModelBackend;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface EmbedResult {
  embedding: number[];
  model: string;
  backend: ModelBackend;
}

export interface RealtimeTokenResult {
  clientSecret: string;
  expiresAt: number;
  sessionId: string;
}

// Model catalogue — updated here when adding new models
export const MODEL_CATALOGUE: Record<ModelBudget, { openai: string; claude: string }> = {
  cheap:     { openai: 'gpt-4o-mini',          claude: 'claude-haiku-4-5-20251001' },
  balanced:  { openai: 'gpt-4o',               claude: 'claude-sonnet-4-6' },
  powerful:  { openai: 'o3',                   claude: 'claude-opus-4-8' },
};

export const EMBED_MODELS = {
  openai: 'text-embedding-3-small',
};
