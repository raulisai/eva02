import { AgentIntelligenceService } from '../agent-intelligence.service';
import { DatabaseService } from '../../database/database.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { TasksService } from '../../tasks/tasks.service';
import { SkillLibraryService } from '../skill-library.service';
import { EventBusService } from '../../events/event-bus.service';
import { ScheduledJobsService } from '../../jobs/scheduled-jobs.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function dbMock() {
  const state = { table: '' };
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    single: jest.fn().mockResolvedValue({ data: { id: 'row-1' }, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockResolvedValue({ error: null }),
  };
  const from = jest.fn((table: string) => {
    state.table = table;
    return builder;
  });
  return { db: { admin: { from } } as unknown as DatabaseService, builder, from, state };
}

describe('AgentIntelligenceService', () => {
  let service: AgentIntelligenceService;
  let builder: any;
  let from: jest.Mock;
  let model: jest.Mocked<ModelRouterService>;
  let tasks: jest.Mocked<TasksService>;
  let events: jest.Mocked<EventBusService>;
  let scheduledJobs: jest.Mocked<ScheduledJobsService>;

  beforeEach(() => {
    const mock = dbMock();
    builder = mock.builder;
    from = mock.from;
    model = {
      generate: jest.fn().mockResolvedValue({
        text: '{"ok":true,"text":"seguro"}',
        model: 'eval',
        backend: 'openai',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      embed: jest.fn().mockResolvedValue({ embedding: Array(1536).fill(0.01), model: 'dev-stub', backend: 'openai' }),
    } as any;
    tasks = { createTask: jest.fn().mockResolvedValue({ id: TASK }) } as any;
    events = { publish: jest.fn().mockResolvedValue('1-0') } as any;
    scheduledJobs = { ensureAgentAutonomyJobs: jest.fn().mockResolvedValue(undefined) } as any;
    service = new AgentIntelligenceService(
      mock.db,
      model,
      tasks,
      {} as SkillLibraryService,
      events,
      scheduledJobs,
    );
  });

  it('enforces token caps using org-scoped token logs', async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { token_cap_per_task: 100, tool_rate_limit_per_minute: 0 }, error: null });
    builder.limit.mockResolvedValueOnce({ data: [{ total_tokens: 80 }], error: null });

    const message = await service.enforceTokenCap(ORG, TASK, 30);

    expect(from).toHaveBeenCalledWith('token_logs');
    expect(builder.eq).toHaveBeenCalledWith('org_id', ORG);
    expect(builder.eq).toHaveBeenCalledWith('task_id', TASK);
    expect(message).toContain('Límite de tokens');
  });

  it('rate-limits tools per org when configured', async () => {
    builder.maybeSingle.mockResolvedValue({ data: { tool_rate_limit_per_minute: 1 }, error: null });

    await expect(service.enforceToolRateLimit(ORG, 'web_search')).resolves.toBeNull();
    await expect(service.enforceToolRateLimit(ORG, 'web_search')).resolves.toContain('Rate limit');
  });

  it('blocks sandbox network domains outside the org allowlist', async () => {
    builder.maybeSingle.mockResolvedValueOnce({
      data: { sandbox_network_allowlist: ['api.example.com'] },
      error: null,
    });

    const denied = await service.validateNetworkAllowlist(ORG, 'curl https://evil.test/x');

    expect(denied).toContain('evil.test');
  });

  it('normalizes org max step settings by tier with safe clamps', async () => {
    builder.maybeSingle.mockResolvedValueOnce({
      data: {
        max_steps_by_tier: {
          chat: 99,
          quick: 0,
          medium: 7,
          long: 99,
        },
      },
      error: null,
    });

    await expect(service.settings(ORG)).resolves.toMatchObject({
      maxStepsByTier: {
        chat: 4,
        quick: 1,
        medium: 7,
        long: 20,
      },
    });
  });

  it('returns the configured max steps for a requested tier', async () => {
    builder.maybeSingle.mockResolvedValueOnce({
      data: { max_steps_by_tier: { medium: 6 } },
      error: null,
    });

    await expect(service.maxStepsForTier(ORG, 'medium')).resolves.toBe(6);
  });

  it('persists ask_user requests and emits waiting events', async () => {
    const result = await service.askUser(ORG, TASK, '¿Cuál archivo?', ['a.csv']);

    expect(from).toHaveBeenCalledWith('agent_input_requests');
    expect(from).toHaveBeenCalledWith('tasks');
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.waiting_input', orgId: ORG, taskId: TASK }));
    expect(result).toContain('WAITING_FOR_INPUT');
  });

  it('allows long ask_user standby windows for external waits', async () => {
    const before = Date.now();
    await service.askUser(ORG, TASK, 'Avísame cuando responda Ana', [], 24 * 60);

    const inserted = builder.insert.mock.calls[0][0] as { expires_at: string };
    const deltaMinutes = (new Date(inserted.expires_at).getTime() - before) / 60_000;
    expect(deltaMinutes).toBeGreaterThan(23 * 60);
    expect(deltaMinutes).toBeLessThanOrEqual(24 * 60 + 1);
  });

  it('expires timed-out input requests and requeues their tasks', async () => {
    builder.limit.mockResolvedValueOnce({ data: [{ id: 'req-1', task_id: TASK }], error: null });

    await service.expireTimedOutInputs(ORG);

    expect(from).toHaveBeenCalledWith('agent_input_requests');
    expect(from).toHaveBeenCalledWith('tasks');
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.created',
      taskId: TASK,
      payload: expect.objectContaining({ resumed_from_input_timeout: true }),
    }));
  });

  it('runs autonomy maintenance once per org owner', async () => {
    builder.limit.mockResolvedValueOnce({
      data: [
        { id: 'user-1', org_id: ORG },
        { id: 'user-2', org_id: ORG },
        { id: 'user-3', org_id: 'org-2' },
      ],
      error: null,
    });
    jest.spyOn(service, 'expireTimedOutInputs').mockResolvedValue(undefined);
    jest.spyOn(service, 'consolidateMemories').mockResolvedValue(undefined);
    jest.spyOn(service, 'selfImprovementBatch').mockResolvedValue(undefined);
    jest.spyOn(service, 'heartbeat').mockResolvedValue(null);

    await service.tickAutonomy();

    expect(service.expireTimedOutInputs).toHaveBeenCalledTimes(2);
    expect(service.expireTimedOutInputs).toHaveBeenCalledWith(ORG);
    expect(service.expireTimedOutInputs).toHaveBeenCalledWith('org-2');
    expect(service.heartbeat).toHaveBeenCalledWith(ORG, 'user-1');
    expect(service.heartbeat).toHaveBeenCalledWith('org-2', 'user-3');
  });

  it('retrieves a compact replay example from successful trajectories', async () => {
    builder.limit.mockResolvedValueOnce({
      data: [{
        goal: 'calcula suma con código',
        steps: [{ tool: 'code_execute', args: {}, thought: 'x', observation: '42' }],
        tools_used: ['code_execute'],
      }],
      error: null,
    });

    const example = await service.replayExample(ORG, 'calcula suma con código');

    expect(example).toContain('EJEMPLO DE RESOLUCIÓN PREVIA');
    expect(example).toContain('code_execute');
  });

  it('runs a security review when steps touched sensitive surfaces', async () => {
    const review = await service.securityReview(ORG, TASK, 'envía archivo', [
      { tool: 'telegram_send_file', args: { file: 'a.txt' }, thought: 'send', observation: 'ok' },
    ], 'enviado');

    expect(model.generate).toHaveBeenCalled();
    expect(review).toEqual({ ok: true, text: 'seguro' });
  });
});
