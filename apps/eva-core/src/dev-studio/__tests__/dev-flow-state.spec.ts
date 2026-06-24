import { DevSessionService } from '../dev-session.service';

/**
 * Unit-test the flow-state derivation (current task per agent, last instruction
 * per edge, stuck detection) by stubbing the data-access methods. No DB.
 */
function makeService(): DevSessionService {
  // Chainable query builder that returns empty results for everything
  // EXCEPT dev_iterations (which returns the test objective via maybeSingle).
  // getFlowState hits dev_iterations (maybeSingle) and potentially dev_events (.in/.limit).
  const makeChain = (tableName?: string): any => {
    const terminal = {
      data: tableName === 'dev_iterations'
        ? { objective: 'Construir el MVP', started_at: '2026-06-19T00:00:00Z' }
        : [],
      error: null,
    };
    const chain: any = {
      select: () => chain,
      eq:     () => chain,
      in:     () => chain,
      not:    () => chain,
      filter: () => chain,
      order:  () => chain,
      limit:  () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: terminal.data, error: null }),
    };
    return chain;
  };
  const admin = { from: (table: string) => makeChain(table) };
  const db = { admin } as unknown as ConstructorParameters<typeof DevSessionService>[0];
  const events = {} as ConstructorParameters<typeof DevSessionService>[1];
  return new DevSessionService(db, events);
}

const NOW = '2026-06-19T01:00:00Z';

describe('DevSessionService.getFlowState', () => {
  it('derives current task, architect→dev handoffs and a running team', async () => {
    const svc = makeService();
    jest.spyOn(svc, 'findById').mockResolvedValue({
      id: 's1', status: 'running', current_iteration_id: 'it1',
    } as any);
    jest.spyOn(svc, 'listAgents').mockResolvedValue([
      { role: 'project_manager', name: 'PM', status: 'idle', last_heartbeat_at: null },
      { role: 'architect', name: 'Arch', status: 'completed', last_heartbeat_at: null },
      { role: 'backend', name: 'BE', status: 'running', last_heartbeat_at: NOW },
    ] as any);
    jest.spyOn(svc, 'listStudioTasks').mockResolvedValue([
      { id: 't1', role: 'backend', title: 'Crear endpoint /products', status: 'running', created_at: NOW, updated_at: NOW },
    ] as any);

    const flow = await svc.getFlowState('s1', 'org1');

    // assigner is the architect when present
    expect(flow.assigner).toBe('architect');
    // backend agent's current task surfaces
    const be = flow.agents.find((a) => a.role === 'backend');
    expect(be?.currentTaskTitle).toBe('Crear endpoint /products');
    // architect → backend handoff carries the task title as the instruction
    const h = flow.handoffs.find((x) => x.from === 'architect' && x.to === 'backend');
    expect(h?.instruction).toBe('Crear endpoint /products');
    // PM → architect handoff carries the iteration objective
    const pmh = flow.handoffs.find((x) => x.from === 'project_manager' && x.to === 'architect');
    expect(pmh?.instruction).toBe('Construir el MVP');
  });

  it('flags a blocked agent as the stuck point', async () => {
    const svc = makeService();
    jest.spyOn(svc, 'findById').mockResolvedValue({ id: 's1', status: 'running', current_iteration_id: null } as any);
    jest.spyOn(svc, 'listAgents').mockResolvedValue([
      { role: 'backend', name: 'BE', status: 'blocked', last_heartbeat_at: NOW },
    ] as any);
    jest.spyOn(svc, 'listStudioTasks').mockResolvedValue([
      { id: 't1', role: 'backend', title: 'Integrar Stripe', status: 'running', created_at: NOW, updated_at: NOW },
    ] as any);

    const flow = await svc.getFlowState('s1', 'org1');
    expect(flow.stuck?.role).toBe('backend');
    expect(flow.stuck?.taskTitle).toBe('Integrar Stripe');
  });

  it('points at the human when the session is waiting on human input', async () => {
    const svc = makeService();
    jest.spyOn(svc, 'findById').mockResolvedValue({ id: 's1', status: 'waiting_for_human_setup', current_iteration_id: null } as any);
    jest.spyOn(svc, 'listAgents').mockResolvedValue([
      { role: 'backend', name: 'BE', status: 'idle', last_heartbeat_at: null },
    ] as any);
    jest.spyOn(svc, 'listStudioTasks').mockResolvedValue([]);

    const flow = await svc.getFlowState('s1', 'org1');
    expect(flow.stuck?.role).toBe('human');
  });

  it('uses PM as the assigner when there is no architect', async () => {
    const svc = makeService();
    jest.spyOn(svc, 'findById').mockResolvedValue({ id: 's1', status: 'running', current_iteration_id: null } as any);
    jest.spyOn(svc, 'listAgents').mockResolvedValue([
      { role: 'project_manager', name: 'PM', status: 'idle', last_heartbeat_at: null },
      { role: 'full_stack', name: 'FS', status: 'running', last_heartbeat_at: NOW },
    ] as any);
    jest.spyOn(svc, 'listStudioTasks').mockResolvedValue([
      { id: 't1', role: 'full_stack', title: 'App completa', status: 'running', created_at: NOW, updated_at: NOW },
    ] as any);

    const flow = await svc.getFlowState('s1', 'org1');
    expect(flow.assigner).toBe('project_manager');
    const h = flow.handoffs.find((x) => x.to === 'full_stack');
    expect(h?.from).toBe('project_manager');
  });
});
