import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);
  private readonly openaiApiKey: string | undefined;
  private readonly model = 'text-embedding-3-small';

  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
  }

  async embed(text: string): Promise<number[]> {
    if (this.openaiApiKey) {
      return this.embedWithOpenAI(text);
    }
    this.logger.warn('OPENAI_API_KEY not set — using deterministic dev embedding');
    return this.deterministicEmbed(text);
  }

  get embeddingModel(): string {
    return this.model;
  }

  private async embedWithOpenAI(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI embedding failed ${response.status}: ${err}`);
    }

    const data = (await response.json()) as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }

  // Deterministic 1536-dim vector for dev/test — same input always yields same output.
  private deterministicEmbed(text: string): number[] {
    const dim = 1536;
    const vec = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dim] += text.charCodeAt(i) / 255;
    }
    // L2-normalise so cosine similarity is well-defined
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }
}
