import { DevArchitectService } from '../dev-architect.service';
import { DevOrchestratorService } from '../dev-orchestrator.service';

// ── Architect PR review ───────────────────────────────────────────────────────

describe('DevArchitectService.reviewPullRequest', () => {
  const files = [{ filename: 'src/x.ts', status: 'modified', additions: 10, deletions: 2, patch: '+x' }];

  it('returns the model decision when the LLM responds', async () => {
    const modelRouter = {
      generate: jest.fn().mockResolvedValue({
        text: JSON.stringify({ decision: 'approve', summary: 'looks good', riskLevel: 'low' }),
      }),
    };
    const svc = new DevArchitectService(modelRouter as any);
    const out = await svc.reviewPullRequest({
      orgId: 'org1', taskTitle: 't', taskPrompt: 'p', acceptanceCriteria: [], files,
    });
    expect(out.decision).toBe('approve');
    expect(out.riskLevel).toBe('low');
  });

  it('falls back to approve when the LLM fails but there are changes and no failing tests', async () => {
    const modelRouter = { generate: jest.fn().mockRejectedValue(new Error('LLM down')) };
    const svc = new DevArchitectService(modelRouter as any);
    const out = await svc.reviewPullRequest({
      orgId: 'org1', taskTitle: 't', taskPrompt: 'p', acceptanceCriteria: [], files,
      testResult: { passed: true },
    });
    expect(out.decision).toBe('approve');
  });

  it('falls back to changes_requested when the LLM fails and tests are failing', async () => {
    const modelRouter = { generate: jest.fn().mockRejectedValue(new Error('LLM down')) };
    const svc = new DevArchitectService(modelRouter as any);
    const out = await svc.reviewPullRequest({
      orgId: 'org1', taskTitle: 't', taskPrompt: 'p', acceptanceCriteria: [], files,
      testResult: { failed: 3 },
    });
    expect(out.decision).toBe('changes_requested');
  });
});

// ── Orchestrator human approve / reject of a PR-backed proposal ────────────────

function makeOrchestrator(github: any, sessions: any) {
  const events = { publish: jest.fn(), on: jest.fn() };
  return new DevOrchestratorService(
    events as any, {} as any, {} as any, {} as any, {} as any,
    sessions as any, {} as any, {} as any, {} as any, {} as any, github as any,
  ) as any;
}

describe('DevOrchestratorService.approveMergeProposal', () => {
  it('squash-merges a feature PR and marks the proposal merged', async () => {
    const github = { mergePullRequest: jest.fn().mockResolvedValue({ merged: true, sha: 'abc' }) };
    const updated: any[] = [];
    const sessions = {
      getMergeProposal: jest.fn().mockResolvedValue({ id: 'p1', session_id: 's1', pr_number: 5, kind: 'feature', target_branch: 'develop' }),
      findById: jest.fn().mockResolvedValue({ repo_url: 'https://github.com/acme/widget' }),
      updateMergeProposal: jest.fn().mockImplementation((id, org, patch) => { updated.push(patch); return { id, ...patch }; }),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const svc = makeOrchestrator(github, sessions);
    await svc.approveMergeProposal('p1', 'org1', 'ship it');

    expect(github.mergePullRequest).toHaveBeenCalledWith('org1', 'acme', 'widget', 5, 'squash');
    expect(updated.at(-1)).toEqual(expect.objectContaining({ status: 'merged', pr_state: 'merged' }));
  });

  it('refuses to direct-merge a release PR (must go through the Approval Engine)', async () => {
    const github = { mergePullRequest: jest.fn() };
    const sessions = {
      getMergeProposal: jest.fn().mockResolvedValue({ id: 'p1', session_id: 's1', pr_number: 9, kind: 'release', target_branch: 'main' }),
    };
    const svc = makeOrchestrator(github, sessions);
    await expect(svc.approveMergeProposal('p1', 'org1')).rejects.toThrow(/Approvals/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it('marks the proposal conflicted when the PR is not mergeable', async () => {
    const github = { mergePullRequest: jest.fn().mockResolvedValue({ merged: false, message: 'conflict' }) };
    const sessions = {
      getMergeProposal: jest.fn().mockResolvedValue({ id: 'p1', session_id: 's1', pr_number: 5, kind: 'feature', target_branch: 'develop' }),
      findById: jest.fn().mockResolvedValue({ repo_url: 'https://github.com/acme/widget' }),
      updateMergeProposal: jest.fn().mockImplementation((id, org, patch) => ({ id, ...patch })),
      logEvent: jest.fn().mockResolvedValue(undefined),
    };
    const svc = makeOrchestrator(github, sessions);
    const res = await svc.approveMergeProposal('p1', 'org1');
    expect(res.status).toBe('conflicted');
  });
});

describe('DevOrchestratorService.rejectMergeProposal', () => {
  it('closes the PR on GitHub and marks the proposal rejected', async () => {
    const github = { closePullRequest: jest.fn().mockResolvedValue(undefined) };
    const sessions = {
      getMergeProposal: jest.fn().mockResolvedValue({ id: 'p1', session_id: 's1', pr_number: 7 }),
      findById: jest.fn().mockResolvedValue({ repo_url: 'https://github.com/acme/widget' }),
      updateMergeProposal: jest.fn().mockImplementation((id, org, patch) => ({ id, ...patch })),
    };
    const svc = makeOrchestrator(github, sessions);
    const res = await svc.rejectMergeProposal('p1', 'org1', 'not now');
    expect(github.closePullRequest).toHaveBeenCalledWith('org1', 'acme', 'widget', 7);
    expect(res.status).toBe('rejected');
  });
});
