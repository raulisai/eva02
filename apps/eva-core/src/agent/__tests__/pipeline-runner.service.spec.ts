import { Test, TestingModule } from '@nestjs/testing';
import { PipelineRunnerService } from '../pipeline-runner.service';
import { AgentLoopService } from '../agent-loop.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { EventBusService } from '../../events/event-bus.service';
import { DatabaseService } from '../../database/database.service';
import { SandboxService } from '../sandbox.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeModule(overrides: Partial<{
  agentLoop: Partial<AgentLoopService>;
  modelRouter: Partial<ModelRouterService>;
  db: unknown;
}> = {}) {
  const agentLoop = {
    run: jest.fn(),
    ...overrides.agentLoop,
  };
  const modelRouter = {
    generate: jest.fn(),
    ...overrides.modelRouter,
  };
  const events = { publish: jest.fn().mockResolvedValue(undefined) };
  const db = overrides.db ?? {
    admin: { from: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { metadata: {} } }) }) },
  };
  const sandbox = { release: jest.fn().mockResolvedValue(undefined) };

  return Test.createTestingModule({
    providers: [
      PipelineRunnerService,
      { provide: AgentLoopService, useValue: agentLoop },
      { provide: ModelRouterService, useValue: modelRouter },
      { provide: EventBusService, useValue: events },
      { provide: DatabaseService, useValue: db },
      { provide: SandboxService, useValue: sandbox },
    ],
  }).compile();
}

describe('PipelineRunnerService', () => {
  // ── isMultiPhase ─────────────────────────────────────────────────────────

  describe('isMultiPhase()', () => {
    let service: PipelineRunnerService;
    beforeEach(async () => {
      const module = await makeModule();
      service = module.get(PipelineRunnerService);
    });

    it('detects pronoun back-reference', () => {
      expect(service.isMultiPhase('Crea un informe de ventas y envíalo por Telegram')).toBe(true);
    });

    it('detects connector chain', () => {
      expect(service.isMultiPhase('Genera un reporte, luego envíalo por email')).toBe(true);
    });

    it('detects document → format → delivery', () => {
      expect(service.isMultiPhase('Crea un informe en PDF y envíalo por telegram')).toBe(true);
    });

    it('does NOT flag a simple conversational input', () => {
      expect(service.isMultiPhase('¿Cómo estás?')).toBe(false);
    });

    it('does NOT flag a single-step search', () => {
      expect(service.isMultiPhase('Busca el precio del dólar hoy')).toBe(false);
    });
  });

  // ── synthesizePipeline ────────────────────────────────────────────────────

  describe('synthesizePipeline()', () => {
    let service: PipelineRunnerService;
    let modelRouter: jest.Mocked<ModelRouterService>;

    beforeEach(async () => {
      const module = await makeModule();
      service = module.get(PipelineRunnerService);
      modelRouter = module.get(ModelRouterService) as jest.Mocked<ModelRouterService>;
    });

    it('parses a valid JSON response into phases', async () => {
      const phases = [
        { name: 'crear_informe', goal: 'Crear informe de ventas', outputKey: 'report', dependsOn: [], maxSteps: 4 },
        { name: 'convertir_pdf', goal: 'Convertir {{report}} a PDF', outputKey: 'pdf_path', dependsOn: ['crear_informe'], maxSteps: 3 },
        { name: 'enviar_telegram', goal: 'Enviar {{pdf_path}} por Telegram', outputKey: 'result', dependsOn: ['convertir_pdf'], maxSteps: 3 },
      ];
      modelRouter.generate.mockResolvedValue({ text: JSON.stringify({ phases }), model: 'stub', backend: 'google', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } });

      const def = await service.synthesizePipeline('Crea un informe y envíalo por Telegram');
      expect(def.phases).toHaveLength(3);
      expect(def.phases[0].name).toBe('crear_informe');
    });

    it('falls back to single phase on LLM failure', async () => {
      modelRouter.generate.mockRejectedValue(new Error('LLM timeout'));
      const def = await service.synthesizePipeline('Crea y envía un informe');
      expect(def.phases).toHaveLength(1);
      expect(def.phases[0].name).toBe('ejecutar');
    });

    it('falls back when LLM returns less than 2 phases', async () => {
      modelRouter.generate.mockResolvedValue({ text: JSON.stringify({ phases: [{ name: 'only', goal: 'do it', outputKey: 'r', dependsOn: [], maxSteps: 4 }] }), model: 'stub', backend: 'google', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
      const def = await service.synthesizePipeline('Solo una cosa');
      expect(def.phases).toHaveLength(1);
    });
  });

  // ── run() ─────────────────────────────────────────────────────────────────

  describe('run()', () => {
    let service: PipelineRunnerService;
    let agentLoop: jest.Mocked<AgentLoopService>;
    let modelRouter: jest.Mocked<ModelRouterService>;

    const successfulPhaseDef = {
      phases: [
        { name: 'fase1', goal: 'Crear informe', outputKey: 'report', dependsOn: [], maxSteps: 4 },
        { name: 'fase2', goal: 'Convertir {{report}} a PDF', outputKey: 'pdf', dependsOn: ['fase1'], maxSteps: 3 },
        { name: 'fase3', goal: 'Enviar {{pdf}} por Telegram', outputKey: 'result', dependsOn: ['fase2'], maxSteps: 3 },
      ],
    };

    beforeEach(async () => {
      const module = await makeModule();
      service = module.get(PipelineRunnerService);
      agentLoop = module.get(AgentLoopService) as jest.Mocked<AgentLoopService>;
      modelRouter = module.get(ModelRouterService) as jest.Mocked<ModelRouterService>;

      modelRouter.generate.mockResolvedValue({
        text: JSON.stringify(successfulPhaseDef),
        model: 'stub', backend: 'google',
        usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      });
    });

    it('runs all phases sequentially and returns ok=true on full success', async () => {
      agentLoop.run
        .mockResolvedValueOnce({ ok: true, text: 'Informe creado', steps: [], tokensUsed: 100, toolsUsed: [] })
        .mockResolvedValueOnce({ ok: true, text: '/work/report.pdf', steps: [], tokensUsed: 80, toolsUsed: [] })
        .mockResolvedValueOnce({ ok: true, text: 'Enviado por Telegram', steps: [], tokensUsed: 60, toolsUsed: [] });

      const outcome = await service.run(ORG, TASK, 'Crea informe, conviértelo a PDF y envíalo');
      expect(outcome.ok).toBe(true);
      expect(outcome.phases).toHaveLength(3);
      expect(outcome.phases.every((p) => p.status === 'completed')).toBe(true);
      expect(outcome.totalTokens).toBe(240);
      expect(agentLoop.run).toHaveBeenCalledTimes(3);
    });

    it('interpolates {{outputKey}} tokens in subsequent phase goals', async () => {
      agentLoop.run
        .mockResolvedValueOnce({ ok: true, text: 'Informe de ventas Q1', steps: [], tokensUsed: 100, toolsUsed: [] })
        .mockResolvedValueOnce({ ok: true, text: '/work/report.pdf', steps: [], tokensUsed: 80, toolsUsed: [] })
        .mockResolvedValueOnce({ ok: true, text: 'OK', steps: [], tokensUsed: 60, toolsUsed: [] });

      await service.run(ORG, TASK, 'Crea informe, conviértelo a PDF y envíalo');

      // Phase 2 goal should have been interpolated with phase 1 output
      const phase2Goal = agentLoop.run.mock.calls[1][2];
      expect(phase2Goal).toContain('Informe de ventas Q1');
    });

    it('skips phases whose dependencies failed', async () => {
      agentLoop.run
        .mockResolvedValueOnce({ ok: false, text: 'Error al crear informe', steps: [], tokensUsed: 50, toolsUsed: [] });

      const outcome = await service.run(ORG, TASK, 'Crea informe, conviértelo a PDF y envíalo');
      expect(outcome.ok).toBe(false);
      expect(outcome.phases[0].status).toBe('failed');
      expect(outcome.phases[1].status).toBe('skipped');
      expect(outcome.phases[2].status).toBe('skipped');
      expect(agentLoop.run).toHaveBeenCalledTimes(1);
    });

    it('marks phase failed and skips dependents when agentLoop throws', async () => {
      agentLoop.run
        .mockResolvedValueOnce({ ok: true, text: 'Informe listo', steps: [], tokensUsed: 100, toolsUsed: [] })
        .mockRejectedValueOnce(new Error('PDF generation crashed'));

      const outcome = await service.run(ORG, TASK, 'Crea informe, conviértelo a PDF y envíalo');
      expect(outcome.phases[0].status).toBe('completed');
      expect(outcome.phases[1].status).toBe('failed');
      expect(outcome.phases[1].error).toContain('PDF generation crashed');
      expect(outcome.phases[2].status).toBe('skipped');
    });

    it('runs independent phases concurrently (parallel wave)', async () => {
      const parallelDef = {
        phases: [
          { name: 'buscar_datos', goal: 'Buscar datos de ventas', outputKey: 'ventas', dependsOn: [], maxSteps: 3 },
          { name: 'buscar_costos', goal: 'Buscar datos de costos', outputKey: 'costos', dependsOn: [], maxSteps: 3 },
          { name: 'consolidar', goal: 'Consolidar {{ventas}} y {{costos}}', outputKey: 'result', dependsOn: ['buscar_datos', 'buscar_costos'], maxSteps: 4 },
        ],
      };
      modelRouter.generate.mockResolvedValue({ text: JSON.stringify(parallelDef), model: 'stub', backend: 'google', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } });

      const callOrder: string[] = [];
      agentLoop.run.mockImplementation(async (_org, _task, goal) => {
        callOrder.push(goal.slice(0, 15));
        return { ok: true, text: `resultado: ${goal.slice(0, 20)}`, steps: [], tokensUsed: 50, toolsUsed: [] };
      });

      const outcome = await service.run(ORG, TASK, 'Busca datos y consolídalos');
      expect(outcome.ok).toBe(true);
      expect(outcome.phases).toHaveLength(3);
      expect(outcome.phases.every((p) => p.status === 'completed')).toBe(true);
      // Consolidar must run after both search phases
      expect(callOrder[2]).toContain('Consolidar');
      expect(agentLoop.run).toHaveBeenCalledTimes(3);
    });

    it('releases sandbox after all phases finish', async () => {
      const module = await makeModule();
      const svc = module.get(PipelineRunnerService);
      const sandbox = module.get(SandboxService) as jest.Mocked<SandboxService>;
      const loop = module.get(AgentLoopService) as jest.Mocked<AgentLoopService>;
      const mr = module.get(ModelRouterService) as jest.Mocked<ModelRouterService>;

      mr.generate.mockResolvedValue({ text: JSON.stringify(successfulPhaseDef), model: 'stub', backend: 'google', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } });
      loop.run.mockResolvedValue({ ok: true, text: 'done', steps: [], tokensUsed: 10, toolsUsed: [] });

      await svc.run(ORG, TASK, 'Crea y envía');
      // Give the void promise a tick to resolve
      await new Promise((r) => setImmediate(r));
      expect(sandbox.release).toHaveBeenCalledWith(TASK);
    });

    it('retries only failed/skipped phases from stored pipeline metadata', async () => {
      const storedMetadata = {
        pipeline: {
          retryable: true,
          definition: successfulPhaseDef,
          phases: [
            { name: 'fase1', status: 'completed', outputKey: 'report', output: 'Informe ya creado', stepsUsed: 2, tokensUsed: 100, durationMs: 10 },
            { name: 'fase2', status: 'failed', outputKey: 'pdf', error: 'PDF failed', stepsUsed: 1, tokensUsed: 20, durationMs: 5 },
            { name: 'fase3', status: 'skipped', outputKey: 'result', error: 'Dependencias no completadas: fase2', stepsUsed: 0, tokensUsed: 0, durationMs: 0 },
          ],
        },
      };
      const builder = {
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { metadata: storedMetadata } }),
      };
      const module = await makeModule({
        db: { admin: { from: jest.fn().mockReturnValue(builder) } },
      });
      const svc = module.get(PipelineRunnerService);
      const loop = module.get(AgentLoopService) as jest.Mocked<AgentLoopService>;
      const mr = module.get(ModelRouterService) as jest.Mocked<ModelRouterService>;

      loop.run
        .mockResolvedValueOnce({ ok: true, text: '/work/report.pdf', steps: [], tokensUsed: 80, toolsUsed: [] })
        .mockResolvedValueOnce({ ok: true, text: 'Enviado por Telegram', steps: [], tokensUsed: 60, toolsUsed: [] });

      const outcome = await svc.run(ORG, TASK, 'Crea informe, conviértelo a PDF y envíalo', { retryFailedPhases: true });

      expect(mr.generate).not.toHaveBeenCalled();
      expect(loop.run).toHaveBeenCalledTimes(2);
      expect(loop.run.mock.calls[0][2]).toContain('Informe ya creado');
      expect(loop.run.mock.calls[0][2]).not.toBe('Crear informe');
      expect(outcome.ok).toBe(true);
      expect(outcome.phases.map((phase) => phase.status)).toEqual(['completed', 'completed', 'completed']);
      expect(outcome.totalTokens).toBe(240);
    });
  });
});
