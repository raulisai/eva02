import { Injectable, Logger, Optional } from '@nestjs/common';
import { IntegrationsService } from '../integrations/integrations.service';
import {
  GenerateOptions,
  GenerateResult,
  EmbedResult,
  RealtimeTokenResult,
  ModelBackend,
  ModelBudget,
  MODEL_CATALOGUE,
  EMBED_MODELS,
} from './model-router.types';

interface ResolvedKeys {
  openai?: string;
  claude?: string;
  google?: string;
}

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  constructor(@Optional() private readonly integrations?: IntegrationsService) {}

  private get openaiKey()     { return process.env.OPENAI_API_KEY; }
  private get anthropicKey()  { return process.env.ANTHROPIC_API_KEY; }
  private get googleKey()     { return process.env.GOOGLE_API_KEY; }
  private get preferredBackend(): ModelBackend {
    if (this.googleKey)    return 'google';
    if (this.openaiKey)    return 'openai';
    if (this.anthropicKey) return 'claude';
    return 'openai'; // fallback still selected, generate() will use stub
  }

  /** Org-stored keys (dashboard /settings/models) take precedence over env. */
  private async resolveKeys(orgId?: string): Promise<ResolvedKeys> {
    const keys: ResolvedKeys = { openai: this.openaiKey, claude: this.anthropicKey, google: this.googleKey };
    if (!orgId || !this.integrations) return keys;
    try {
      const [anthropic, openai, google] = await Promise.all([
        this.integrations.getSecret(orgId, 'model', 'anthropic'),
        this.integrations.getSecret(orgId, 'model', 'openai'),
        this.integrations.getSecret(orgId, 'model', 'google'),
      ]);
      if (anthropic) keys.claude = anthropic;
      if (openai) keys.openai = openai;
      if (google) keys.google = google;
    } catch (error) {
      this.logger.warn(`Org key lookup failed, falling back to env keys: ${(error as Error).message}`);
    }
    return keys;
  }

  // ── generate ──────────────────────────────────────────────────────────────

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
    const keys = await this.resolveKeys(opts.orgId);
    const budget  = opts.budget ?? this.inferBudget(prompt, opts);
    const backend = this.resolveBackend(opts.backend, keys, budget);

    if (backend === 'google' && keys.google) {
      return this.generateGoogle(prompt, opts, budget, keys.google);
    }
    if (backend === 'claude' && keys.claude) {
      return this.generateClaude(prompt, opts, budget, keys.claude);
    }
    if (backend === 'openai' && keys.openai) {
      return this.generateOpenAI(prompt, opts, budget, keys.openai);
    }

    this.logger.warn('No LLM API key configured — returning deterministic stub');
    return this.generateStub(prompt, opts);
  }

  // ── embed ─────────────────────────────────────────────────────────────────

  async embed(text: string): Promise<EmbedResult> {
    if (this.openaiKey) {
      return this.embedOpenAI(text);
    }
    this.logger.warn('OPENAI_API_KEY not set — using deterministic dev embedding');
    return { embedding: this.deterministicEmbed(text), model: 'dev-stub', backend: 'openai' };
  }

  // ── realtimeToken ─────────────────────────────────────────────────────────
  // Creates an OpenAI Realtime session and returns the ephemeral client_secret
  // so the browser can open a Realtime WebSocket without exposing the API key.

  async realtimeToken(orgId: string): Promise<RealtimeTokenResult> {
    if (!this.openaiKey) {
      throw new Error('OPENAI_API_KEY required for realtimeToken');
    }

    const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'alloy',
        metadata: { org_id: orgId },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Realtime session failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      client_secret: { value: string; expires_at: number };
      id: string;
    };

    return {
      clientSecret: data.client_secret.value,
      expiresAt:    data.client_secret.expires_at,
      sessionId:    data.id,
    };
  }

  // ── private: OpenAI generate ──────────────────────────────────────────────

  private async generateOpenAI(
    prompt: string,
    opts: GenerateOptions,
    budget: string,
    apiKey?: string,
  ): Promise<GenerateResult> {
    const key = apiKey ?? this.openaiKey;
    const model = opts.model ?? MODEL_CATALOGUE[budget as keyof typeof MODEL_CATALOGUE]?.openai ?? 'gpt-4o-mini';

    const messages: { role: string; content: string }[] = [];
    if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature:  opts.temperature  ?? 0.7,
      max_tokens:   opts.maxTokens    ?? 1024,
    };
    if (opts.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI generate failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      text:    data.choices[0].message.content,
      model:   data.model,
      backend: 'openai',
      usage: {
        promptTokens:     data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens:      data.usage.total_tokens,
      },
    };
  }

  // ── private: Claude generate ──────────────────────────────────────────────

  private async generateClaude(
    prompt: string,
    opts: GenerateOptions,
    budget: string,
    apiKey?: string,
  ): Promise<GenerateResult> {
    const key = apiKey ?? this.anthropicKey;
    const model = opts.model ?? MODEL_CATALOGUE[budget as keyof typeof MODEL_CATALOGUE]?.claude ?? 'claude-haiku-4-5-20251001';

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? 1024,
      messages:   [{ role: 'user', content: prompt }],
    };
    if (opts.systemPrompt) body['system'] = opts.systemPrompt;
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude generate failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      content: { type: string; text: string }[];
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const text = data.content.find(b => b.type === 'text')?.text ?? '';

    return {
      text,
      model:   data.model,
      backend: 'claude',
      usage: {
        promptTokens:     data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens:      data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }

  // ── private: Google Gemini generate ───────────────────────────────────────

  private async generateGoogle(
    prompt: string,
    opts: GenerateOptions,
    budget: string,
    apiKey?: string,
  ): Promise<GenerateResult> {
    const key = apiKey ?? this.googleKey;
    const model = opts.model ?? MODEL_CATALOGUE[budget as keyof typeof MODEL_CATALOGUE]?.google ?? 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const parts = opts.systemPrompt
      ? [{ text: `${opts.systemPrompt}\n\n${prompt}` }]
      : [{ text: prompt }];
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxTokens ?? 1024,
        responseMimeType: opts.responseFormat === 'json' ? 'application/json' : 'text/plain',
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google generate failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      modelVersion?: string;
    };
    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? '';
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      text,
      model: data.modelVersion ?? model,
      backend: 'google',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
      },
    };
  }

  // ── private: OpenAI embed ─────────────────────────────────────────────────

  private async embedOpenAI(text: string): Promise<EmbedResult> {
    const model = EMBED_MODELS.openai;

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.openaiKey}` },
      body:    JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI embed failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return { embedding: data.data[0].embedding, model, backend: 'openai' };
  }

  // ── private: dev stub ─────────────────────────────────────────────────────

  private generateStub(prompt: string, opts: GenerateOptions): GenerateResult {
    const words = prompt.split(/\s+/).slice(0, 5).join(' ');
    const text = opts.responseFormat === 'json'
      ? JSON.stringify({ result: 'stub', echo: words })
      : `[stub] ${words}…`;

    return {
      text,
      model:   'stub-0',
      backend: 'openai',
      usage:   { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  private resolveBackend(requested?: ModelBackend, keys?: ResolvedKeys, budget: ModelBudget = 'cheap'): ModelBackend {
    if (requested && requested !== 'auto') return requested;
    if (budget === 'cheap' || budget === 'balanced') {
      if (keys?.google) return 'google';
      if (keys?.openai) return 'openai';
      if (keys?.claude) return 'claude';
    }
    if (budget === 'powerful') {
      if (keys?.claude) return 'claude';
      if (keys?.openai) return 'openai';
      if (keys?.google) return 'google';
    }
    if (keys?.claude && !keys?.openai) return 'claude';
    if (keys?.openai) return 'openai';
    return this.preferredBackend;
  }

  private inferBudget(prompt: string, opts: GenerateOptions): ModelBudget {
    if (opts.responseFormat === 'json' || (opts.maxTokens ?? 0) <= 400) return 'cheap';
    const text = `${opts.systemPrompt ?? ''}\n${prompt}`.toLowerCase();
    if (
      text.length > 4000 ||
      /\b(refactor|arquitectura|architecture|debug|production|security|migraci[oó]n|multi-step|varios pasos|plan completo)\b/.test(text)
    ) {
      return 'balanced';
    }
    return 'cheap';
  }

  // Deterministic L2-normalised 1536-dim vector for dev/test
  private deterministicEmbed(text: string): number[] {
    const dim = 1536;
    const vec = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dim] += text.charCodeAt(i) / 255;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }
}
