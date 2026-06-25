import { ClaudeCodeRunnerService } from '../claude-code-runner.service';

type GitCall = { name: string; args: string[] };

function gitMock(svc: any, handler: (args: string[]) => { ok: boolean; stdout?: string; stderr?: string }) {
  const calls: GitCall[] = [];
  svc.gitExec = jest.fn(async (name: string, args: string[]) => {
    calls.push({ name, args });
    const r = handler(args);
    return { ok: r.ok, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.ok ? undefined : r.stderr };
  });
  return calls;
}

describe('ClaudeCodeRunnerService.setupAgentRepo', () => {
  it('inits + branches from the integration branch when /work is empty and branch is new', async () => {
    const svc: any = new ClaudeCodeRunnerService();
    svc.dockerAvailable = jest.fn().mockResolvedValue(true);
    svc.getOrCreateContainerForKey = jest.fn().mockResolvedValue({ name: 'eva-agent-1' });

    const calls = gitMock(svc, (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: false }; // not a repo yet
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { ok: false }; // agent branch doesn't exist
      return { ok: true };
    });

    const res = await svc.setupAgentRepo({
      orgId: 'org1', machineKey: 'agent1', role: 'backend',
      repoUrl: 'https://github.com/acme/widget', token: 'ghp_x',
      branch: 'agent/ada/iter-1-x', baseBranch: 'develop',
      identity: { name: 'Ada', email: 'backend+1@eva-agents.local' },
    });

    expect(res.ok).toBe(true);
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat).toContain('init');
    expect(flat.some((a) => a.startsWith('remote add origin'))).toBe(true);
    expect(flat).toContain('config user.name Ada');
    // New branch → checkout -B from origin/develop (the integration branch)
    expect(flat).toContain('checkout -B agent/ada/iter-1-x origin/develop');
  });

  it('continues an existing agent branch when origin already has it', async () => {
    const svc: any = new ClaudeCodeRunnerService();
    svc.dockerAvailable = jest.fn().mockResolvedValue(true);
    svc.getOrCreateContainerForKey = jest.fn().mockResolvedValue({ name: 'eva-agent-1' });

    const calls = gitMock(svc, (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true }; // existing clone
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { ok: true }; // agent branch exists
      return { ok: true };
    });

    const res = await svc.setupAgentRepo({
      orgId: 'org1', machineKey: 'agent1', role: 'backend',
      repoUrl: 'https://github.com/acme/widget', token: 'ghp_x',
      branch: 'agent/ada/iter-2-y', baseBranch: 'develop',
      identity: { name: 'Ada', email: 'backend+1@eva-agents.local' },
    });

    expect(res.ok).toBe(true);
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.some((a) => a.startsWith('remote set-url origin'))).toBe(true);
    expect(flat).toContain('checkout -B agent/ada/iter-2-y origin/agent/ada/iter-2-y');
  });

  it('fails clearly when there is no machine to prepare', async () => {
    const svc: any = new ClaudeCodeRunnerService();
    svc.dockerAvailable = jest.fn().mockResolvedValue(true);
    svc.getOrCreateContainerForKey = jest.fn().mockResolvedValue(null);
    const res = await svc.setupAgentRepo({
      orgId: 'org1', machineKey: 'agent1', role: 'backend',
      repoUrl: 'https://github.com/acme/widget', token: 'ghp_x',
      branch: 'b', baseBranch: 'develop', identity: { name: 'A', email: 'a@x' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('NO_MACHINE');
  });
});

describe('ClaudeCodeRunnerService.commitAndPushAgentRepo', () => {
  it('commits and pushes when there are changes, returning the head sha', async () => {
    const svc: any = new ClaudeCodeRunnerService();
    svc.containers.set('agent1', { name: 'eva-agent-1' });
    gitMock(svc, (args) => {
      if (args[0] === 'status') return { ok: true, stdout: ' M src/x.ts\n' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'abc1234\n' };
      return { ok: true };
    });

    const res = await svc.commitAndPushAgentRepo({
      machineKey: 'agent1', token: 'ghp_x', branch: 'agent/ada/iter-1-x',
      message: '[backend] x', identity: { name: 'Ada', email: 'backend+1@eva-agents.local' },
    });
    expect(res).toEqual({ ok: true, pushed: true, headSha: 'abc1234' });
  });

  it('reports NO_CHANGES (ok, not pushed) when the agent produced no edits', async () => {
    const svc: any = new ClaudeCodeRunnerService();
    svc.containers.set('agent1', { name: 'eva-agent-1' });
    gitMock(svc, (args) => {
      if (args[0] === 'status') return { ok: true, stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'base000\n' };
      return { ok: true };
    });

    const res = await svc.commitAndPushAgentRepo({
      machineKey: 'agent1', token: 'ghp_x', branch: 'b',
      message: 'm', identity: { name: 'A', email: 'a@x' },
    });
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.error).toBe('NO_CHANGES');
  });
});

describe('ClaudeCodeRunnerService.redactToken', () => {
  it('removes the literal token and tokenized-remote credentials from output', () => {
    const svc: any = new ClaudeCodeRunnerService();
    const dirty = 'fatal: unable to access https://x-access-token:ghp_supersecret@github.com/acme/widget.git/';
    const clean = svc.redactToken(dirty, 'ghp_supersecret');
    expect(clean).not.toContain('ghp_supersecret');
    expect(clean).toContain('x-access-token:***@');
  });
});
