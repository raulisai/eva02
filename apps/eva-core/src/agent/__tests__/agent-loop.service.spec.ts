import { Test, TestingModule } from '@nestjs/testing';
import { AgentLoopService } from '../agent-loop.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { GmailService } from '../gmail.service';
import { GoogleCalendarService } from '../google-calendar.service';
import { GoogleDriveService } from '../google-drive.service';
import { MemoryAgentService } from '../../memory/memory-agent.service';
import { MissingInformationError, ResearchToolsService } from '../research-tools.service';
import { ScheduleService } from '../schedule.service';
import { ScriptForgeService } from '../script-forge.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** Builds a fake modelRouter.generate reply with token usage. */
function modelReply(text: string, tokens = 40) {
  return {
    text,
    model: 'gemini-2.5-flash-lite',
    backend: 'google' as const,
    usage: { promptTokens: tokens / 2, completionTokens: tokens / 2, totalTokens: tokens },
  };
}

describe('AgentLoopService', () => {
  let service: AgentLoopService;
  let modelRouter: jest.Mocked<ModelRouterService>;
  let research: jest.Mocked<ResearchToolsService>;
  let gmail: jest.Mocked<GmailService>;
  let forge: jest.Mocked<ScriptForgeService>;
  let memoryAgent: jest.Mocked<MemoryAgentService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentLoopService,
        { provide: ModelRouterService, useValue: { generate: jest.fn() } },
        {
          provide: ResearchToolsService,
          useValue: {
            answer: jest.fn().mockResolvedValue({ text: 'Clima: 22°C despejado', tool: 'public-api', sources: [] }),
          },
        },
        {
          provide: GmailService,
          useValue: {
            fetchLatest: jest.fn().mockResolvedValue({ ok: true, text: '1 correo de Banco' }),
            fetchSearchWithFallback: jest.fn().mockResolvedValue({ ok: true, text: 'correo de Ana' }),
          },
        },
        {
          provide: GoogleCalendarService,
          useValue: { formatUpcomingForSoul: jest.fn().mockResolvedValue('- Junta 10am') },
        },
        {
          provide: ScheduleService,
          useValue: { formatUpcomingForSoul: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: GoogleDriveService,
          useValue: { fetchForQuery: jest.fn().mockResolvedValue({ ok: true, text: '3 archivos' }) },
        },
        {
          provide: MemoryAgentService,
          useValue: { recall: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ScriptForgeService,
          useValue: {
            forge: jest.fn().mockResolvedValue({
              language: 'python', filename: 'calc.py', description: 'calc',
              executed: true, output: '42',
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AgentLoopService);
    modelRouter = module.get(ModelRouterService);
    research = module.get(ResearchToolsService);
    gmail = module.get(GmailService);
    forge = module.get(ScriptForgeService);
    memoryAgent = module.get(MemoryAgentService);
  });

  it('returns the final answer when the model answers directly', async () => {
    modelRouter.generate.mockResolvedValueOnce(
      modelReply('{"thought":"ya sé","tool":"final_answer","args":{"text":"Hola, listo."}}'),
    );

    const result = await service.run(ORG, TASK, 'saluda');

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hola, listo.');
    expect(result.steps).toHaveLength(0);
    expect(result.tokensUsed).toBe(40);
  });

  it('executes a tool, feeds the observation back, and finishes', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"buscar","tool":"web_search","args":{"query":"clima CDMX"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"listo","tool":"final_answer","args":{"text":"Hace 22°C."}}'));

    const result = await service.run(ORG, TASK, 'clima en CDMX');

    expect(research.answer).toHaveBeenCalledWith('clima CDMX', ORG);
    // The second decide prompt must include the first observation
    const secondPrompt = modelRouter.generate.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('Clima: 22°C despejado');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hace 22°C.');
    expect(result.toolsUsed).toEqual(['web_search']);
    expect(result.tokensUsed).toBe(80);
  });

  it('reports unknown tools as observations and keeps going', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"x","tool":"hack_nasa","args":{}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"hecho"}}'));

    const result = await service.run(ORG, TASK, 'objetivo');

    expect(result.ok).toBe(true);
    expect(result.steps[0].observation).toContain('herramienta desconocida');
  });

  it('blocks identical repeated actions with a loop-guard observation', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"a","tool":"web_search","args":{"query":"x"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"a","tool":"web_search","args":{"query":"x"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"fin"}}'));

    const result = await service.run(ORG, TASK, 'objetivo');

    expect(research.answer).toHaveBeenCalledTimes(1);
    expect(result.steps[1].observation).toContain('acción repetida');
    expect(result.text).toBe('fin');
  });

  it('synthesises an answer when steps run out with findings gathered', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"1","tool":"web_search","args":{"query":"a"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"2","tool":"gmail_read","args":{}}'))
      .mockResolvedValueOnce(modelReply('Resumen final con lo encontrado.'));

    const result = await service.run(ORG, TASK, 'objetivo', { maxSteps: 2 });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Resumen final con lo encontrado.');
    // Synthesis prompt carries the observations
    const synthesisPrompt = modelRouter.generate.mock.calls[2][0] as string;
    expect(synthesisPrompt).toContain('Clima: 22°C despejado');
    expect(synthesisPrompt).toContain('1 correo de Banco');
  });

  it('aborts after two consecutive unparseable decisions', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('no soy json'))
      .mockResolvedValueOnce(modelReply('tampoco'));

    const result = await service.run(ORG, TASK, 'objetivo');

    expect(result.ok).toBe(false);
    expect(modelRouter.generate).toHaveBeenCalledTimes(2);
  });

  it('delegates a sub-goal to a sub-agent and uses its answer as observation', async () => {
    modelRouter.generate
      // root decides to delegate
      .mockResolvedValueOnce(modelReply('{"thought":"divide","tool":"delegate","args":{"goal":"averigua el clima"}}'))
      // sub-agent answers directly
      .mockResolvedValueOnce(modelReply('{"thought":"fácil","tool":"final_answer","args":{"text":"Sub: hace sol"}}'))
      // root closes with the delegated info
      .mockResolvedValueOnce(modelReply('{"thought":"listo","tool":"final_answer","args":{"text":"Hace sol, confirmado."}}'));

    const result = await service.run(ORG, TASK, 'plan del día');

    expect(result.ok).toBe(true);
    expect(result.steps[0].tool).toBe('delegate');
    expect(result.steps[0].observation).toBe('Sub: hace sol');
    expect(result.text).toBe('Hace sol, confirmado.');
  });

  it('hides delegate from sub-agents (no infinite recursion)', async () => {
    modelRouter.generate.mockResolvedValueOnce(
      modelReply('{"thought":"x","tool":"final_answer","args":{"text":"ok"}}'),
    );

    await service.run(ORG, TASK, 'subtarea', { depth: 1 });

    const prompt = modelRouter.generate.mock.calls[0][0] as string;
    expect(prompt).not.toContain('delegate{');
  });

  it('propagates MissingInformationError so agent-runner can raise a form', async () => {
    modelRouter.generate.mockResolvedValueOnce(
      modelReply('{"thought":"buscar","tool":"web_search","args":{"query":"uber"}}'),
    );
    research.answer.mockRejectedValueOnce(new MissingInformationError('falta origen', {
      form_key: 'k', title: 't', description: 'd', fields: [],
    }));

    await expect(service.run(ORG, TASK, 'objetivo')).rejects.toThrow(MissingInformationError);
  });

  it('turns tool failures into ERROR observations instead of crashing', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"código","tool":"script_forge","args":{"spec":"suma"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"no pude"}}'));
    forge.forge.mockRejectedValueOnce(new Error('docker explotó'));

    const result = await service.run(ORG, TASK, 'calcula');

    expect(result.steps[0].observation).toContain('ERROR: docker explotó');
    expect(result.ok).toBe(true);
  });

  it('uses memory_recall and formats memories with dates', async () => {
    memoryAgent.recall.mockResolvedValueOnce([
      { id: 'm1', summary: 'Le gusta el café', created_at: '2026-06-01T10:00:00Z', similarity: 0.9 } as never,
    ]);
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"recordar","tool":"memory_recall","args":{"query":"café"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"Te gusta el café."}}'));

    const result = await service.run(ORG, TASK, '¿qué me gusta?');

    expect(memoryAgent.recall).toHaveBeenCalledWith('café', ORG, 5, 0.6);
    expect(result.steps[0].observation).toContain('[2026-06-01] Le gusta el café');
  });
});
