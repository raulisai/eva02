import { Test, TestingModule } from '@nestjs/testing';
import { BackgroundReviewService, ReviewInput } from '../background-review.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { SkillDocsService } from '../skill-docs.service';
import { MemoryAgentService } from '../../memory/memory-agent.service';
import { EventBusService } from '../../events/event-bus.service';
import { AgentLoopStep } from '../agent-loop.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function step(tool: string, observation: string): AgentLoopStep {
  return { tool, args: { q: 'x' }, observation } as unknown as AgentLoopStep;
}

function reply(obj: unknown) {
  return {
    text: JSON.stringify(obj),
    model: 'gemini-2.5-flash-lite',
    backend: 'google' as const,
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  };
}

describe('BackgroundReviewService', () => {
  let service: BackgroundReviewService;
  let modelRouter: jest.Mocked<ModelRouterService>;
  let skillDocs: jest.Mocked<SkillDocsService>;
  let memoryAgent: jest.Mocked<MemoryAgentService>;
  let events: jest.Mocked<EventBusService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackgroundReviewService,
        { provide: ModelRouterService, useValue: { generate: jest.fn() } },
        { provide: EventBusService, useValue: { publish: jest.fn().mockResolvedValue('1-0') } },
        {
          provide: SkillDocsService,
          useValue: {
            getSkillIndex: jest.fn().mockResolvedValue([
              { slug: 'deploy-flow', description: 'cómo desplegar', category: 'coding', kind: 'doc', is_pinned: false, display_name: 'deploy', source: 'generated' },
            ]),
            viewSkill: jest.fn(),
            createSkill: jest.fn().mockResolvedValue({ ok: true, slug: 's', action: 'create', message: 'ok' }),
            editSkill: jest.fn().mockResolvedValue({ ok: true, slug: 's', action: 'edit', message: 'ok' }),
            patchSkill: jest.fn().mockResolvedValue({ ok: true, slug: 's', action: 'patch', message: 'ok' }),
            writeSkillFile: jest.fn().mockResolvedValue({ ok: true, slug: 's', action: 'write_file', message: 'ok' }),
          },
        },
        { provide: MemoryAgentService, useValue: { ingest: jest.fn().mockResolvedValue({ stored: true }) } },
      ],
    }).compile();

    service = module.get(BackgroundReviewService);
    modelRouter = module.get(ModelRouterService);
    skillDocs = module.get(SkillDocsService);
    memoryAgent = module.get(MemoryAgentService);
    events = module.get(EventBusService);
  });

  const input: ReviewInput = {
    orgId: ORG,
    taskId: TASK,
    goal: 'desplegar la app',
    steps: [step('terminal', 'build ok'), step('terminal', 'deploy ok')],
    finalText: 'Desplegado.',
  };

  it('inspects an existing skill with action=view before patching it', async () => {
    skillDocs.viewSkill.mockResolvedValue({
      slug: 'deploy-flow', display_name: 'deploy', description: 'd', category: 'coding',
      kind: 'doc', is_pinned: false, source: 'generated',
      content_md: 'Paso 1: build\nPaso 2: deploy', files: [], related_skills: [],
    });
    modelRouter.generate
      .mockResolvedValueOnce(reply({ action: 'view', slug: 'deploy-flow' }))
      .mockResolvedValueOnce(reply({
        action: 'patch', slug: 'deploy-flow',
        patch_find: 'Paso 2: deploy', patch_replace: 'Paso 2: deploy\nPaso 3: smoke test',
        reason: 'faltaba smoke test',
      }));

    await (service as unknown as { runSkillReview: (i: ReviewInput, t: string) => Promise<void> })
      .runSkillReview(input, 'transcript');

    expect(skillDocs.viewSkill).toHaveBeenCalledWith(ORG, 'deploy-flow');
    expect(skillDocs.patchSkill).toHaveBeenCalledWith(ORG, expect.objectContaining({
      slug: 'deploy-flow', find: 'Paso 2: deploy',
    }));
  });

  it('does not loop forever on repeated view of the same skill', async () => {
    skillDocs.viewSkill.mockResolvedValue({
      slug: 'deploy-flow', display_name: 'deploy', description: 'd', category: 'coding',
      kind: 'doc', is_pinned: false, source: 'generated', content_md: 'x', files: [], related_skills: [],
    });
    modelRouter.generate.mockResolvedValue(reply({ action: 'view', slug: 'deploy-flow' }));

    await (service as unknown as { runSkillReview: (i: ReviewInput, t: string) => Promise<void> })
      .runSkillReview(input, 'transcript');

    // First view consumed; the repeated view ends the loop → never patches/creates.
    expect(skillDocs.viewSkill).toHaveBeenCalledTimes(1);
    expect(skillDocs.patchSkill).not.toHaveBeenCalled();
    expect(skillDocs.createSkill).not.toHaveBeenCalled();
  });

  it('creates a new skill directly when no inspection is needed', async () => {
    modelRouter.generate.mockResolvedValueOnce(reply({
      action: 'create', slug: 'nueva', display_name: 'Nueva', description: 'd',
      category: 'coding', content_md: '# Nueva\ncontenido', reason: 'workflow nuevo',
    }));

    await (service as unknown as { runSkillReview: (i: ReviewInput, t: string) => Promise<void> })
      .runSkillReview(input, 'transcript');

    expect(skillDocs.viewSkill).not.toHaveBeenCalled();
    expect(skillDocs.createSkill).toHaveBeenCalledWith(ORG, expect.objectContaining({ slug: 'nueva' }));
  });

  it('surfaces a compact learning note to the user when a skill is created', async () => {
    modelRouter.generate.mockResolvedValueOnce(reply({
      action: 'create', slug: 'deploy-flow', display_name: 'Deploy', description: 'd',
      category: 'coding', content_md: '# Deploy', reason: 'nuevo workflow',
    }));

    await (service as unknown as { runSkillReview: (i: ReviewInput, t: string) => Promise<void> })
      .runSkillReview(input, 'transcript');

    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.say',
      orgId: ORG,
      taskId: TASK,
      payload: expect.objectContaining({ text: expect.stringContaining('deploy-flow') }),
    }));
  });

  it('scheduleReview skips when there are fewer than 2 meaningful steps', () => {
    const spy = jest.spyOn(service as unknown as { runReview: (i: ReviewInput) => Promise<void> }, 'runReview');
    service.scheduleReview({ ...input, steps: [step('terminal', 'ERROR: boom')] });
    expect(spy).not.toHaveBeenCalled();
  });

  // ── nudge counter gating ──────────────────────────────────────────────────

  describe('nudge counter gating', () => {
    let runReviewSpy: jest.SpyInstance;

    beforeEach(() => {
      runReviewSpy = jest
        .spyOn(service as unknown as { runReview: (i: ReviewInput) => Promise<void> }, 'runReview')
        .mockResolvedValue(undefined);
    });

    it('defers review for the first 4 completions (below REVIEW_INTERVAL=5)', () => {
      for (let i = 0; i < 4; i++) {
        service.scheduleReview(input);
      }
      expect(runReviewSpy).not.toHaveBeenCalled();
    });

    it('fires on the 5th completion and resets the counter', () => {
      for (let i = 0; i < 5; i++) {
        service.scheduleReview(input);
      }
      expect(runReviewSpy).toHaveBeenCalledTimes(1);

      // Counter reset — next 4 should defer again
      for (let i = 0; i < 4; i++) {
        service.scheduleReview(input);
      }
      expect(runReviewSpy).toHaveBeenCalledTimes(1);

      // 5th again fires
      service.scheduleReview(input);
      expect(runReviewSpy).toHaveBeenCalledTimes(2);
    });

    it('nudge=true always fires immediately regardless of counter', () => {
      // Only 1 completion, but nudge is true (user steer happened)
      service.scheduleReview({ ...input, nudge: true });
      expect(runReviewSpy).toHaveBeenCalledTimes(1);
    });

    it('nudge=true resets the counter so the next interval starts fresh', () => {
      // Advance counter to 3 (below interval)
      for (let i = 0; i < 3; i++) {
        service.scheduleReview(input);
      }
      expect(runReviewSpy).not.toHaveBeenCalled();

      // Nudge fires and resets counter to 0
      service.scheduleReview({ ...input, nudge: true });
      expect(runReviewSpy).toHaveBeenCalledTimes(1);

      // Counter is now 0 — needs 5 more to fire again (not 2 as it would if not reset)
      for (let i = 0; i < 4; i++) {
        service.scheduleReview(input);
      }
      expect(runReviewSpy).toHaveBeenCalledTimes(1);

      service.scheduleReview(input);
      expect(runReviewSpy).toHaveBeenCalledTimes(2);
    });

    it('user_steer steps are excluded from the meaningful-steps count', () => {
      // Only meaningful step is the user_steer — should not count as meaningful work
      const steerOnlyInput: ReviewInput = {
        ...input,
        steps: [step('user_steer', 'MENSAJE DEL USUARIO: haz X'), step('final_answer', 'ok')],
      };
      service.scheduleReview(steerOnlyInput);
      expect(runReviewSpy).not.toHaveBeenCalled();
    });
  });
});
