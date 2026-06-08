import { Test } from '@nestjs/testing';
import { ModelRouterService } from '../model-router/model-router.service';

global.fetch = jest.fn();

describe('ModelRouterService', () => {
  let service: ModelRouterService;

  function buildService() {
    return Test.createTestingModule({
      providers: [ModelRouterService],
    })
      .compile()
      .then(m => m.get(ModelRouterService));
  }

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  describe('without OPENAI_API_KEY (dev fallback)', () => {
    beforeEach(async () => {
      delete process.env.OPENAI_API_KEY;
      service = await buildService();
    });

    it('returns a 1536-dim vector', async () => {
      const vec = await service.embed('hello world');
      expect(vec).toHaveLength(1536);
    });

    it('is deterministic — same input yields same output', async () => {
      const a = await service.embed('test sentence');
      const b = await service.embed('test sentence');
      expect(a).toEqual(b);
    });

    it('is L2-normalised (magnitude ≈ 1)', async () => {
      const vec = await service.embed('normalised vector');
      const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it('different inputs yield different vectors', async () => {
      const a = await service.embed('apple');
      const b = await service.embed('banana');
      expect(a).not.toEqual(b);
    });

    it('does not call fetch', async () => {
      await service.embed('hello');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('with OPENAI_API_KEY set', () => {
    beforeEach(async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      service = await buildService();
    });

    it('calls OpenAI embeddings endpoint', async () => {
      const mockEmbedding = new Array(1536).fill(0.1);
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbedding }] }),
      });

      const result = await service.embed('openai test');

      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer sk-test-key' }),
        }),
      );
      expect(result).toEqual(mockEmbedding);
    });

    it('throws on non-ok response', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'rate limit exceeded',
      });

      await expect(service.embed('fail')).rejects.toThrow(/429/);
    });
  });

  describe('embeddingModel', () => {
    it('returns the model name', async () => {
      service = await buildService();
      expect(service.embeddingModel).toBe('text-embedding-3-small');
    });
  });
});
