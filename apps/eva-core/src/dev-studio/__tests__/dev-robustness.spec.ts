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
