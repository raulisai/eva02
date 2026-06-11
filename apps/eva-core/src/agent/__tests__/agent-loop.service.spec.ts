import { Test, TestingModule } from '@nestjs/testing';
import { AgentLoopService } from '../agent-loop.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { IntegrationsService } from '../../integrations/integrations.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { GmailService } from '../gmail.service';
import { GoogleCalendarService } from '../google-calendar.service';
import { GoogleDriveService } from '../google-drive.service';
import { MemoryAgentService } from '../../memory/memory-agent.service';
import { MissingInformationError, ResearchToolsService } from '../research-tools.service';
import { SandboxService } from '../sandbox.service';
import { ScheduleService } from '../schedule.service';
import { ScriptForgeService } from '../script-forge.service';
import { SkillLibraryService } from '../skill-library.service';

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
  let sandbox: jest.Mocked<SandboxService>;
  let skillLibrary: jest.Mocked<SkillLibraryService>;
  let approvals: jest.Mocked<ApprovalsService>;

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
          useValue: {
            recall: jest.fn().mockResolvedValue([]),
            ingest: jest.fn().mockResolvedValue({ stored: true }),
          },
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
        {
          provide: SandboxService,
          useValue: {
            execInSession: jest.fn().mockResolvedValue({ ok: true, output: 'resultado: 7' }),
            runOneShot: jest.fn().mockResolvedValue({ ok: true, output: 'net ok' }),
            readBackgroundOutput: jest.fn().mockResolvedValue({ ok: true, output: 'bg log' }),
            release: jest.fn().mockResolvedValue(undefined),
            dockerAvailable: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: SkillLibraryService,
          useValue: {
            findRelevant: jest.fn().mockResolvedValue([]),
            getRunnable: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApprovalsService,
          useValue: {
            requestForPreparedAction: jest.fn().mockResolvedValue({ id: 'ap-1', action_hash: 'hash-1234567890ab' }),
          },
        },
        {
          provide: IntegrationsService,
          useValue: { list: jest.fn().mockResolvedValue([]), getSecret: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get(AgentLoopService);
    modelRouter = module.get(ModelRouterService);
    research = module.get(ResearchToolsService);
    gmail = module.get(GmailService);
    forge = module.get(ScriptForgeService);
    memoryAgent = module.get(MemoryAgentService);
    sandbox = module.get(SandboxService);
    skillLibrary = module.get(SkillLibraryService);
    approvals = module.get(ApprovalsService);
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

  // ── code_execute: el modelo escribe código literal ─────────────────────────

  it('executes literal model-written code in the task sandbox session', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"calcular","tool":"code_execute","args":{"language":"python","code":"print(3+4)"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"Es 7."}}'));

    const result = await service.run(ORG, TASK, 'calcula 3+4 con código');

    expect(sandbox.execInSession).toHaveBeenCalledWith(TASK, { kind: 'python', code: 'print(3+4)', orgId: ORG });
    expect(result.steps[0].observation).toBe('resultado: 7');
    expect(result.text).toBe('Es 7.');
  });

  it('feeds sandbox errors back so the model can fix its own code', async () => {
    sandbox.execInSession
      .mockResolvedValueOnce({ ok: false, output: 'SyntaxError: invalid syntax', error: 'exit 1' })
      .mockResolvedValueOnce({ ok: true, output: '7' });
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"v1","tool":"code_execute","args":{"language":"python","code":"print(3+4"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"corrijo","tool":"code_execute","args":{"language":"python","code":"print(3+4)"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"7"}}'));

    const result = await service.run(ORG, TASK, 'suma con código');

    expect(result.steps[0].observation).toContain('SyntaxError');
    // El segundo decide ve el error y el código anterior en PASOS PREVIOS
    const secondPrompt = modelRouter.generate.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('SyntaxError');
    expect(secondPrompt).toContain('print(3+4');
    expect(result.text).toBe('7');
  });

  it('routes network execution through the Approval Engine instead of running it', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"necesito red","tool":"code_execute","args":{"language":"python","code":"import requests","network":true}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"aviso","tool":"final_answer","args":{"text":"Quedó pendiente de aprobación."}}'));

    const result = await service.run(ORG, TASK, 'llama una API', { userId: 'user-1' });

    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, userId: 'user-1', taskId: TASK,
      actionType: 'sandbox.network_exec',
      payload: { language: 'python', code: 'import requests' },
    }));
    expect(sandbox.execInSession).not.toHaveBeenCalled();
    expect(sandbox.runOneShot).not.toHaveBeenCalled();
    expect(result.steps[0].observation).toContain('PENDIENTE DE APROBACIÓN');
  });

  // ── terminal ───────────────────────────────────────────────────────────────

  it('runs terminal commands and reads background output', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"inspecciono","tool":"terminal_run","args":{"cmd":"ls /work"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"leo bg","tool":"terminal_output","args":{}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"listo"}}'));

    const result = await service.run(ORG, TASK, 'inspecciona el workspace');

    expect(sandbox.execInSession).toHaveBeenCalledWith(TASK, { kind: 'terminal', code: 'ls /work', orgId: ORG, background: false });
    expect(sandbox.readBackgroundOutput).toHaveBeenCalledWith(TASK);
    expect(result.steps[1].observation).toBe('bg log');
  });

  // ── skills reutilizables ───────────────────────────────────────────────────

  it('injects relevant saved skills into the prompt and runs them via skill_run', async () => {
    skillLibrary.findRelevant.mockResolvedValue([
      { slug: 'gen-cleaner', display_name: 'cleaner.py', description: 'Limpia descargas' },
    ]);
    skillLibrary.getRunnable.mockResolvedValue({
      slug: 'gen-cleaner', language: 'python', code: 'print("clean")', filename: 'cleaner.py',
    });
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"reuso","tool":"skill_run","args":{"slug":"gen-cleaner"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"Limpio."}}'));

    const result = await service.run(ORG, TASK, 'limpia mis descargas');

    const firstPrompt = modelRouter.generate.mock.calls[0][0] as string;
    expect(firstPrompt).toContain('SKILLS GUARDADAS');
    expect(firstPrompt).toContain('gen-cleaner');
    expect(sandbox.execInSession).toHaveBeenCalledWith(TASK, { kind: 'python', code: 'print("clean")', orgId: ORG });
    expect(result.steps[0].observation).toContain('[skill gen-cleaner]');
  });

  it('reports missing skills as observations', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"x","tool":"skill_run","args":{"slug":"no-existe"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"sin skill"}}'));

    const result = await service.run(ORG, TASK, 'objetivo');

    expect(result.steps[0].observation).toContain('no encontré la skill');
  });

  // ── secrets en prompt ──────────────────────────────────────────────────────

  it('lists available secret aliases in the prompt without exposing values', async () => {
    const integrations = (service as unknown as { integrations: { list: jest.Mock } }).integrations;
    integrations.list.mockResolvedValue([
      { provider: 'stripe', has_secret: true, status: 'active' },
      { provider: 'inactivo', has_secret: true, status: 'disabled' },
    ]);
    modelRouter.generate.mockResolvedValueOnce(
      modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"hecho"}}'),
    );

    await service.run(ORG, TASK, 'usa la API de stripe');

    const prompt = modelRouter.generate.mock.calls[0][0] as string;
    expect(prompt).toContain('§§secret(stripe)');
    expect(prompt).not.toContain('inactivo');
  });

  // ── delegate con rol ───────────────────────────────────────────────────────

  it('passes the delegated role into the sub-agent prompt', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"divide","tool":"delegate","args":{"goal":"analiza datos","role":"programador"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"soy sub","tool":"final_answer","args":{"text":"análisis listo"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"cierro","tool":"final_answer","args":{"text":"Todo listo."}}'));

    const result = await service.run(ORG, TASK, 'proyecto de datos');

    const subPrompt = modelRouter.generate.mock.calls[1][0] as string;
    expect(subPrompt).toContain('actuando como programador');
    expect(result.steps[0].observation).toBe('análisis listo');
  });

  // ── memoria de soluciones ──────────────────────────────────────────────────

  it('memorizes the working solution as procedural memory after code success', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"código","tool":"code_execute","args":{"language":"python","code":"print(7)"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"Es 7."}}'));

    await service.run(ORG, TASK, 'calcula con código');
    await new Promise((r) => setImmediate(r)); // ingest es fire-and-forget

    expect(memoryAgent.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        memory_type: 'procedural',
        summary: expect.stringContaining('Solución técnica'),
        metadata: expect.objectContaining({ solution: true }),
      }),
      ORG,
    );
  });

  it('does not memorize solutions for read-only tool runs', async () => {
    modelRouter.generate
      .mockResolvedValueOnce(modelReply('{"thought":"buscar","tool":"web_search","args":{"query":"clima"}}'))
      .mockResolvedValueOnce(modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"22°C"}}'));

    await service.run(ORG, TASK, 'clima de hoy');
    await new Promise((r) => setImmediate(r));

    expect(memoryAgent.ingest).not.toHaveBeenCalled();
  });

  it('exposes the verification discipline rules in every decide prompt', async () => {
    modelRouter.generate.mockResolvedValueOnce(
      modelReply('{"thought":"ok","tool":"final_answer","args":{"text":"hecho"}}'),
    );

    await service.run(ORG, TASK, 'objetivo');

    const prompt = modelRouter.generate.mock.calls[0][0] as string;
    expect(prompt).toContain('inspeccionar→preparar→ejecutar→verificar');
    expect(prompt).toContain('Nunca declares éxito');
    expect(prompt).toContain('/work persisten');
  });
});
