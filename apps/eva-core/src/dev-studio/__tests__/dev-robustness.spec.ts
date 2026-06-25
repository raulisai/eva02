import { DevSessionService } from '../dev-session.service';
import { ClaudeCodeRunnerService } from '../claude-code-runner.service';
import { DevStudioController } from '../dev-studio.controller';
import { DevOrchestratorService } from '../dev-orchestrator.service';

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

describe('ClaudeCodeRunnerService OAuth URL extraction', () => {
  const extract = (text: string) => ClaudeCodeRunnerService.extractOAuthUrlFromOutput(text);
  const query =
    'client_id=d-testclient&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
    '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code' +
    '&code_challenge=testChallenge_123&code_challenge_method=S256&state=testState_456';

  it('extracts a complete Claude OAuth URL from plain output', () => {
    const url = extract(`Open this URL:\nhttps://claude.ai/oauth/authorize?${query}\nPaste code here >`);
    expect(url).toBe(`https://claude.ai/oauth/authorize?${query}`);
  });

  it('reconstructs a line-wrapped OAuth URL before the code prompt', () => {
    const output = `https://claude.ai/oauth/authorize?client_id=d-testclient&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback
&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code
&code_challenge=testChallenge_123&code_challenge_method=S256&state=testState_456 Paste code here if prompted >`;
    expect(extract(output)).toBe(`https://claude.ai/oauth/authorize?${query}`);
  });

  it('uses OSC hyperlink targets when terminal output hides the raw URL', () => {
    const hidden = `\x1b]8;;https://claude.ai/oauth/authorize?${query}\x07open auth link\x1b]8;;\x07`;
    expect(extract(`${hidden}\nPaste code here >`)).toBe(`https://claude.ai/oauth/authorize?${query}`);
  });

  it('rebuilds the authorize URL when the CLI prints only the query fragment', () => {
    expect(extract(`${query} Paste code here if prompted >`)).toBe(`https://claude.ai/oauth/authorize?${query}`);
  });
});

describe('ClaudeCodeRunnerService OAuth code submission', () => {
  it('treats duplicate code submits as accepted once the code is in flight', () => {
    const svc = new ClaudeCodeRunnerService();
    const writes: string[] = [];
    const pendingOAuth = (svc as unknown as { pendingOAuth: Map<string, unknown> }).pendingOAuth;
    pendingOAuth.set('agent1', {
      proc: { stdin: { write: (text: string) => { writes.push(text); } } },
      orgId: 'org1',
      fullBuf: '',
      state: { status: 'waiting_for_code', url: null, configured: false, error: null },
      onUrl: null,
      onError: null,
    });

    expect(svc.submitOAuthCode('agent1', 'abc123')).toBe(true);
    expect(svc.submitOAuthCode('agent1', 'abc123')).toBe(true);
    expect(writes).toEqual(['abc123\n']);
  });
});

describe('ClaudeCodeRunnerService machine-local OAuth', () => {
  it('accepts a persistent machine that already has local Claude auth', async () => {
    const svc = new ClaudeCodeRunnerService();
    const containers = (svc as unknown as {
      containers: Map<string, { hasToken: boolean }>;
    }).containers;
    containers.set('agent1', { hasToken: true });

    await expect(svc.hasCredential('org1', 'agent1')).resolves.toBe(true);
    await expect(svc.hasCredential('org1')).resolves.toBe(false);
  });

  it('completes OAuth when CLI status confirms login without an exportable token', async () => {
    const svc = new ClaudeCodeRunnerService();
    const internals = svc as unknown as {
      containers: Map<string, { hasToken: boolean }>;
      readOAuthTokenFromContainer: (container: string) => Promise<string | null>;
      checkContainerAuthStatus: (container: string) => Promise<boolean>;
      finalizeOAuthFromContainer: (key: string, pending: Record<string, unknown>) => Promise<boolean>;
    };
    internals.containers.set('agent1', { hasToken: false });
    jest.spyOn(internals, 'readOAuthTokenFromContainer').mockResolvedValue(null);
    jest.spyOn(internals, 'checkContainerAuthStatus').mockResolvedValue(true);
    const pending = {
      orgId: 'org1',
      containerName: 'eva-agent-1',
      state: { status: 'waiting_callback', url: null, configured: false, error: null },
    };

    await expect(internals.finalizeOAuthFromContainer('agent1', pending)).resolves.toBe(true);
    expect(pending.state).toMatchObject({ status: 'completed', configured: true, error: null });
    expect(internals.containers.get('agent1')?.hasToken).toBe(true);
  });

  it('accepts terminal login status without requiring a model probe', async () => {
    const svc = new ClaudeCodeRunnerService();
    const internals = svc as unknown as {
      containers: Map<string, { name: string; hasToken: boolean }>;
      checkContainerAuthStatus: (container: string) => Promise<boolean>;
      probe: (prefix: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean }>;
    };
    internals.containers.set('agent1', { name: 'eva-agent-1', hasToken: false });
    jest.spyOn(internals, 'checkContainerAuthStatus').mockResolvedValue(true);
    const probe = jest.spyOn(internals, 'probe').mockResolvedValue({ ok: false });

    await expect(svc.verifyAuth('org1', 'agent1')).resolves.toEqual({ ok: true });
    expect(probe).not.toHaveBeenCalled();
    expect(internals.containers.get('agent1')?.hasToken).toBe(true);
  });
});

describe('DevStudioController manual Claude login reconciliation', () => {
  it('clears the auth blocker, verifies provisioning, and resumes the session', async () => {
    const sessions = {
      getAgent: jest.fn().mockResolvedValue({
        id: 'agent1', status: 'blocked', current_task_id: null,
        metadata: { machine: { authOk: false, authError: 'NO_TOKEN' } },
      }),
      listHumanTasks: jest.fn().mockResolvedValue([
        { id: 'human1', instructions: { kind: 'claude_code_auth' } },
      ]),
      updateAgentStatus: jest.fn().mockResolvedValue(undefined),
      submitHumanTask: jest.fn().mockResolvedValue(undefined),
      verifyHumanTask: jest.fn().mockResolvedValue(undefined),
    };
    const orchestrator = { tick: jest.fn().mockResolvedValue(undefined) };
    const claudeCode = {
      hasContainer: jest.fn().mockReturnValue(true),
      verifyAuth: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new DevStudioController(sessions as any, orchestrator as any, claudeCode as any, {} as any, {} as any);

    await expect(controller.checkAgentAuth('session1', 'backend', {
      user: { orgId: 'org1' },
    } as any)).resolves.toEqual({ ok: true, authOk: true, error: null });

    expect(sessions.updateAgentStatus).toHaveBeenCalledWith(
      'agent1', 'org1', 'idle',
      expect.objectContaining({
        current_task_id: null,
        metadata: expect.objectContaining({
          machine: expect.objectContaining({ authOk: true, authError: null }),
        }),
      }),
    );
    expect(sessions.submitHumanTask).toHaveBeenCalledWith(
      'human1', 'org1', { method: 'oauth', configured: true },
    );
    expect(sessions.verifyHumanTask).toHaveBeenCalledWith('human1', 'org1');
    expect(orchestrator.tick).toHaveBeenCalledWith('session1', 'org1');
  });
});

describe('DevOrchestratorService queued task resumption', () => {
  it('scopes the iteration by org, closes it, and ticks after resumed work', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'iteration1', title: 'Initial board', status: 'running' },
    });
    const eqOrg = jest.fn().mockReturnValue({ maybeSingle });
    const eqId = jest.fn().mockReturnValue({ eq: eqOrg });
    const db = {
      admin: { from: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ eq: eqId }) }) },
    };
    const sessions = {
      updateStudioTaskStatus: jest.fn().mockResolvedValue(undefined),
      listIterationTasks: jest.fn().mockResolvedValue([
        { id: 'task1', status: 'needs_review', result_summary: 'Canvas rendered' },
      ]),
      buildIterationOutputs: jest.fn().mockResolvedValue(['Canvas rendered']),
      updateIterationStatus: jest.fn().mockResolvedValue(undefined),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new DevOrchestratorService(
      {} as any, {} as any, {} as any, {} as any, db as any,
      sessions as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    const internals = svc as unknown as {
      runAgentTask: (...args: unknown[]) => Promise<boolean>;
      tickSafe: (sessionId: string, orgId: string) => Promise<void>;
      runWaveFromQueued: (
        session: Record<string, unknown>, orgId: string, tasks: Record<string, unknown>[],
      ) => Promise<number>;
    };
    jest.spyOn(internals, 'runAgentTask').mockResolvedValue(true);
    const tickSafe = jest.spyOn(internals, 'tickSafe').mockResolvedValue(undefined);

    await expect(internals.runWaveFromQueued(
      { id: 'session1' },
      'org1',
      [{ id: 'task1', iteration_id: 'iteration1', role: 'backend', prompt: 'Render canvas' }],
    )).resolves.toBe(1);

    expect(eqId).toHaveBeenCalledWith('id', 'iteration1');
    expect(eqOrg).toHaveBeenCalledWith('org_id', 'org1');
    expect(sessions.updateIterationStatus).toHaveBeenCalledWith(
      'iteration1', 'org1', 'completed',
      expect.objectContaining({ completed_outputs: ['Canvas rendered'] }),
    );
    expect(tickSafe).toHaveBeenCalledWith('session1', 'org1');
  });
});
