import { AgentTrajectoryService } from '../agent-trajectory.service';
import { DatabaseService } from '../../database/database.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('AgentTrajectoryService', () => {
  it('upserts trajectory checkpoints with org and task conflict key', async () => {
    const upsert = jest.fn().mockResolvedValue({ error: null });
    const db = {
      admin: {
        from: jest.fn().mockReturnValue({ upsert }),
      },
    } as unknown as DatabaseService;
    const service = new AgentTrajectoryService(db);

    await service.checkpoint({
      orgId: ORG,
      taskId: TASK,
      goal: 'calcula con código',
      steps: [{ tool: 'code_execute', args: { language: 'python' }, thought: 'x', observation: '7' }],
      outcome: 'running',
      tokensUsed: 12,
      toolsUsed: ['code_execute'],
      depth: 0,
      durationMs: 33,
      stallCount: 0,
      dodRejections: 0,
      modelBudgetPerStep: [{ step: 1, budget: 'cheap', reason: 'initial' }],
    });

    expect(db.admin.from).toHaveBeenCalledWith('agent_trajectories');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG,
      task_id: TASK,
      goal_key: 'code',
      outcome: 'running',
      tools_used: ['code_execute'],
    }), { onConflict: 'org_id,task_id' });
  });

  it('reads every metrics view with an org_id filter', async () => {
    const eq = jest.fn().mockResolvedValue({ data: [], error: null });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select });
    const db = { admin: { from } } as unknown as DatabaseService;
    const service = new AgentTrajectoryService(db);

    const result = await service.metrics(ORG);

    expect(result).toEqual({ tools: [], goals: [], defenses: null, skills: null, efficiency: null });
    expect(from).toHaveBeenCalledTimes(5);
    expect(eq).toHaveBeenCalledTimes(5);
    expect(eq).toHaveBeenCalledWith('org_id', ORG);
  });
});
