import { extractJson } from '../dev-studio.utils';
import { TEAM_TIER_CONFIG } from '../dev-studio.types';
import { DevArchitectService } from '../dev-architect.service';
import { DevProjectManagerService } from '../dev-project-manager.service';

// ── extractJson ───────────────────────────────────────────────────────────────

describe('extractJson', () => {
  it('parses clean JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences', () => {
    expect(extractJson<{ x: string }>('```json\n{"x":"y"}\n```')).toEqual({ x: 'y' });
  });

  it('strips leading prose', () => {
    expect(extractJson<{ n: number }>('Here is the result:\n{"n":42}')).toEqual({ n: 42 });
  });

  it('strips trailing commas before closing brackets', () => {
    expect(extractJson<{ a: number[] }>('{"a":[1,2,]}')).toEqual({ a: [1, 2] });
  });

  it('repairs truncated JSON (missing closing braces)', () => {
    const truncated = '{"tasks":[{"title":"foo","role":"backend"';
    const result = extractJson<{ tasks: { title: string; role: string }[] }>(truncated);
    expect(result.tasks[0].title).toBe('foo');
  });

  it('throws a descriptive error on completely unparseable input', () => {
    expect(() => extractJson('not json at all ////')).toThrow('extractJson failed');
  });
});

// ── TEAM_TIER_CONFIG ──────────────────────────────────────────────────────────

describe('TEAM_TIER_CONFIG', () => {
  it('small tier allows only 1-dev roles and max 2 tasks', () => {
    const cfg = TEAM_TIER_CONFIG.small;
    expect(cfg.availableRoles).toContain('full_stack');
    expect(cfg.availableRoles).not.toContain('reviewer');
    expect(cfg.availableRoles).not.toContain('deployment');
    expect(cfg.maxTasksPerIteration).toBe(2);
  });

  it('medium tier excludes reviewer and deployment', () => {
    const cfg = TEAM_TIER_CONFIG.medium;
    expect(cfg.availableRoles).not.toContain('reviewer');
    expect(cfg.availableRoles).not.toContain('deployment');
    expect(cfg.maxTasksPerIteration).toBe(4);
  });

  it('large tier has full specialist set with max 6 tasks', () => {
    const cfg = TEAM_TIER_CONFIG.large;
    expect(cfg.availableRoles).toContain('testing');
    expect(cfg.availableRoles).toContain('reviewer');
    expect(cfg.availableRoles).toContain('deployment');
    expect(cfg.maxTasksPerIteration).toBe(6);
  });
});

// ── DevArchitectService — tier guards ─────────────────────────────────────────

describe('DevArchitectService tier guards', () => {
  function makeArchitect(responseText: string): DevArchitectService {
    const modelRouter = {
      generate: jest.fn().mockResolvedValue({ text: responseText }),
    } as any;
    return new DevArchitectService(modelRouter);
  }

  const baseSession = { id: 's1', org_id: 'o1', title: 'Test', north_star: 'ship it', metadata: {} } as any;
  const baseGoal = { id: 'g1', title: 'Goal', description: 'Do X', success_criteria: [] } as any;
  const baseIter = { id: 'i1', title: 'Iteration 1', number: 1, objective: 'Build X', planned_outputs: [] } as any;

  it('remaps out-of-tier roles to the first allowed role', async () => {
    const plan = JSON.stringify({
      tasks: [
        { title: 'Deploy', role: 'deployment', priority: 90, dependsOn: [], acceptanceCriteria: [], branchName: 'agent/deployment/x' },
        { title: 'Code', role: 'backend', priority: 80, dependsOn: [], acceptanceCriteria: [], branchName: 'agent/backend/x' },
      ],
    });
    const svc = makeArchitect(plan);
    const result = await svc.deriveTasks(baseSession, baseGoal, baseIter, 'small');
    // 'deployment' is not in small tier → remapped to 'full_stack' (index 0)
    const deployTask = result.tasks.find((t) => t.title === 'Deploy');
    expect(deployTask?.role).toBe('full_stack');
    // 'backend' is in small tier → kept
    const codeTask = result.tasks.find((t) => t.title === 'Code');
    expect(codeTask?.role).toBe('backend');
  });

  it('trims tasks exceeding maxTasksPerIteration by priority', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      title: `Task ${i}`,
      role: 'backend',
      priority: i * 10,  // Task 4 has highest priority (40)
      dependsOn: [],
      acceptanceCriteria: [],
      branchName: `agent/backend/t${i}`,
    }));
    const svc = makeArchitect(JSON.stringify({ tasks }));
    const result = await svc.deriveTasks(baseSession, baseGoal, baseIter, 'small');
    // small tier max is 2
    expect(result.tasks.length).toBe(2);
    // highest priority tasks should survive
    expect(result.tasks[0].title).toBe('Task 4');
    expect(result.tasks[1].title).toBe('Task 3');
  });

  it('falls back to tier-appropriate roles when LLM fails', async () => {
    const modelRouter = {
      generate: jest.fn().mockRejectedValue(new Error('LLM error')),
    } as any;
    const svc = new DevArchitectService(modelRouter);

    const result = await svc.deriveTasks(baseSession, baseGoal, baseIter, 'small');
    expect(result.tasks.every((t) => TEAM_TIER_CONFIG.small.availableRoles.includes(t.role))).toBe(true);
    // small tier has no testing → no testing task in fallback
    expect(result.tasks.some((t) => t.role === 'testing')).toBe(false);
  });

  it('includes testing in fallback only when tier allows it', async () => {
    const modelRouter = {
      generate: jest.fn().mockRejectedValue(new Error('LLM error')),
    } as any;
    const svc = new DevArchitectService(modelRouter);
    const goalWithCriteria = {
      ...baseGoal,
      success_criteria: [{ id: 'c1', description: 'must pass', verifiable: true, verified: false }],
    };

    const resultMedium = await svc.deriveTasks(baseSession, goalWithCriteria, baseIter, 'medium');
    expect(resultMedium.tasks.some((t) => t.role === 'testing')).toBe(true);

    const resultSmall = await svc.deriveTasks(baseSession, goalWithCriteria, baseIter, 'small');
    expect(resultSmall.tasks.some((t) => t.role === 'testing')).toBe(false);
  });
});

// ── DevProjectManagerService — teamTier heuristic fallback ────────────────────

describe('DevProjectManagerService teamTier heuristic', () => {
  function makePm(responseText: string): DevProjectManagerService {
    const modelRouter = {
      generate: jest.fn().mockResolvedValue({ text: responseText }),
    } as any;
    const sessions = {} as any;
    return new DevProjectManagerService(modelRouter, sessions);
  }

  const baseSession = { id: 's1', org_id: 'o1', title: 'Test', original_prompt: 'build something' } as any;

  it('accepts a valid teamTier from the LLM', async () => {
    const svc = makePm(JSON.stringify({
      northStar: 'Ship it',
      goals: [{ title: 'G1', description: 'd', priority: 1, successCriteria: [] }],
      definitionOfDone: [],
      teamTier: 'medium',
      teamTierReason: 'balanced project',
    }));
    const result = await svc.generateNorthStarAndGoals(baseSession);
    expect(result.teamTier).toBe('medium');
  });

  it('applies heuristic fallback for invalid teamTier', async () => {
    const svc = makePm(JSON.stringify({
      northStar: 'Ship it',
      goals: [{ title: 'G1', description: 'd', priority: 1, successCriteria: [] }],
      definitionOfDone: [],
      teamTier: 'enterprise',  // invalid
      teamTierReason: 'some reason',
    }));
    const result = await svc.generateNorthStarAndGoals(baseSession);
    expect(['small', 'medium', 'large']).toContain(result.teamTier);
    expect(result.teamTierReason).toMatch(/heurística/);
  });

  it('maps 1-2 goals → small tier via heuristic', async () => {
    const goals = [{ title: 'G1', description: 'd', priority: 1, successCriteria: [] }];
    const svc = makePm(JSON.stringify({
      northStar: 'PoC',
      goals,
      definitionOfDone: [],
      teamTier: 'invalid',
      teamTierReason: '',
    }));
    const result = await svc.generateNorthStarAndGoals(baseSession);
    expect(result.teamTier).toBe('small');
  });

  it('maps 3-4 goals → medium tier via heuristic', async () => {
    const goals = Array.from({ length: 3 }, (_, i) => ({
      title: `G${i}`, description: 'd', priority: i, successCriteria: [],
    }));
    const svc = makePm(JSON.stringify({
      northStar: 'SaaS',
      goals,
      definitionOfDone: [],
      teamTier: 'invalid',
      teamTierReason: '',
    }));
    const result = await svc.generateNorthStarAndGoals(baseSession);
    expect(result.teamTier).toBe('medium');
  });

  it('maps 5+ goals → large tier via heuristic', async () => {
    const goals = Array.from({ length: 5 }, (_, i) => ({
      title: `G${i}`, description: 'd', priority: i, successCriteria: [],
    }));
    const svc = makePm(JSON.stringify({
      northStar: 'Platform',
      goals,
      definitionOfDone: [],
      teamTier: 'invalid',
      teamTierReason: '',
    }));
    const result = await svc.generateNorthStarAndGoals(baseSession);
    expect(result.teamTier).toBe('large');
  });
});
