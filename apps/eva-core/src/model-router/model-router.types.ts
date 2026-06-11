export type ModelBackend = 'openai' | 'claude' | 'google' | 'auto';

export type ModelBudget = 'cheap' | 'balanced' | 'powerful';

export interface GenerateOptions {
  backend?: ModelBackend;
  budget?: ModelBudget;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  /** When set, org-stored provider keys take precedence over env keys. */
  orgId?: string;
  taskId?: string;
  imageBase64?: string;
  imageMimeType?: string;
  requestType?: 'reasoning' | 'tools' | 'code' | 'response';
  /**
   * Marca el systemPrompt como prefijo cacheable. Útil cuando el MISMO system
   * se reenvía muchas veces (p. ej. el bucle agéntico): Claude lo cachea con
   * cache_control ephemeral; OpenAI/Gemini ya cachean el prefijo estable solos.
   */
  cacheSystem?: boolean;
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
export const MODEL_CATALOGUE: Record<ModelBudget, { google: string; openai: string; claude: string }> = {
  cheap:     { google: 'gemini-2.5-flash-lite', openai: 'gpt-4.1-nano', claude: 'claude-haiku-4-5-20251001' },
  balanced:  { google: 'gemini-2.5-flash',      openai: 'gpt-4.1-mini', claude: 'claude-sonnet-4-6' },
  powerful:  { google: 'gemini-2.5-pro',        openai: 'gpt-4.1',      claude: 'claude-opus-4-8' },
};

export const EMBED_MODELS = {
  openai: 'text-embedding-3-small',
};
