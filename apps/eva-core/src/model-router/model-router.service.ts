import { Injectable, Logger } from '@nestjs/common';
import {
  GenerateOptions,
  GenerateResult,
  EmbedResult,
  RealtimeTokenResult,
  ModelBackend,
  MODEL_CATALOGUE,
  EMBED_MODELS,
} from './model-router.types';

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  private get openaiKey()     { return process.env.OPENAI_API_KEY; }
  private get anthropicKey()  { return process.env.ANTHROPIC_API_KEY; }
  private get preferredBackend(): ModelBackend {
    if (this.openaiKey)    return 'openai';
    if (this.anthropicKey) return 'claude';
    return 'openai'; // fallback still selected, generate() will use stub
  }

  // ── generate ──────────────────────────────────────────────────────────────

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
    const backend = this.resolveBackend(opts.backend);
    const budget  = opts.budget ?? 'balanced';

    if (backend === 'claude' && this.anthropicKey) {
      return this.generateClaude(prompt, opts, budget);
    }
    if (backend === 'openai' && this.openaiKey) {
      return this.generateOpenAI(prompt, opts, budget);
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
  ): Promise<GenerateResult> {
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.openaiKey}` },
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
  ): Promise<GenerateResult> {
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
        'x-api-key':         this.anthropicKey!,
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

  private resolveBackend(requested?: ModelBackend): ModelBackend {
    if (requested && requested !== 'auto') return requested;
    return this.preferredBackend;
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
