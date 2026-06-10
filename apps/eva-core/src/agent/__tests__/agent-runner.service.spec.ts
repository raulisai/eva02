import { Test, TestingModule } from '@nestjs/testing';
import { EventBusService } from '../../events/event-bus.service';
import { IntentRouterService } from '../../intent-router/intent-router.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { TasksService } from '../../tasks/tasks.service';
import { ToolRouterService } from '../../tool-router/tool-router.service';
import { AgentRunnerService } from '../agent-runner.service';
import { MediaService } from '../media.service';
import { MissingInformationError, ResearchToolsService } from '../research-tools.service';
import { ScriptForgeService } from '../script-forge.service';
import { classifyTier } from '../tier';
import { Task } from '../../tasks/task.types';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    org_id: ORG,
    created_by: 'user-1',
    title: 'Busca el clima',
    description: 'Busca el clima de hoy en CDMX',
    status: 'pending',
    metadata: {},
    result: null,
    error: null,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('classifyTier', () => {
  it('routes greetings and short messages to chat', () => {
    expect(classifyTier('hola').tier).toBe('chat');
    expect(classifyTier('¿cómo estás?').tier).toBe('chat');
    expect(classifyTier('gracias!').tier).toBe('chat');
  });

  it('routes lookups to quick (<1 min)', () => {
    expect(classifyTier('busca el clima de hoy').tier).toBe('quick');
    expect(classifyTier('¿cuánto cuesta el dólar?').tier).toBe('quick');
  });

  it('routes current-information requests to quick instead of chat', () => {
    expect(classifyTier('que esta pasando ahora con OpenAI').tier).toBe('quick');
    expect(classifyTier('dame lo ultimo de bitcoin').tier).toBe('quick');
    expect(classifyTier('cual es el clima de manana').tier).toBe('quick');
  });

  it('routes automation/code orders to long (background)', () => {
    expect(classifyTier('crea un script que limpie mis descargas').tier).toBe('long');
    expect(classifyTier('automatiza un reporte cada día').tier).toBe('long');
  });

  it('never lets sensitive actions take the chat shortcut', () => {
    expect(classifyTier('compra el dominio eva.dev').tier).toBe('quick');
    expect(classifyTier('borra la base de datos').tier).toBe('quick');
  });
});

describe('AgentRunnerService', () => {
  let service: AgentRunnerService;
  let events: jest.Mocked<EventBusService>;
  let tasks: jest.Mocked<TasksService>;
  let intentRouter: jest.Mocked<IntentRouterService>;
  let modelRouter: jest.Mocked<ModelRouterService>;
  let media: jest.Mocked<MediaService>;
  let research: jest.Mocked<ResearchToolsService>;
  let forge: jest.Mocked<ScriptForgeService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        {
          provide: EventBusService,
          useValue: { publish: jest.fn().mockResolvedValue('0-1'), on: jest.fn() },
        },
        {
          provide: TasksService,
          useValue: {
            getTask: jest.fn().mockResolvedValue(makeTask()),
            transition: jest.fn().mockImplementation(async (_id, _org, status) => makeTask({ status })),
          },
        },
        {
          provide: IntentRouterService,
          useValue: {
            classify: jest.fn().mockResolvedValue({
              intent: 'fast_path', confidence: 0.9, classifier: 'rule', reasons: ['lookup keyword'],
            }),
          },
        },
        {
          provide: ModelRouterService,
          useValue: {
            generate: jest.fn().mockResolvedValue({
              text: 'Hoy en CDMX: 22°C, despejado.',
              model: 'claude-haiku-4-5-20251001',
              backend: 'claude',
              usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
            }),
          },
        },
        {
          provide: ToolRouterService,
          useValue: {
            route: jest.fn().mockReturnValue({
              tool: { name: 'web-search', avgLatencyMs: 800 },
              score: 0.12,
              alternates: [],
              matchedCapability: 'search',
            }),
          },
        },
        {
          provide: MediaService,
          useValue: {
            wantsImage: jest.fn().mockReturnValue(false),
            wantsAudio: jest.fn().mockReturnValue(false),
            sendImage: jest.fn().mockResolvedValue('https://bucket/eva-media/img.svg'),
            sendAudio: jest.fn().mockResolvedValue('https://bucket/eva-media/audio.mp3'),
          },
        },
        {
          provide: ResearchToolsService,
          useValue: {
            canAnswer: jest.fn().mockReturnValue(true),
            answer: jest.fn().mockResolvedValue({
              text: 'Consulte Chromium: manana 18-24 °C con lluvia ligera.',
              tool: 'chromium:wttr.in',
              sources: ['https://wttr.in/Ciudad%20de%20Mexico?lang=es'],
            }),
          },
        },
        {
          provide: ScriptForgeService,
          useValue: {
            isScriptTask: jest.fn().mockReturnValue(false),
            forge: jest.fn().mockResolvedValue({
              language: 'python',
              filename: 'cleaner.py',
              description: 'Limpia descargas',
              executed: true,
              output: 'OK: 12 archivos',
              skillSlug: 'gen-cleaner',
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AgentRunnerService);
    events = module.get(EventBusService);
    tasks = module.get(TasksService);
    intentRouter = module.get(IntentRouterService);
    modelRouter = module.get(ModelRouterService);
    media = module.get(MediaService);
    research = module.get(ResearchToolsService);
    forge = module.get(ScriptForgeService);
  });

  function publishedTypes() {
    return events.publish.mock.calls.map(([event]) => event.type);
  }
  function publishedLogs() {
    return events.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'task.log')
      .map((event) => (event.payload as { message: string }).message);
  }

  it('answers a greeting directly: no filler, no intent classification, cheap model', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'hola, ¿cómo vas?' }));

    await service.run(ORG, TASK);

    expect(publishedTypes()).not.toContain('task.say');
    expect(intentRouter.classify).not.toHaveBeenCalled();
    expect(modelRouter.generate).toHaveBeenCalledWith('hola, ¿cómo vas?', expect.objectContaining({
      budget: 'cheap',
    }));
    expect(publishedTypes()).toContain('task.result');
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('runs quick lookups with the search tool instead of answering from the model', async () => {
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'pronostico clima hoy Ciudad de Mexico',
        intent: 'weather',
        source_hint: 'both',
        reason: 'Necesita ubicacion y fecha explicitas para la consulta.',
      }),
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });

    await service.run(ORG, TASK); // "Busca el clima de hoy en CDMX"

    const published = events.publish.mock.calls.map(([event]) => event);
    expect(published[0].type).toBe('task.say');
    expect((published[0].payload as { text: string }).text).toContain('buscar en internet');

    const logs = publishedLogs();
    expect(logs.some((message) => message.includes('tier=quick'))).toBe(true);
    expect(logs.some((message) => message.includes('intent=fast_path'))).toBe(true);
    expect(logs.some((message) => message.includes('tool-router'))).toBe(true);
    expect(logs.some((message) => message.includes('research-plan: query="pronostico clima hoy Ciudad de Mexico"'))).toBe(true);
    expect(logs.some((message) => message.includes('buscando en internet con Chromium'))).toBe(true);
    expect(logs.some((message) => message.includes('tool chromium:wttr.in'))).toBe(true);

    expect(research.answer).toHaveBeenCalledWith('pronostico clima hoy Ciudad de Mexico', ORG);
    expect(publishedTypes()).toContain('task.result');
    expect(modelRouter.generate).toHaveBeenCalledWith('Busca el clima de hoy en CDMX', expect.objectContaining({
      budget: 'cheap',
      responseFormat: 'json',
    }));
  });

  it('announces background mode for long tasks so the chat stays free', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'automatiza un reporte diario de ventas con gráficos y envíalo',
    }));

    await service.run(ORG, TASK);

    const firstSay = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.say');
    expect((firstSay!.payload as { text: string }).text).toContain('segundo plano');
    expect(publishedLogs().some((message) => message.includes('tier=long'))).toBe(true);
  });

  it('forges, sandboxes and registers a skill for script orders', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'crea un script que limpie mis descargas' }));
    forge.isScriptTask.mockReturnValue(true);

    await service.run(ORG, TASK);

    expect(forge.forge).toHaveBeenCalled();
    const resultEvent = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.result');
    const text = (resultEvent!.payload as { text: string }).text;
    expect(text).toContain('cleaner.py');
    expect(text).toContain('gen-cleaner');
    expect(text).toContain('OK: 12 archivos');
    expect(modelRouter.generate).not.toHaveBeenCalled(); // forge owns the model call
  });

  it('attaches an image from the bucket when the order asks for one', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'busca el clima y muéstrame una imagen' }));
    media.wantsImage.mockReturnValue(true);

    await service.run(ORG, TASK);

    expect(media.sendImage).toHaveBeenCalledWith(ORG, TASK, expect.stringContaining('imagen'));
    expect(publishedLogs().some((message) => message.includes('eva-media'))).toBe(true);
  });

  it('parks sensitive orders at the approval gate without executing', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'compra el dominio eva.dev' }));
    intentRouter.classify.mockResolvedValue({
      intent: 'core_path_approval', confidence: 0.95, classifier: 'rule', reasons: ['purchase keyword'],
    } as never);

    await service.run(ORG, TASK);

    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval');
    expect(modelRouter.generate).not.toHaveBeenCalled();
    const says = events.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'task.say')
      .map((event) => (event.payload as { text: string }).text);
    expect(says.some((text) => text.includes('aprobación'))).toBe(true);
  });

  it('marks the task failed and logs the error when the model call blows up', async () => {
    modelRouter.generate.mockRejectedValue(new Error('provider down'));
    tasks.getTask
      .mockResolvedValueOnce(makeTask({ description: 'resume este texto' })) // run() initial read
      .mockResolvedValueOnce(makeTask({ status: 'running' }))  // failSafely current
      .mockResolvedValueOnce(makeTask({ status: 'running' })); // failSafely refreshed

    await service.run(ORG, TASK);

    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'failed', { error: 'provider down' });
    expect(publishedLogs().some((message) => message.includes('ERROR: provider down'))).toBe(true);
  });

  it('rejects useless model answers and recovers with available tools', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'analiza el estado actual de OpenAI',
    }));
    modelRouter.generate
      .mockResolvedValueOnce({
      text: 'Como modelo no tengo acceso a informacion en tiempo real. Consulta un sitio externo.',
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          query: 'OpenAI latest news current status',
          intent: 'news',
          source_hint: 'chromium',
          reason: 'La solicitud pide estado actual y requiere fuentes recientes.',
        }),
        model: 'gpt-4o-mini',
        backend: 'openai',
        usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
      });

    await service.run(ORG, TASK);

    expect(research.answer).toHaveBeenCalledWith('OpenAI latest news current status', ORG);
    expect(publishedLogs().some((message) => message.includes('model answer rejected as non-actionable'))).toBe(true);
    expect(publishedLogs().some((message) => message.includes('research-plan: query="OpenAI latest news current status"'))).toBe(true);
    expect(publishedLogs().some((message) => message.includes('recovery tool chromium:wttr.in'))).toBe(true);
    const resultEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    expect((resultEvent!.payload as { text: string }).text).toContain('Consulte Chromium');
  });

  it('does not publish the useless model answer when all recovery tools fail', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'analiza el estado actual de OpenAI',
    }));
    modelRouter.generate
      .mockResolvedValueOnce({
      text: 'Como modelo no tengo acceso a informacion en tiempo real. Consulta un sitio externo.',
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          query: 'OpenAI current status latest updates',
          intent: 'news',
          source_hint: 'chromium',
          reason: 'Necesita buscar informacion actual.',
        }),
        model: 'gpt-4o-mini',
        backend: 'openai',
        usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
      });
    research.answer.mockRejectedValue(new Error('browser unavailable'));

    await service.run(ORG, TASK);

    const resultEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    const text = (resultEvent!.payload as { text: string }).text;
    expect(text).toContain('No voy a cerrar esta tarea con una respuesta genérica');
    expect(text).toContain('browser unavailable');
    expect(text).not.toContain('Como modelo no tengo acceso');
  });

  it('requests a renderable form when a tool needs missing personal context', async () => {
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'clima de ayer en la ubicacion actual',
        intent: 'weather',
        source_hint: 'public_api',
        reason: 'Necesita ubicacion actual del usuario.',
      }),
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });
    research.answer.mockRejectedValue(new MissingInformationError(
      'Necesito tu ubicacion actual para consultar el clima.',
      {
        form_key: 'personal_profile.location',
        title: 'Falta tu ubicacion',
        description: 'Guarda tu ubicacion actual.',
        fields: [{ id: 'current_location', type: 'text', label: 'Ubicacion actual', required: true }],
      },
    ));

    await service.run(ORG, TASK);

    const formEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.form_request');
    expect(formEvent).toEqual(expect.objectContaining({
      orgId: ORG,
      taskId: TASK,
      payload: expect.objectContaining({
        message: 'Necesito tu ubicacion actual para consultar el clima.',
        form: expect.objectContaining({ form_key: 'personal_profile.location' }),
      }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval');
    expect(publishedTypes()).not.toContain('task.failed');
  });

  it('ignores tasks that are no longer pending', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ status: 'completed' }));
    await service.run(ORG, TASK);
    expect(events.publish).not.toHaveBeenCalled();
  });
});
