import { DevOrchestratorService } from '../dev-orchestrator.service';

function makeOrchestrator(parts: { github?: any; sessions?: any; approvals?: any; events?: any }) {
  const events = parts.events ?? { publish: jest.fn(), on: jest.fn() };
  return new DevOrchestratorService(
    events as any, {} as any, {} as any, {} as any, {} as any,
    (parts.sessions ?? {}) as any, {} as any, {} as any,
    (parts.approvals ?? {}) as any, {} as any, (parts.github ?? {}) as any,
  ) as any;
}

const RELEASE_SESSION = {
  id: 's1', user_id: 'u1', title: 'My App',
  repo_url: 'https://github.com/acme/widget', integration_branch: 'develop', base_branch: 'main',
};

describe('DevOrchestratorService.prepareReleasePr', () => {
  it('opens a develop→main PR and gates it through the Approval Engine (level 2)', async () => {
    const github = {
      requireToken: jest.fn().mockResolvedValue('ghp_x'),
      findOpenPullRequest: jest.fn().mockResolvedValue(null),
      createPullRequest: jest.fn().mockResolvedValue({
        number: 12, url: 'https://github.com/acme/widget/pull/12', state: 'open', head: { ref: 'develop', sha: 'sha1' },
      }),
    };
    const created: any[] = [];
    const sessions = {
      listMergeProposals: jest.fn().mockResolvedValue([]),
      createMergeProposal: jest.fn().mockImplementation((input) => { created.push(input); return { id: 'mp1' }; }),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const approvals = { request: jest.fn().mockResolvedValue({ id: 'appr1' }) };
    const svc = makeOrchestrator({ github, sessions, approvals });

    await svc.prepareReleasePr(RELEASE_SESSION, 'org1');

    expect(github.createPullRequest).toHaveBeenCalledWith('org1', 'acme', 'widget', expect.objectContaining({ head: 'develop', base: 'main' }));
    const approvalArg = approvals.request.mock.calls[0][0];
    expect(approvalArg.action_type).toBe('dev_studio.release_merge');
    expect(approvalArg.level).toBe(2);
    expect(created[0]).toEqual(expect.objectContaining({ kind: 'release', approvalId: 'appr1', prNumber: 12, targetBranch: 'main' }));
  });

  it('is idempotent — skips when a release proposal is already in flight', async () => {
    const github = { requireToken: jest.fn().mockResolvedValue('ghp_x'), createPullRequest: jest.fn() };
    const approvals = { request: jest.fn() };
    const sessions = {
      listMergeProposals: jest.fn().mockResolvedValue([{ kind: 'release', status: 'pending' }]),
      createMergeProposal: jest.fn(),
      logEvent: jest.fn(),
    };
    const svc = makeOrchestrator({ github, sessions, approvals });
    await svc.prepareReleasePr(RELEASE_SESSION, 'org1');
    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('does nothing when the session has no repo configured', async () => {
    const github = { requireToken: jest.fn() };
    const svc = makeOrchestrator({ github });
    await svc.prepareReleasePr({ id: 's1', repo_url: null }, 'org1');
    expect(github.requireToken).not.toHaveBeenCalled();
  });
});

describe('DevOrchestratorService.handleReleaseApprovalResolved', () => {
  it('merges develop→main and completes the session when approved', async () => {
    const github = { mergePullRequest: jest.fn().mockResolvedValue({ merged: true, sha: 'm1' }) };
    const sessions = {
      getMergeProposalByApproval: jest.fn().mockResolvedValue({
        id: 'p1', kind: 'release', status: 'pending', session_id: 's1', pr_number: 12, target_branch: 'main',
      }),
      findById: jest.fn().mockResolvedValue({ id: 's1', repo_url: 'https://github.com/acme/widget' }),
      updateMergeProposal: jest.fn().mockResolvedValue({}),
      transition: jest.fn().mockResolvedValue(undefined),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const approvals = { consumeApproved: jest.fn().mockResolvedValue({}) };
    const svc = makeOrchestrator({ github, sessions, approvals });

    await svc.handleReleaseApprovalResolved('appr1', 'approved', 'org1');

    expect(approvals.consumeApproved).toHaveBeenCalledWith('appr1', 'org1');
    expect(github.mergePullRequest).toHaveBeenCalledWith('org1', 'acme', 'widget', 12, 'merge');
    expect(sessions.transition).toHaveBeenCalledWith('s1', 'org1', 'completed');
  });

  it('closes the release PR and resumes the session when rejected', async () => {
    const github = { closePullRequest: jest.fn().mockResolvedValue(undefined) };
    const sessions = {
      getMergeProposalByApproval: jest.fn().mockResolvedValue({
        id: 'p1', kind: 'release', status: 'pending', session_id: 's1', pr_number: 12, target_branch: 'main',
      }),
      findById: jest.fn().mockResolvedValue({ id: 's1', repo_url: 'https://github.com/acme/widget' }),
      updateMergeProposal: jest.fn().mockResolvedValue({}),
      transition: jest.fn().mockResolvedValue(undefined),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const svc = makeOrchestrator({ github, sessions });

    await svc.handleReleaseApprovalResolved('appr1', 'rejected', 'org1');

    expect(github.closePullRequest).toHaveBeenCalledWith('org1', 'acme', 'widget', 12);
    expect(sessions.transition).toHaveBeenCalledWith('s1', 'org1', 'running');
  });

  it('ignores approvals that are not dev-studio release proposals', async () => {
    const sessions = { getMergeProposalByApproval: jest.fn().mockResolvedValue(null) };
    const approvals = { consumeApproved: jest.fn() };
    const github = { mergePullRequest: jest.fn() };
    const svc = makeOrchestrator({ github, sessions, approvals });
    await svc.handleReleaseApprovalResolved('other-approval', 'approved', 'org1');
    expect(approvals.consumeApproved).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });
});
