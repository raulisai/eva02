import { DevOrchestratorService } from '../dev-orchestrator.service';
import { GithubNotConnectedError } from '../github/github.service';

function makeOrchestrator(overrides: { github?: any; sessions?: any; events?: any }) {
  const events = overrides.events ?? { publish: jest.fn(), on: jest.fn() };
  const sessions = overrides.sessions ?? {};
  const github = overrides.github ?? {};
  return new DevOrchestratorService(
    events as any, {} as any, {} as any, {} as any, {} as any,
    sessions as any, {} as any, {} as any, {} as any, {} as any, github as any,
  ) as any;
}

describe('DevOrchestratorService.resolveSessionRepoContext', () => {
  it('returns null when the session has no repo configured (git flow disabled)', async () => {
    const github = { requireToken: jest.fn() };
    const svc = makeOrchestrator({ github });
    const ctx = await svc.resolveSessionRepoContext({ repo_url: null }, 'org1');
    expect(ctx).toBeNull();
    expect(github.requireToken).not.toHaveBeenCalled();
  });

  it('propagates GithubNotConnectedError when a repo is set but no token exists', async () => {
    const github = { requireToken: jest.fn().mockRejectedValue(new GithubNotConnectedError()) };
    const svc = makeOrchestrator({ github });
    await expect(
      svc.resolveSessionRepoContext({ repo_url: 'https://github.com/acme/widget' }, 'org1'),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
  });

  it('resolves owner/repo and ensures the integration branch from base', async () => {
    const github = {
      requireToken: jest.fn().mockResolvedValue('ghp_x'),
      ensureBranch: jest.fn().mockResolvedValue('sha'),
      getRepo: jest.fn(),
    };
    const svc = makeOrchestrator({ github });
    const ctx = await svc.resolveSessionRepoContext(
      { repo_url: 'https://github.com/acme/widget.git', integration_branch: 'develop', base_branch: 'main' },
      'org1',
    );
    expect(ctx).toEqual({
      owner: 'acme', repo: 'widget', repoUrl: 'https://github.com/acme/widget.git',
      integrationBranch: 'develop', token: 'ghp_x',
    });
    expect(github.ensureBranch).toHaveBeenCalledWith('org1', 'acme', 'widget', 'develop', 'main');
  });

  it('retries from the repo default branch when base does not exist', async () => {
    const github = {
      requireToken: jest.fn().mockResolvedValue('ghp_x'),
      ensureBranch: jest
        .fn()
        .mockRejectedValueOnce(new Error('base "main" no existe'))
        .mockResolvedValueOnce('sha'),
      getRepo: jest.fn().mockResolvedValue({ defaultBranch: 'master' }),
    };
    const svc = makeOrchestrator({ github });
    const ctx = await svc.resolveSessionRepoContext(
      { repo_url: 'https://github.com/acme/widget', base_branch: 'main' },
      'org1',
    );
    expect(ctx.integrationBranch).toBe('develop');
    expect(github.ensureBranch).toHaveBeenLastCalledWith('org1', 'acme', 'widget', 'develop', 'master');
  });
});

describe('DevOrchestratorService.ensureGithubProvisioningTask', () => {
  it('creates a github_connect human task and parks the session for setup', async () => {
    const sessions = {
      listHumanTasks: jest.fn().mockResolvedValue([]),
      createHumanTask: jest.fn().mockResolvedValue(undefined),
      transition: jest.fn().mockResolvedValue(undefined),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const events = { publish: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    const svc = makeOrchestrator({ sessions, events });

    await svc.ensureGithubProvisioningTask({ id: 'session1' }, 'org1', { id: 'iter1' });

    expect(sessions.createHumanTask).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: expect.objectContaining({ kind: 'github_connect' }) }),
    );
    expect(sessions.transition).toHaveBeenCalledWith('session1', 'org1', 'waiting_for_human_setup');
  });

  it('does not create a duplicate when one is already pending', async () => {
    const sessions = {
      listHumanTasks: jest.fn().mockResolvedValue([{ instructions: { kind: 'github_connect' } }]),
      createHumanTask: jest.fn(),
      transition: jest.fn(),
      logEvent: jest.fn(),
    };
    const svc = makeOrchestrator({ sessions });
    await svc.ensureGithubProvisioningTask({ id: 'session1' }, 'org1', { id: 'iter1' });
    expect(sessions.createHumanTask).not.toHaveBeenCalled();
  });
});
