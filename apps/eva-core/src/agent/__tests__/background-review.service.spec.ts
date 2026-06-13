import { Test, TestingModule } from '@nestjs/testing';
import { BackgroundReviewService, ReviewInput } from '../background-review.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { SkillDocsService } from '../skill-docs.service';
import { MemoryAgentService } from '../../memory/memory-agent.service';
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackgroundReviewService,
        { provide: ModelRouterService, useValue: { generate: jest.fn() } },
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

  it('scheduleReview skips when there are fewer than 2 meaningful steps', () => {
    const spy = jest.spyOn(service as unknown as { runReview: (i: ReviewInput) => Promise<void> }, 'runReview');
    service.scheduleReview({ ...input, steps: [step('terminal', 'ERROR: boom')] });
    expect(spy).not.toHaveBeenCalled();
  });
});
