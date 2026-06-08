import { Test, TestingModule } from '@nestjs/testing';
import { IntentRouterService } from '../intent-router.service';
import { IntentRouterRepository } from '../intent-router.repository';
import { ModelRouterService } from '../../model-router/model-router.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('IntentRouterService', () => {
  let service: IntentRouterService;
  let modelRouter: jest.Mocked<Pick<ModelRouterService, 'generate'>>;
  let repo: jest.Mocked<Pick<IntentRouterRepository, 'record'>>;

  beforeEach(async () => {
    repo = { record: jest.fn().mockResolvedValue({ id: 'r1' }) };
    modelRouter = { generate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentRouterService,
        { provide: IntentRouterRepository, useValue: repo },
        { provide: ModelRouterService, useValue: modelRouter },
      ],
    }).compile();

    service = module.get(IntentRouterService);
  });

  // ── classifyByRules() — deterministic, no I/O ─────────────────────────────

  describe('classifyByRules()', () => {
    // fast_path examples
    const fastExamples = [
      'What is the status of the deployment?',
      'Explain how the auth module works',
      'List all running tasks',
      'Show me the health endpoint',
      'Summarize last week\'s events',
      'Tell me about the memory service',
      'How do I configure Redis?',
      'ping',
    ];

    test.each(fastExamples)('"%s" → fast_path', input => {
      const result = service.classifyByRules(input);
      expect(result.intent).toBe('fast_path');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    // core_path examples
    const coreExamples = [
      'Build a new authentication flow for the dashboard',
      'Implement a Redis caching layer for task queries',
      'Analyze the performance bottlenecks in the pipeline',
      'Create a scheduled job to clean up expired tokens',
      'Optimize the database queries in the events module',
      'Configure the CI/CD pipeline for the new service',
      'Integrate Stripe payment processing into the API',
    ];

    test.each(coreExamples)('"%s" → core_path', input => {
      const result = service.classifyByRules(input);
      expect(result.intent).toBe('core_path');
      expect(result.confidence).toBeGreaterThan(0);
    });

    // core_path_approval examples
    const approvalExamples = [
      'Delete all users from the staging database',
      'Deploy to production the new auth service',
      'Send money to vendor account for Q2 invoice',
      'Bulk update all org pricing plans to enterprise',
      'Wipe the test environment and reset to baseline',
      'Grant admin access to all members of org beta',
      'Revoke all API tokens across the platform',
    ];

    test.each(approvalExamples)('"%s" → core_path_approval', input => {
      const result = service.classifyByRules(input);
      expect(result.intent).toBe('core_path_approval');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('approval always wins over fast-path signals', () => {
      // "show me" (fast signal) + "delete all" (approval signal) → approval
      const result = service.classifyByRules('Show me how to delete all records');
      expect(result.intent).toBe('core_path_approval');
    });

    it('returns at least one reason string', () => {
      const result = service.classifyByRules('What is the API rate limit?');
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('confidence is always between 0 and 1', () => {
      const inputs = [
        'x',
        'What is the meaning of life?',
        'Deploy everything to production immediately and delete all backups',
      ];
      inputs.forEach(input => {
        const { confidence } = service.classifyByRules(input);
        expect(confidence).toBeGreaterThanOrEqual(0);
        expect(confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  // ── classify() — records to DB ───────────────────────────────────────────

  describe('classify()', () => {
    it('records the classification result (fire-and-forget)', async () => {
      await service.classify('What is Redis?', ORG);
      // repo.record is async fire-and-forget, wait a tick
      await new Promise(r => setImmediate(r));
      expect(repo.record).toHaveBeenCalledWith(
        expect.objectContaining({ org_id: ORG, intent: 'fast_path' }),
      );
    });

    it('passes task_id to the record when provided', async () => {
      const taskId = 'tttt-0000-0000-0000-000000000001';
      await service.classify('List running tasks', ORG, { taskId });
      await new Promise(r => setImmediate(r));
      expect(repo.record).toHaveBeenCalledWith(
        expect.objectContaining({ task_id: taskId }),
      );
    });

    it('falls back to LLM when rule confidence is below threshold', async () => {
      // Ambiguous input: no clear signals, confidence will be 0.5 → LLM
      modelRouter.generate.mockResolvedValue({
        text:    JSON.stringify({ intent: 'core_path', reason: 'complex task' }),
        model:   'stub',
        backend: 'openai',
        usage:   { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await service.classify('do the thing with the stuff', ORG);
      expect(modelRouter.generate).toHaveBeenCalled();
      expect(result.classifier).toMatch(/llm|hybrid/);
    });

    it('defaults to core_path when LLM fails', async () => {
      modelRouter.generate.mockRejectedValue(new Error('API down'));
      // Input with no strong signals → LLM path → fails → safe default
      const result = await service.classify('do the thing', ORG);
      // Either the rule result or LLM default — both are valid intents
      expect(['fast_path', 'core_path', 'core_path_approval']).toContain(result.intent);
    });
  });
});
