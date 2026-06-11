import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MemoryService } from '../memory.service';
import { MemoriesRepository } from '../memories.repository';
import { ModelRouterService } from '../../model-router/model-router.service';
import { Memory } from '../memory.types';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-0001',
    org_id: ORG_A,
    agent_id: 'agent-1',
    task_id: null,
    content: 'The system encountered a critical error in the payment pipeline that required immediate resolution.',
    summary: 'Critical payment error resolved by switching to fallback provider.',
    importance: 0.75,
    memory_type: 'episodic',
    metadata: {},
    accessed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const MOCK_EMBEDDING = new Array(1536).fill(0.01);

describe('MemoryService', () => {
  let service: MemoryService;
  let repo: jest.Mocked<MemoriesRepository>;
  let modelRouter: jest.Mocked<ModelRouterService>;

  beforeEach(async () => {
    const repoMock: Partial<jest.Mocked<MemoriesRepository>> = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdOrThrow: jest.fn(),
      storeEmbedding: jest.fn(),
      searchSimilar: jest.fn(),
      updateAccessedAt: jest.fn().mockResolvedValue(undefined),
    };

    const modelMock: Partial<jest.Mocked<ModelRouterService>> = {
      embed: jest.fn().mockResolvedValue({
        embedding: MOCK_EMBEDDING,
        model: 'text-embedding-3-small',
        backend: 'openai',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryService,
        { provide: MemoriesRepository, useValue: repoMock },
        { provide: ModelRouterService, useValue: modelMock },
      ],
    }).compile();

    service = module.get(MemoryService);
    repo = module.get(MemoriesRepository);
    modelRouter = module.get(ModelRouterService);
  });

  // ── Importance heuristic ───────────────────────────────────────────────────

  describe('calculateImportance()', () => {
    it('returns higher score for summaries with high-value keywords', () => {
      const high = service.calculateImportance(
        'Critical error resolved. Always use fallback when primary fails.',
        'long content here',
      );
      const low = service.calculateImportance(
        'The weather is nice today and things seem fine.',
        'short',
      );
      expect(high).toBeGreaterThan(low);
    });

    it('returns value between 0 and 1', () => {
      const score = service.calculateImportance('some summary text', 'some content');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('is higher when content is substantially longer than summary (distillation bonus)', () => {
      const withBonus = service.calculateImportance(
        'Key insight.',
        'A'.repeat(200),  // content >> summary × 2
      );
      const withoutBonus = service.calculateImportance('Key insight.', 'short');
      expect(withBonus).toBeGreaterThanOrEqual(withoutBonus);
    });
  });

  // ── Fast Path: saveMemory ─────────────────────────────────────────────────

  describe('saveMemory()', () => {
    it('stores memory when importance >= threshold', async () => {
      const mem = makeMemory();
      repo.create.mockResolvedValue(mem);
      repo.storeEmbedding.mockResolvedValue({} as any);

      const result = await service.saveMemory(
        {
          summary: 'Critical payment error resolved by switching to fallback provider.',
          content: mem.content,
          memory_type: 'episodic',
        },
        ORG_A,
      );

      expect(result.stored).toBe(true);
      if (result.stored) {
        expect(result.memory.id).toBe('mem-0001');
      }
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: ORG_A }),
      );
    });

    it('rejects memory when importance is below threshold', async () => {
      // Repeated low-information word: zero keyword hits, near-zero unique-word ratio
      const result = await service.saveMemory(
        {
          summary: 'the the the the the',
          content: 'the the the the the',
        },
        ORG_A,
      );

      expect(result.stored).toBe(false);
      if (!result.stored) {
        expect(result.reason).toBe('below_importance_threshold');
      }
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('triggers async embedding after storing (fire-and-forget)', async () => {
      const mem = makeMemory();
      repo.create.mockResolvedValue(mem);
      repo.storeEmbedding.mockResolvedValue({} as any);

      await service.saveMemory(
        {
          summary: 'Critical error resolved. Always use the fallback pattern.',
          content: mem.content,
        },
        ORG_A,
      );

      // Wait for the microtask-deferred embedding call
      await new Promise(r => setImmediate(r));
      expect(modelRouter.embed).toHaveBeenCalled();
      expect(repo.storeEmbedding).toHaveBeenCalledWith(
        mem.id,
        ORG_A,
        MOCK_EMBEDDING,
        'text-embedding-3-small',
      );
    });
  });

  // ── Semantic search ───────────────────────────────────────────────────────

  describe('searchMemories()', () => {
    it('embeds the query and calls searchSimilar', async () => {
      const results = [{ ...makeMemory(), similarity: 0.92 }];
      repo.searchSimilar.mockResolvedValue(results);

      const found = await service.searchMemories(
        { query: 'payment error', limit: 3, threshold: 0.7 },
        ORG_A,
      );

      expect(modelRouter.embed).toHaveBeenCalledWith('payment error');
      expect(repo.searchSimilar).toHaveBeenCalledWith(MOCK_EMBEDDING, ORG_A, 3, 0.7);
      expect(found).toHaveLength(1);
      expect(found[0].similarity).toBe(0.92);
    });

    it('updates accessed_at for returned memories', async () => {
      const results = [{ ...makeMemory(), similarity: 0.85 }];
      repo.searchSimilar.mockResolvedValue(results);

      await service.searchMemories({ query: 'test', limit: 5, threshold: 0.7 }, ORG_A);

      await new Promise(r => setImmediate(r));
      expect(repo.updateAccessedAt).toHaveBeenCalledWith('mem-0001', ORG_A);
    });

    it('returns empty array when nothing matches', async () => {
      repo.searchSimilar.mockResolvedValue([]);
      const found = await service.searchMemories({ query: 'xyz', limit: 5, threshold: 0.7 }, ORG_A);
      expect(found).toEqual([]);
    });
  });

  // ── getMemory ─────────────────────────────────────────────────────────────

  describe('getMemory()', () => {
    it('returns the memory for the correct org', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeMemory());
      const mem = await service.getMemory('mem-0001', ORG_A);
      expect(mem.org_id).toBe(ORG_A);
      expect(repo.findByIdOrThrow).toHaveBeenCalledWith('mem-0001', ORG_A);
    });

    it('throws NotFoundException for wrong org (org isolation)', async () => {
      repo.findByIdOrThrow.mockRejectedValue(new NotFoundException('Memory mem-0001 not found'));
      await expect(service.getMemory('mem-0001', ORG_B)).rejects.toThrow(NotFoundException);
    });
  });
});
