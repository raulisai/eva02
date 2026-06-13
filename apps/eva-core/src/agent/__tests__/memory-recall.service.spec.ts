import { MemoryRecallService } from '../memory-recall.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const FAKE_EMBEDDING = Array(1536).fill(0.01);

function makeMemoryAgent(hits: object[] = []) {
  return {
    recall: jest.fn().mockResolvedValue(hits),
    searchByEmbedding: jest.fn().mockResolvedValue(hits),
  } as any;
}

function makeModelRouter(embedding = FAKE_EMBEDDING) {
  return {
    embed: jest.fn().mockResolvedValue({ embedding, model: 'text-embedding-3-small', backend: 'openai' }),
  } as any;
}

describe('MemoryRecallService', () => {
  describe('check (explicit recall)', () => {
    it('returns isRecall=false and no context for non-recall inputs', async () => {
      const svc = new MemoryRecallService(makeMemoryAgent(), makeModelRouter());
      const result = await svc.check('busca el clima en CDMX', ORG);
      expect(result.isRecall).toBe(false);
      expect(result.context).toBeNull();
      expect(result.memories).toHaveLength(0);
    });

    it('triggers recall on explicit phrase and formats the block', async () => {
      const hits = [
        { id: '1', summary: 'Usuario usa Telegram como canal principal', similarity: 0.9, importance: 0.8, created_at: '2026-01-10T10:00:00Z' },
      ];
      const svc = new MemoryRecallService(makeMemoryAgent(hits), makeModelRouter());
      const result = await svc.check('recuerda qué canales uso', ORG);
      expect(result.isRecall).toBe(true);
      expect(result.context).toContain('Memorias relevantes');
      expect(result.context).toContain('Telegram');
      expect(result.memories).toHaveLength(1);
    });

    it('returns isRecall=true with "no memories" message when vector search is empty', async () => {
      const svc = new MemoryRecallService(makeMemoryAgent([]), makeModelRouter());
      const result = await svc.check('te acuerdas de lo que acordamos', ORG);
      expect(result.isRecall).toBe(true);
      expect(result.context).toContain('No encontré');
    });

    it('returns isRecall=true and null context when recall search throws', async () => {
      const agent = makeMemoryAgent();
      agent.recall.mockRejectedValue(new Error('DB down'));
      const svc = new MemoryRecallService(agent, makeModelRouter());
      const result = await svc.check('recuerda nuestra conversación', ORG);
      expect(result.isRecall).toBe(true);
      expect(result.context).toBeNull();
    });
  });

  describe('isRecallRequest', () => {
    it('detects recall phrases', () => {
      const svc = new MemoryRecallService(makeMemoryAgent(), makeModelRouter());
      expect(svc.isRecallRequest('recuerda lo que dijiste')).toBe(true);
      expect(svc.isRecallRequest('te acuerdas de nuestra conversación')).toBe(true);
    });

    it('does not flag normal queries', () => {
      const svc = new MemoryRecallService(makeMemoryAgent(), makeModelRouter());
      expect(svc.isRecallRequest('analiza las ventas del mes')).toBe(false);
      expect(svc.isRecallRequest('investiga empresas tech')).toBe(false);
    });
  });

  describe('proactiveContext', () => {
    it('returns null when no memories exceed threshold', async () => {
      const agent = makeMemoryAgent([]); // no hits
      const svc = new MemoryRecallService(agent, makeModelRouter());
      const result = await svc.proactiveContext('investiga las mejores acciones tech', ORG);
      expect(result).toBeNull();
      expect(agent.searchByEmbedding).toHaveBeenCalledWith(
        FAKE_EMBEDDING, ORG, 3, 0.62,
      );
    });

    it('returns formatted context block when high-similarity memories exist', async () => {
      const hits = [
        { id: '1', summary: 'Usuario prefiere reportes en PDF enviados por Telegram', similarity: 0.85, importance: 0.7, created_at: '2026-01-15T08:00:00Z' },
        { id: '2', summary: 'Usa yfinance para datos de bolsa en el sandbox', similarity: 0.80, importance: 0.6, created_at: '2026-01-14T08:00:00Z' },
      ];
      const agent = makeMemoryAgent(hits);
      const svc = new MemoryRecallService(agent, makeModelRouter());
      const result = await svc.proactiveContext('monitorea acciones de Google y genera PDF mensual', ORG);
      expect(result).not.toBeNull();
      expect(result).toContain('Contexto del usuario');
      expect(result).toContain('PDF');
      expect(result).toContain('yfinance');
    });

    it('filters out low-importance memories even if similarity passes', async () => {
      const hits = [
        // similarity passes threshold but importance is too low
        { id: '1', summary: 'Algo sin importancia', similarity: 0.75, importance: 0.1, created_at: '2026-01-01T00:00:00Z' },
      ];
      const agent = makeMemoryAgent(hits);
      const svc = new MemoryRecallService(agent, makeModelRouter());
      const result = await svc.proactiveContext('tarea compleja', ORG);
      expect(result).toBeNull();
    });

    it('truncates long summaries to 120 chars', async () => {
      const longSummary = 'A'.repeat(200);
      const hits = [
        { id: '1', summary: longSummary, similarity: 0.90, importance: 0.8, created_at: '2026-01-15T00:00:00Z' },
      ];
      const agent = makeMemoryAgent(hits);
      const svc = new MemoryRecallService(agent, makeModelRouter());
      const result = await svc.proactiveContext('tarea', ORG);
      // Each summary line starts with "• " — check the actual content doesn't exceed 120 + "• " + "…"
      const line = result!.split('\n').find((l) => l.startsWith('•'))!;
      expect(line.length).toBeLessThanOrEqual(123); // "• " + 120 + "…"
    });

    it('returns null and does not throw when embed fails', async () => {
      const agent = makeMemoryAgent([{ id: '1', summary: 'irrelevant', similarity: 0.9, importance: 0.9, created_at: '' }]);
      const router = makeModelRouter();
      router.embed.mockRejectedValue(new Error('embed service unavailable'));
      const svc = new MemoryRecallService(agent, router);
      await expect(svc.proactiveContext('tarea compleja', ORG)).resolves.toBeNull();
    });

    it('returns null and does not throw when searchByEmbedding fails', async () => {
      const agent = makeMemoryAgent();
      agent.searchByEmbedding.mockRejectedValue(new Error('DB unavailable'));
      const svc = new MemoryRecallService(agent, makeModelRouter());
      await expect(svc.proactiveContext('tarea compleja', ORG)).resolves.toBeNull();
    });
  });
});
