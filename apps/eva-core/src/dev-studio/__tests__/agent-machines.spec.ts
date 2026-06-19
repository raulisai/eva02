import { machineSpecForRole, imageCandidates, LEGACY_IMAGE } from '../agent-machines';

describe('agent-machines registry', () => {
  it('gives code roles their dedicated images', () => {
    expect(machineSpecForRole('backend').image).toBe('eva-agent-backend');
    expect(machineSpecForRole('frontend').image).toBe('eva-agent-frontend');
    expect(machineSpecForRole('testing').image).toBe('eva-agent-testing');
  });

  it('routes full_stack to a code image (not the base) with both toolchains', () => {
    const spec = machineSpecForRole('full_stack');
    expect(spec.image).not.toBe('eva-agent-base');
    expect(spec.toolingLabel).toMatch(/node/);
    expect(spec.toolingLabel).toMatch(/python/);
  });

  it('routes analysis roles to the lightweight base image', () => {
    for (const role of ['architect', 'project_manager', 'reviewer', 'deployment']) {
      expect(machineSpecForRole(role).image).toBe('eva-agent-base');
    }
  });

  it('falls back to the base spec for unknown roles', () => {
    expect(machineSpecForRole('totally_unknown').image).toBe('eva-agent-base');
  });

  it('gives code roles more memory than analysis roles', () => {
    const backendMem = parseInt(machineSpecForRole('backend').memory, 10);
    const pmMem = parseInt(machineSpecForRole('project_manager').memory, 10);
    expect(backendMem).toBeGreaterThan(pmMem);
  });

  it('orders image candidates role → base → legacy and de-dupes', () => {
    const candidates = imageCandidates('backend');
    expect(candidates[0]).toBe('eva-agent-backend');
    expect(candidates).toContain('eva-agent-base');
    expect(candidates).toContain(LEGACY_IMAGE);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('collapses candidates to base+legacy for analysis roles', () => {
    const candidates = imageCandidates('architect');
    expect(candidates[0]).toBe('eva-agent-base');
    // base role image === base, so only base + legacy remain
    expect(candidates).toEqual(['eva-agent-base', LEGACY_IMAGE]);
  });
});
