import { Test } from '@nestjs/testing';
import { NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { MemoriesRepository } from '../memories.repository';
import { DatabaseService } from '../../database/database.service';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const MEMORY_ROW = {
  id: 'mem-0001',
  org_id: ORG_A,
  agent_id: 'agent-1',
  task_id: null,
  content: 'Test content',
  summary: 'Test summary',
  importance: 0.8,
  memory_type: 'episodic',
  metadata: {},
  accessed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('MemoriesRepository', () => {
  let repo: MemoriesRepository;
  let eqCalls: Array<{ col: string; val: unknown }>;

  // Proxy that records .eq() calls — mirrors the pattern in rls.e2e-spec.ts
  function makeAdminProxy(resolvedData: unknown, error: unknown = null) {
    eqCalls = [];

    const proxy: any = {
      from: () => { eqCalls = []; return proxy; },
      select: () => proxy,
      insert: () => proxy,
      update: () => proxy,
      upsert: () => proxy,
      rpc: jest.fn().mockResolvedValue({ data: resolvedData, error }),
      eq: (col: string, val: unknown) => { eqCalls.push({ col, val }); return proxy; },
      single: jest.fn().mockResolvedValue({ data: resolvedData, error }),
      maybeSingle: jest.fn().mockResolvedValue({ data: resolvedData, error }),
    };
    return proxy;
  }

  async function buildRepo(adminProxy: any) {
    const module = await Test.createTestingModule({
      providers: [
        MemoriesRepository,
        { provide: DatabaseService, useValue: { admin: adminProxy } },
      ],
    }).compile();
    return module.get(MemoriesRepository);
  }

  // ── create ──────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('inserts a memory row and returns it', async () => {
      const proxy = makeAdminProxy(MEMORY_ROW);
      repo = await buildRepo(proxy);

      const result = await repo.create({
        org_id: ORG_A,
        content: 'Test content',
        summary: 'Test summary',
        importance: 0.8,
        memory_type: 'episodic',
        metadata: {},
      });

      expect(result.id).toBe('mem-0001');
      expect(result.org_id).toBe(ORG_A);
    });

    it('throws InternalServerErrorException on DB error', async () => {
      const proxy = makeAdminProxy(null, { message: 'db down' });
      repo = await buildRepo(proxy);

      await expect(
        repo.create({
          org_id: ORG_A,
          content: 'x',
          summary: 'x',
          importance: 0.5,
          memory_type: 'episodic',
          metadata: {},
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── findById ────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('applies org_id filter (org isolation)', async () => {
      const proxy = makeAdminProxy(MEMORY_ROW);
      repo = await buildRepo(proxy);

      await repo.findById('mem-0001', ORG_A);

      const orgFilter = eqCalls.find(c => c.col === 'org_id');
      expect(orgFilter?.val).toBe(ORG_A);
    });

    it('returns null when not found', async () => {
      const proxy = makeAdminProxy(null);
      repo = await buildRepo(proxy);

      const result = await repo.findById('mem-0001', ORG_A);
      expect(result).toBeNull();
    });
  });

  // ── findByIdOrThrow ────────────────────────────────────────────────────

  describe('findByIdOrThrow()', () => {
    it('returns memory when found', async () => {
      const proxy = makeAdminProxy(MEMORY_ROW);
      repo = await buildRepo(proxy);

      const result = await repo.findByIdOrThrow('mem-0001', ORG_A);
      expect(result.id).toBe('mem-0001');
    });

    it('throws NotFoundException when not found', async () => {
      const proxy = makeAdminProxy(null);
      repo = await buildRepo(proxy);

      await expect(repo.findByIdOrThrow('mem-0001', ORG_A)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for wrong org (org isolation)', async () => {
      // org_id filter returns null when queried with ORG_B while data has ORG_A
      const proxy = makeAdminProxy(null);
      repo = await buildRepo(proxy);

      await expect(repo.findByIdOrThrow('mem-0001', ORG_B)).rejects.toThrow(NotFoundException);
    });
  });

  // ── searchSimilar ─────────────────────────────────────────────────────

  describe('searchSimilar()', () => {
    it('calls match_memories RPC with correct params and org filter', async () => {
      const similarRow = { ...MEMORY_ROW, similarity: 0.91 };
      const proxy = makeAdminProxy([similarRow]);
      repo = await buildRepo(proxy);

      const embedding = new Array(1536).fill(0.01);
      const results = await repo.searchSimilar(embedding, ORG_A, 5, 0.7);

      expect(proxy.rpc).toHaveBeenCalledWith('match_memories', {
        query_embedding: embedding,
        match_org_id: ORG_A,
        match_count: 5,
        match_threshold: 0.7,
      });
      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBe(0.91);
    });

    it('returns empty array when RPC returns null', async () => {
      const proxy = makeAdminProxy(null);
      repo = await buildRepo(proxy);

      const results = await repo.searchSimilar(new Array(1536).fill(0), ORG_A, 5, 0.7);
      expect(results).toEqual([]);
    });

    it('does NOT return results for org B when called with org A', async () => {
      // Simulates DB returning nothing when org doesn't match
      const proxy = makeAdminProxy([]);
      repo = await buildRepo(proxy);

      const results = await repo.searchSimilar(new Array(1536).fill(0), ORG_B, 5, 0.7);
      expect(results).toEqual([]);

      // Verify org_id was passed to the RPC
      expect(proxy.rpc).toHaveBeenCalledWith('match_memories', expect.objectContaining({
        match_org_id: ORG_B,
      }));
    });
  });
});
