import { slugify, agentBranchName, agentGitIdentity } from '../dev-studio.utils';

describe('slugify', () => {
  it('lowercases, strips diacritics, and hyphenates', () => {
    expect(slugify('Diseño Inicial')).toBe('diseno-inicial');
    expect(slugify('Endpoint /products!!')).toBe('endpoint-products');
    expect(slugify('  spaced   out  ')).toBe('spaced-out');
  });

  it('falls back to a safe default for empty input', () => {
    expect(slugify('')).toBe('task');
    expect(slugify('***')).toBe('task');
  });

  it('bounds length without leaving a trailing hyphen', () => {
    const s = slugify('a'.repeat(50) + ' word', 10);
    expect(s.length).toBeLessThanOrEqual(10);
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('agentBranchName', () => {
  it('embeds the agent NAME and iteration so branches are attributable', () => {
    expect(agentBranchName('Ada (backend)', 'Create products endpoint', 2)).toBe(
      'agent/ada-backend/iter-2-create-products-endpoint',
    );
  });

  it('defaults iteration to 1 when invalid', () => {
    expect(agentBranchName('Ada', 'X', 0)).toBe('agent/ada/iter-1-x');
    expect(agentBranchName('Ada', 'X', NaN)).toBe('agent/ada/iter-1-x');
  });
});

describe('agentGitIdentity', () => {
  it('uses the agent name and a unique noreply email keyed by id', () => {
    const id = '1234abcd-5678-90ef-ghij-klmnopqrstuv';
    const identity = agentGitIdentity({ id, name: 'Ada', role: 'backend' });
    expect(identity.name).toBe('Ada');
    expect(identity.email).toBe('backend+1234abcd@eva-agents.local');
  });

  it('falls back to a role-based name when name is blank', () => {
    const identity = agentGitIdentity({ id: 'abcdef12-0000', name: '  ', role: 'frontend' });
    expect(identity.name).toBe('EVA frontend');
    expect(identity.email).toBe('frontend+abcdef12@eva-agents.local');
  });
});
