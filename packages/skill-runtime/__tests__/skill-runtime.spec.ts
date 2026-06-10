import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader, SkillPermissionEvaluator, SkillRegistry } from '../src';

const fixturesRoot = join(__dirname, '..', 'skills');

describe('skill-runtime', () => {
  it('loads an initial skeleton skill and validates manifest with zod', async () => {
    const loader = new SkillLoader();
    const skill = await loader.loadSkill(join(fixturesRoot, 'gmail'));

    expect(skill.manifest.name).toBe('gmail');
    expect(skill.manifest.version).toBe('0.1.0');
    expect(skill.tools[0].name).toBe('gmail.search');
    expect(skill.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('loads the public APIs skill for weather and recipes', async () => {
    const skill = await new SkillLoader().loadSkill(join(fixturesRoot, 'public-apis'));

    expect(skill.manifest.name).toBe('public-apis');
    expect(skill.tools.map((tool) => tool.name)).toEqual([
      'public_api.weather_forecast',
      'public_api.recipe_search',
    ]);
    expect(skill.permissions.secrets).toEqual([]);
  });

  it('rejects an invalid manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eva-skill-'));
    await Promise.all([
      writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'Bad Skill', version: '' })),
      writeFile(join(dir, 'instructions.md'), 'bad'),
      writeFile(join(dir, 'tools.json'), JSON.stringify({ tools: [] })),
      writeFile(join(dir, 'permissions.json'), JSON.stringify({})),
      writeFile(join(dir, 'examples.json'), JSON.stringify({ examples: [] })),
      writeFile(join(dir, 'tests.json'), JSON.stringify({ tests: [] })),
      writeFile(join(dir, 'memory_policy.json'), JSON.stringify({})),
      writeFile(join(dir, 'approval_policy.json'), JSON.stringify({})),
    ]);

    await expect(new SkillLoader().loadSkill(dir)).rejects.toThrow();
  });

  it('versions skills without overwriting an existing version', async () => {
    const loader = new SkillLoader();
    const registry = new SkillRegistry();
    const gmail = await loader.loadSkill(join(fixturesRoot, 'gmail'));
    const telegram = await loader.loadSkill(join(fixturesRoot, 'telegram'));

    registry.register(gmail);
    registry.register(telegram);

    expect(registry.latest('gmail')?.version).toBe('0.1.0');
    expect(registry.versionsFor('gmail')).toHaveLength(1);
    expect(() => registry.register(gmail)).toThrow(/already registered/);
  });

  it('enforces permissions per skill and resolves approval policy', async () => {
    const skill = await new SkillLoader().loadSkill(join(fixturesRoot, 'claude-code'));
    const permissions = new SkillPermissionEvaluator();

    expect(permissions.canUseTool(skill, 'claude_code.send_task')).toBe(true);
    expect(permissions.canUseTool(skill, 'gmail.send')).toBe(false);
    expect(permissions.approvalLevelFor(skill, 'claude_code.send_task', { prompt: 'deploy production' })).toBe(2);
  });
});
