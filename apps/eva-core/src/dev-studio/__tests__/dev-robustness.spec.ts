import { DevSessionService } from '../dev-session.service';
import { ClaudeCodeRunnerService } from '../claude-code-runner.service';

describe('DevSessionService.buildIterationOutputs', () => {
  function svcWithTasks(tasks: Record<string, unknown>[]): DevSessionService {
    const svc = new DevSessionService({} as any, {} as any);
    jest.spyOn(svc, 'listIterationTasks').mockResolvedValue(tasks);
    return svc;
  }

  it('includes only finished tasks, with role/title/summary', async () => {
    const svc = svcWithTasks([
      { role: 'backend', title: 'Endpoint /products', status: 'needs_review', result_summary: 'creado', branch_name: 'agent/backend/x' },
      { role: 'testing', title: 'Tests', status: 'running', result_summary: '' },          // not done → excluded
      { role: 'frontend', title: 'UI', status: 'completed', result_summary: 'lista' },
    ]);
    const out = await svc.buildIterationOutputs('it1', 'org1');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('[backend] Endpoint /products');
    expect(out[0]).toContain('branch: agent/backend/x');
    expect(out[0]).toContain('→ creado');
    expect(out.some((o) => o.includes('[testing]'))).toBe(false);
  });

  it('returns empty when nothing finished', async () => {
    const svc = svcWithTasks([{ role: 'backend', title: 't', status: 'failed' }]);
    expect(await svc.buildIterationOutputs('it1', 'org1')).toEqual([]);
  });
});

describe('DevSessionService.updateIterationStatus publishes sessionId', () => {
  it('includes sessionId so the orchestrator tick handler can fire', async () => {
    const published: any[] = [];
    const db = {
      admin: {
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({ data: { id: 'it1', session_id: 's1', status: 'completed' }, error: null }),
                }),
              }),
            }),
          }),
        }),
      },
    } as any;
    const events = { publish: async (e: any) => { published.push(e); } } as any;
    const svc = new DevSessionService(db, events);

    await svc.updateIterationStatus('it1', 'org1', 'completed');
    const evt = published.find((e) => e.type === 'dev.iteration.updated');
    expect(evt?.payload?.sessionId).toBe('s1');
  });
});

describe('ClaudeCodeRunnerService auth-error detection', () => {
  const svc = new ClaudeCodeRunnerService();
  const isAuthError = (t: string) => (svc as unknown as { isAuthError: (s: string) => boolean }).isAuthError(t);

  it('flags clear auth failures', () => {
    expect(isAuthError('Error: authentication_error invalid x-api-key')).toBe(true);
    expect(isAuthError('OAuth token expired, please run claude login')).toBe(true);
    expect(isAuthError('HTTP 401 Unauthorized')).toBe(true);
  });

  it('does not flag unrelated errors', () => {
    expect(isAuthError('SyntaxError: unexpected token in file foo.ts')).toBe(false);
    expect(isAuthError('docker: container exited with code 1')).toBe(false);
    expect(isAuthError('')).toBe(false);
  });
});
