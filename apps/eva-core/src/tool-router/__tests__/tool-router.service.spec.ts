import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ToolRouterService } from '../tool-router.service';
import type { ToolDefinition } from '../tool-router.types';

function makeTool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name:         'test-tool',
    capabilities: ['test'],
    costPerToken:  5,
    avgLatencyMs:  500,
    maxTokens:     4096,
    available:     true,
    description:   'A test tool',
    ...overrides,
  };
}

describe('ToolRouterService', () => {
  let service: ToolRouterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ToolRouterService],
    }).compile();
    service = module.get(ToolRouterService);
  });

  // ── route() — happy paths ──────────────────────────────────────────────────

  describe('route()', () => {
    it('routes "generate" capability to llm-generate', () => {
      const decision = service.route('generate');
      expect(decision.tool.name).toBe('llm-generate');
      expect(decision.matchedCapability).toBe('generate');
    });

    it('routes "search" capability to web-search', () => {
      const decision = service.route('search');
      expect(decision.tool.name).toBe('web-search');
    });

    it('routes "code" capability to code-executor', () => {
      const decision = service.route('code');
      expect(decision.tool.name).toBe('code-executor');
    });

    it('routes "recall" capability to memory-recall', () => {
      const decision = service.route('recall');
      expect(decision.tool.name).toBe('memory-recall');
    });

    it('routes "read" capability to file-reader', () => {
      const decision = service.route('read');
      expect(decision.tool.name).toBe('file-reader');
    });

    it('routes "approve" capability to approval-gate', () => {
      const decision = service.route('approve');
      expect(decision.tool.name).toBe('approval-gate');
    });

    it('routes "sql" capability to data-query', () => {
      const decision = service.route('sql');
      expect(decision.tool.name).toBe('data-query');
    });

    it('routes "webhook" capability to api-call', () => {
      const decision = service.route('webhook');
      expect(decision.tool.name).toBe('api-call');
    });

    it('includes alternates list (may be empty)', () => {
      const decision = service.route('generate');
      expect(Array.isArray(decision.alternates)).toBe(true);
    });

    it('score is a finite non-negative number', () => {
      const { score } = service.route('generate');
      expect(isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  // ── budget filtering ──────────────────────────────────────────────────────

  describe('route() with budget', () => {
    it('cheap budget prefers lower-cost tools', () => {
      // Both web-search (cost 2) and llm-generate (cost 10) match "search"
      // cheap budget → web-search wins
      const decision = service.route('search', { budget: 'cheap' });
      expect(decision.tool.costPerToken).toBeLessThanOrEqual(4);
    });

    it('cheap budget excludes high-cost tools', () => {
      // llm-generate costs 10 — above cheap ceiling of 4
      // "generate" only matches llm-generate so cheap budget → NotFoundException
      expect(() => service.route('generate', { budget: 'cheap' })).toThrow(NotFoundException);
    });

    it('powerful budget allows all tools', () => {
      // llm-generate is the most expensive but should still route under powerful
      const decision = service.route('generate', { budget: 'powerful' });
      expect(decision.tool.name).toBe('llm-generate');
    });
  });

  // ── latency filtering ─────────────────────────────────────────────────────

  describe('route() with maxLatencyMs', () => {
    it('excludes tools exceeding latency cap', () => {
      // web-search has 800ms avg latency — too slow
      expect(() => service.route('web', { maxLatencyMs: 500 })).toThrow(NotFoundException);
    });

    it('allows tools within latency cap', () => {
      // file-reader has 100ms avg latency — fast enough
      const decision = service.route('read', { maxLatencyMs: 200 });
      expect(decision.tool.name).toBe('file-reader');
    });

    it('approval-gate (latency 0) passes any latency cap', () => {
      const decision = service.route('approve', { maxLatencyMs: 1 });
      expect(decision.tool.name).toBe('approval-gate');
    });
  });

  // ── excludeTools ──────────────────────────────────────────────────────────

  describe('route() with excludeTools', () => {
    it('skips excluded tools', () => {
      service.register(makeTool({ name: 'custom-search', capabilities: ['search'], costPerToken: 1, avgLatencyMs: 100 }));
      const decision = service.route('search', { excludeTools: ['web-search'] });
      expect(decision.tool.name).not.toBe('web-search');
    });

    it('throws when only candidate is excluded', () => {
      expect(() => service.route('approve', { excludeTools: ['approval-gate'] }))
        .toThrow(NotFoundException);
    });
  });

  // ── unavailable tools ──────────────────────────────────────────────────────

  describe('availability', () => {
    it('skips unavailable tools', () => {
      service.setAvailable('approval-gate', false);
      expect(() => service.route('approve')).toThrow(NotFoundException);
    });

    it('re-routes after tool is restored to available', () => {
      service.setAvailable('approval-gate', false);
      service.setAvailable('approval-gate', true);
      const decision = service.route('approve');
      expect(decision.tool.name).toBe('approval-gate');
    });
  });

  // ── register() custom tools ───────────────────────────────────────────────

  describe('register()', () => {
    it('registers a custom tool and routes to it', () => {
      const custom = makeTool({
        name:         'my-custom-llm',
        capabilities: ['generate', 'custom-gen'],
        costPerToken:  1,   // cheapest
        avgLatencyMs:  50,
      });
      service.register(custom);

      const decision = service.route('custom-gen');
      expect(decision.tool.name).toBe('my-custom-llm');
    });

    it('custom tool with lower cost beats built-in under cheap budget', () => {
      service.register(makeTool({
        name:         'cheap-search',
        capabilities: ['search'],
        costPerToken:  1,
        avgLatencyMs:  200,
      }));
      const decision = service.route('search', { budget: 'cheap' });
      expect(decision.tool.name).toBe('cheap-search');
    });
  });

  // ── routeAll() ────────────────────────────────────────────────────────────

  describe('routeAll()', () => {
    it('returns a decision for each capability', () => {
      const decisions = service.routeAll(['search', 'generate', 'recall']);
      expect(Object.keys(decisions)).toEqual(['search', 'generate', 'recall']);
      expect(decisions['search'].tool.name).toBe('web-search');
    });
  });

  // ── listAll() ─────────────────────────────────────────────────────────────

  describe('listAll()', () => {
    it('returns all registered tools', () => {
      const tools = service.listAll();
      expect(tools.length).toBeGreaterThanOrEqual(8); // at least the 8 built-ins
      expect(tools.every(t => typeof t.name === 'string')).toBe(true);
    });
  });

  // ── throws ────────────────────────────────────────────────────────────────

  describe('error cases', () => {
    it('throws NotFoundException for unknown capability', () => {
      expect(() => service.route('completely-unknown-xyz')).toThrow(NotFoundException);
    });
  });
});
