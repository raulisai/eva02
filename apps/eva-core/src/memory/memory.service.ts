import { Injectable, Logger } from '@nestjs/common';
import { MemoriesRepository } from './memories.repository';
import { ModelRouterService } from './model-router/model-router.service';
import { SaveMemoryDto } from './dto/save-memory.dto';
import { SearchMemoryDto } from './dto/search-memory.dto';
import { Memory, MemoryResult, MemorySearchResult } from './memory.types';

// Keywords that signal high-value memories worth persisting
const HIGH_VALUE_KEYWORDS = [
  'error', 'failed', 'critical', 'important', 'remember', 'always', 'never',
  'learned', 'decided', 'key', 'must', 'should', 'resolved', 'fixed',
  'pattern', 'insight', 'conclusion', 'result', 'outcome',
];

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private readonly importanceThreshold: number;

  constructor(
    private readonly repo: MemoriesRepository,
    private readonly modelRouter: ModelRouterService,
  ) {
    this.importanceThreshold = parseFloat(
      process.env.MEMORY_IMPORTANCE_THRESHOLD ?? '0.3',
    );
  }

  // Fast Path: agent sends a pre-computed summary; Core decides importance.
  // Raw conversation content is never written directly to deep memory.
  async saveMemory(dto: SaveMemoryDto, orgId: string): Promise<MemoryResult> {
    const importance = this.calculateImportance(dto.summary, dto.content);

    if (importance < this.importanceThreshold) {
      this.logger.debug(
        `Memory rejected for org ${orgId}: importance=${importance.toFixed(3)} < threshold=${this.importanceThreshold}`,
      );
      return { stored: false, reason: 'below_importance_threshold' };
    }

    const memory = await this.repo.create({
      org_id: orgId,
      agent_id: dto.agent_id,
      task_id: dto.task_id,
      content: dto.content,
      summary: dto.summary,
      importance,
      memory_type: dto.memory_type ?? 'episodic',
      metadata: dto.metadata ?? {},
    });

    // Fire-and-forget: embed in background so the API response is not blocked
    this.generateEmbeddingAsync(memory.id, orgId, dto.summary).catch(err =>
      this.logger.error(`Async embedding failed for memory ${memory.id}`, err),
    );

    return { stored: true, memory };
  }

  async searchMemories(dto: SearchMemoryDto, orgId: string): Promise<MemorySearchResult[]> {
    const embedding = await this.modelRouter.embed(dto.query);
    const results = await this.repo.searchSimilar(
      embedding,
      orgId,
      dto.limit ?? 5,
      dto.threshold ?? 0.7,
    );

    // Update access timestamps in background
    if (results.length > 0) {
      Promise.all(results.map(r => this.repo.updateAccessedAt(r.id, orgId))).catch(err =>
        this.logger.warn('Failed to update accessed_at', err),
      );
    }

    return results;
  }

  async getMemory(memoryId: string, orgId: string): Promise<Memory> {
    return this.repo.findByIdOrThrow(memoryId, orgId);
  }

  // Importance heuristic (0–1):
  //   keyword density  0–0.4
  //   length score     0–0.2  (optimal ~200 chars)
  //   info density     0–0.4  (unique word ratio)
  calculateImportance(summary: string, content: string): number {
    const text = summary.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean);

    const keywordScore = Math.min(
      0.4,
      (words.filter(w => HIGH_VALUE_KEYWORDS.includes(w)).length / Math.max(words.length, 1)) * 2,
    );

    const lengthScore = Math.min(0.2, (summary.length / 200) * 0.2);

    const unique = new Set(words).size;
    const densityScore = Math.min(0.4, (unique / Math.max(words.length, 1)) * 0.4);

    // Boost if content is substantially longer than summary (agent distilled it)
    const distillationBonus = content.length > summary.length * 2 ? 0.05 : 0;

    return Math.min(1, keywordScore + lengthScore + densityScore + distillationBonus);
  }

  private async generateEmbeddingAsync(
    memoryId: string,
    orgId: string,
    text: string,
  ): Promise<void> {
    const embedding = await this.modelRouter.embed(text);
    await this.repo.storeEmbedding(memoryId, orgId, embedding, this.modelRouter.embeddingModel);
    this.logger.debug(`Embedding stored for memory ${memoryId}`);
  }
}
