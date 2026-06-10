import { Test, TestingModule } from '@nestjs/testing';
import { EventBusService } from '../../events/event-bus.service';
import { IntentRouterService } from '../../intent-router/intent-router.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { TasksService } from '../../tasks/tasks.service';
import { ToolRouterService } from '../../tool-router/tool-router.service';
import { AgentRunnerService } from '../agent-runner.service';
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

describe('AgentRunnerService', () => {
  let service: AgentRunnerService;
  let events: jest.Mocked<EventBusService>;
  let tasks: jest.Mocked<TasksService>;
  let intentRouter: jest.Mocked<IntentRouterService>;
  let modelRouter: jest.Mocked<ModelRouterService>;

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
      ],
    }).compile();

    service = module.get(AgentRunnerService);
    events = module.get(EventBusService);
    tasks = module.get(TasksService);
    intentRouter = module.get(IntentRouterService);
    modelRouter = module.get(ModelRouterService);
  });

  describe('pickAck', () => {
    it('answers search orders with the internet phrase', () => {
      expect(service.pickAck('busca el precio del dólar').say).toContain('buscar en internet');
    });
    it('answers review orders with the review phrase', () => {
      expect(service.pickAck('revisa mis correos de hoy').say).toContain('Déjame revisar');
    });
    it('answers analysis orders with the thinking phrase', () => {
      expect(service.pickAck('analiza las ventas del mes').say).toContain('Déjame pensar');
    });
    it('falls back to the default phrase', () => {
      expect(service.pickAck('hola').say).toContain('Enseguida');
    });
  });

  it('runs the happy path emitting say → logs → result and completing the task', async () => {
    await service.run(ORG, TASK);

    const published = events.publish.mock.calls.map(([event]) => event);
    const types = published.map((event) => event.type);

    // Instant ack goes out first
    expect(types[0]).toBe('task.say');
    expect((published[0].payload as { text: string }).text).toContain('buscar en internet');

    // Transparent logs for every stage
    const logs = published.filter((event) => event.type === 'task.log')
      .map((event) => (event.payload as { message: string }).message);
    expect(logs.some((message) => message.includes('classifying intent'))).toBe(true);
    expect(logs.some((message) => message.includes('intent=fast_path'))).toBe(true);
    expect(logs.some((message) => message.includes('tool-router'))).toBe(true);
    expect(logs.some((message) => message.includes('buscando en internet'))).toBe(true);
    expect(logs.some((message) => message.includes('model claude-haiku'))).toBe(true);

    // Final answer event + completed transition with result persisted
    expect(types).toContain('task.result');
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.objectContaining({
      result: expect.objectContaining({ text: expect.stringContaining('CDMX') }),
    }));

    // fast_path rides the cheap tier with org keys
    expect(modelRouter.generate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      orgId: ORG,
      budget: 'cheap',
    }));
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
    // failSafely re-reads status: pending first, then running after transitions
    tasks.getTask
      .mockResolvedValueOnce(makeTask())                       // run() initial read
      .mockResolvedValueOnce(makeTask({ status: 'running' }))  // failSafely current
      .mockResolvedValueOnce(makeTask({ status: 'running' })); // failSafely refreshed

    await service.run(ORG, TASK);

    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'failed', { error: 'provider down' });
    const logs = events.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'task.log')
      .map((event) => (event.payload as { message: string }).message);
    expect(logs.some((message) => message.includes('ERROR: provider down'))).toBe(true);
  });

  it('ignores tasks that are no longer pending', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ status: 'completed' }));
    await service.run(ORG, TASK);
    expect(events.publish).not.toHaveBeenCalled();
  });
});
