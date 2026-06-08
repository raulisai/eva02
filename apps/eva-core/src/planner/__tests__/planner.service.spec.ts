import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PlannerService } from '../planner.service';
import { PlanSchema } from '../planner.types';
import { ModelRouterService } from '../../model-router/model-router.service';
import { IntentRouterService } from '../../intent-router/intent-router.service';
import type { GenerateResult } from '../../model-router/model-router.types';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makePlanJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal:                   'Test goal',
    intent:                 'core_path',
    steps: [
      { step: 1, description: 'Recall context', tool: 'memory-recall', inputs: {}, requires_approval: false },
      { step: 2, description: 'Generate output', tool: 'llm-generate', inputs: {}, requires_approval: false },
    ],
    estimated_total_tokens: 400,
    ...overrides,
  });
}

function makeGenerateResult(text: string): GenerateResult {
  return { text, model: 'gpt-4o-mini', backend: 'openai', usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 } };
}

describe('PlannerService', () => {
  let service: PlannerService;
  let modelRouter: jest.Mocked<Pick<ModelRouterService, 'generate'>>;
  let intentRouter: jest.Mocked<Pick<IntentRouterService, 'classify'>>;

  beforeEach(async () => {
    modelRouter  = { generate: jest.fn() };
    intentRouter = { classify: jest.fn().mockResolvedValue({ intent: 'core_path', confidence: 0.85, classifier: 'rules', reasons: [] }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlannerService,
        { provide: ModelRouterService, useValue: modelRouter },
        { provide: IntentRouterService, useValue: intentRouter },
      ],
    }).compile();

    service = module.get(PlannerService);
  });

  // ── parseAndValidate() — Zod schema enforcement ──────────────────────────

  describe('parseAndValidate() — Zod schema validation', () => {
    it('accepts a valid plan JSON', () => {
      const plan = service.parseAndValidate(makePlanJson(), 'core_path');
      expect(plan.goal).toBe('Test goal');
      expect(plan.intent).toBe('core_path');
      expect(plan.steps).toHaveLength(2);
    });

    it('injects intent from classifier when missing in JSON', () => {
      const json = makePlanJson({ intent: undefined });
      const plan  = service.parseAndValidate(json, 'fast_path');
      expect(plan.intent).toBe('fast_path');
    });

    it('rejects empty steps array', () => {
      expect(() => service.parseAndValidate(makePlanJson({ steps: [] }), 'core_path'))
        .toThrow(BadRequestException);
    });

    it('rejects steps with missing required fields', () => {
      const bad = makePlanJson({
        steps: [{ step: 1, tool: 'llm-generate' }], // missing description
      });
      expect(() => service.parseAndValidate(bad, 'core_path')).toThrow(BadRequestException);
    });

    it('rejects steps exceeding the limit of 20', () => {
      const steps = Array.from({ length: 21 }, (_, i) => ({
        step: i + 1, description: `Step ${i + 1}`, tool: 'llm-generate', inputs: {}, requires_approval: false,
      }));
      expect(() => service.parseAndValidate(makePlanJson({ steps }), 'core_path'))
        .toThrow(BadRequestException);
    });

    it('rejects invalid intent value', () => {
      expect(() => service.parseAndValidate(makePlanJson({ intent: 'unknown_intent' }), 'core_path'))
        .toThrow(BadRequestException);
    });

    it('rejects malformed JSON', () => {
      expect(() => service.parseAndValidate('not json at all', 'core_path'))
        .toThrow(BadRequestException);
    });

    it('coerces missing inputs to empty object', () => {
      const json = makePlanJson({
        steps: [{ step: 1, description: 'Do something', tool: 'llm-generate', requires_approval: false }],
      });
      const plan = service.parseAndValidate(json, 'core_path');
      expect(plan.steps[0].inputs).toEqual({});
    });

    it('coerces missing requires_approval to false', () => {
      const json = makePlanJson({
        steps: [{ step: 1, description: 'Do something', tool: 'llm-generate' }],
      });
      const plan = service.parseAndValidate(json, 'core_path');
      expect(plan.steps[0].requires_approval).toBe(false);
    });
  });

  // ── planDeterministic() — no LLM needed ──────────────────────────────────

  describe('planDeterministic()', () => {
    it('produces a Zod-valid plan for fast_path', () => {
      const plan = service.planDeterministic('What is the status?', 'fast_path');
      expect(() => PlanSchema.parse(plan)).not.toThrow();
      expect(plan.intent).toBe('fast_path');
      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0].tool).toBe('llm-generate');
    });

    it('produces a Zod-valid plan for core_path', () => {
      const plan = service.planDeterministic('Analyze sales data', 'core_path');
      expect(() => PlanSchema.parse(plan)).not.toThrow();
      expect(plan.intent).toBe('core_path');
      expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    });

    it('includes memory-recall step for core_path', () => {
      const plan = service.planDeterministic('Build a caching layer', 'core_path');
      const tools = plan.steps.map(s => s.tool);
      expect(tools).toContain('memory-recall');
    });

    it('includes code-executor when goal mentions code', () => {
      const plan = service.planDeterministic('Write a Python script to process CSV files', 'core_path');
      const tools = plan.steps.map(s => s.tool);
      expect(tools).toContain('code-executor');
    });

    it('includes web-search step when goal mentions search', () => {
      const plan = service.planDeterministic('Search for latest Redis benchmarks', 'core_path');
      const tools = plan.steps.map(s => s.tool);
      expect(tools).toContain('web-search');
    });

    it('includes approval-gate for core_path_approval', () => {
      const plan = service.planDeterministic('Delete all test users', 'core_path_approval');
      const approvalStep = plan.steps.find(s => s.tool === 'approval-gate');
      expect(approvalStep).toBeDefined();
      expect(approvalStep?.requires_approval).toBe(true);
    });

    it('all steps have positive sequential step numbers', () => {
      const plan = service.planDeterministic('Build something complex', 'core_path');
      plan.steps.forEach((s, idx) => {
        expect(s.step).toBe(idx + 1);
      });
    });

    it('estimated_total_tokens is a non-negative integer', () => {
      const plan = service.planDeterministic('Any goal', 'core_path');
      expect(plan.estimated_total_tokens).toBeGreaterThanOrEqual(0);
    });
  });

  // ── plan() — LLM path + auto-classify ────────────────────────────────────

  describe('plan()', () => {
    it('calls modelRouter.generate and returns validated plan', async () => {
      modelRouter.generate.mockResolvedValue(makeGenerateResult(makePlanJson()));

      const plan = await service.plan({ goal: 'Analyze logs', intent: 'core_path', orgId: ORG });
      expect(modelRouter.generate).toHaveBeenCalled();
      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });

    it('auto-classifies intent when not provided', async () => {
      modelRouter.generate.mockResolvedValue(makeGenerateResult(makePlanJson()));

      await service.plan({ goal: 'Analyze logs', orgId: ORG });
      expect(intentRouter.classify).toHaveBeenCalledWith('Analyze logs', ORG);
    });

    it('falls back to deterministic plan when LLM fails', async () => {
      modelRouter.generate.mockRejectedValue(new Error('timeout'));

      const plan = await service.plan({ goal: 'Build a script', intent: 'core_path', orgId: ORG });
      expect(() => PlanSchema.parse(plan)).not.toThrow();
      expect(plan.steps.length).toBeGreaterThan(0);
    });

    it('uses intent from dto when provided (skips classify call)', async () => {
      modelRouter.generate.mockResolvedValue(makeGenerateResult(makePlanJson({ intent: 'fast_path' })));

      await service.plan({ goal: 'Explain Redis', intent: 'fast_path', orgId: ORG });
      expect(intentRouter.classify).not.toHaveBeenCalled();
    });
  });
});
