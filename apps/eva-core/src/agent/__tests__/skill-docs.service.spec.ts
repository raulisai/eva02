import { Test, TestingModule } from '@nestjs/testing';
import { SkillDocsService } from '../skill-docs.service';
import { DatabaseService } from '../../database/database.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * Thenable Supabase-builder mock: every chain method returns `this`, and the
 * builder resolves to `resolved` when awaited. `from(table)` picks the resolved
 * payload per table from `tables`.
 */
function makeDb(tables: Record<string, { data: unknown; error?: unknown }>) {
  const from = jest.fn((table: string) => {
    const payload = tables[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit', 'maybeSingle', 'update', 'insert', 'upsert', 'delete']) {
      builder[m] = jest.fn(() => builder);
    }
    // maybeSingle resolves to the first row; everything else resolves to the list.
    builder.maybeSingle = jest.fn(() =>
      Promise.resolve({
        data: Array.isArray(payload.data) ? payload.data[0] ?? null : payload.data,
        error: payload.error ?? null,
      }),
    );
    (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: payload.data, error: payload.error ?? null });
    return builder;
  });
  return { admin: { from } } as unknown as DatabaseService;
}

function skillRow(slug: string, category: string, description = `desc ${slug}`, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${slug}`, slug, display_name: slug, description, category,
    kind: 'doc', is_pinned: false, metadata: { generated: true }, latest_version: '1.0.0',
    content_md: `# ${slug}`, ...extra,
  };
}

describe('SkillDocsService', () => {
  async function build(tables: Record<string, { data: unknown; error?: unknown }>) {
    const db = makeDb(tables);
    const module: TestingModule = await Test.createTestingModule({
      providers: [SkillDocsService, { provide: DatabaseService, useValue: db }],
    }).compile();
    return module.get(SkillDocsService);
  }

  /** Like build(), but also exposes the db so callers can assert on writes. */
  async function buildWithDb(tables: Record<string, { data: unknown; error?: unknown }>) {
    const db = makeDb(tables) as unknown as { admin: { from: jest.Mock } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [SkillDocsService, { provide: DatabaseService, useValue: db }],
    }).compile();
    return { svc: module.get(SkillDocsService), db };
  }

  describe('substituteTemplateVars', () => {
    it('replaces known tokens and leaves unresolved ones in place', async () => {
      const svc = await build({});
      const out = svc.substituteTemplateVars(
        'dir=${EVA_SKILL_DIR} task=${EVA_TASK_ID} other=${EVA_UNKNOWN}',
        { skillDir: 'skill://x', taskId: 'task-7' },
      );
      expect(out).toBe('dir=skill://x task=task-7 other=${EVA_UNKNOWN}');
    });

    it('leaves a token untouched when no value is provided', async () => {
      const svc = await build({});
      expect(svc.substituteTemplateVars('t=${EVA_TASK_ID}', { skillDir: 'd' })).toBe('t=${EVA_TASK_ID}');
    });
  });

  describe('getSkillIndexBlock names-only demotion', () => {
    it('expands every category when below the threshold', async () => {
      const svc = await build({
        skills: { data: [skillRow('a', 'coding'), skillRow('b', 'research')] },
      });
      const block = await svc.getSkillIndexBlock(ORG, { goal: 'algo de coding' });
      expect(block).toContain('  coding:');
      expect(block).toContain('    - a: desc a');
      expect(block).toContain('    - b: desc b');
      expect(block).not.toContain('[solo nombres]'); // below threshold → no demotion
    });

    it('demotes off-goal categories to names-only when above the threshold', async () => {
      // 16 skills (> EXPAND_ALL_THRESHOLD=15): coding matches the goal, cooking does not.
      const data = [
        ...Array.from({ length: 8 }, (_, i) => skillRow(`code-${i}`, 'coding', 'deploy and build code')),
        ...Array.from({ length: 8 }, (_, i) => skillRow(`cook-${i}`, 'cooking', 'recetas de pasta')),
      ];
      const svc = await build({ skills: { data } });
      const block = await svc.getSkillIndexBlock(ORG, { goal: 'necesito deploy de code' });

      // coding expanded (has description bullets), cooking demoted to names-only.
      expect(block).toContain('  coding:');
      expect(block).toContain('    - code-0');
      expect(block).toContain('cooking [solo nombres]:');
      expect(block).toContain('cook-0');
      expect(block).not.toContain('    - cook-0:'); // no description bullet for demoted
      expect(block).toContain('[solo nombres]'); // demotion note present
    });

    it('returns empty string when the library is empty', async () => {
      const svc = await build({ skills: { data: [] } });
      expect(await svc.getSkillIndexBlock(ORG, { goal: 'x' })).toBe('');
    });
  });

  describe('viewSkill', () => {
    it('returns content with template vars substituted and graph neighbors', async () => {
      const svc = await build({
        skills: { data: [skillRow('deploy', 'coding', 'deploy stuff', { content_md: 'run in ${EVA_TASK_ID}' })] },
        skill_files: { data: [{ subdir: 'references', filename: 'api.md' }] },
        skill_graph_edges: { data: [{ to_skill_slug: 'rollback', relation: 'precedes', weight: 0.9 }] },
      });
      const detail = await svc.viewSkill(ORG, 'deploy', { taskId: 'task-9' });
      expect(detail?.content_md).toBe('run in task-9');
      expect(detail?.files).toEqual([{ subdir: 'references', filename: 'api.md', path: 'references/api.md' }]);
      expect(detail?.related_skills).toEqual([{ slug: 'rollback', relation: 'precedes', weight: 0.9 }]);
    });
  });

  describe('usage telemetry', () => {
    it('recordSkillView upserts into skill_usage_stats', async () => {
      const { svc, db } = await buildWithDb({ skill_usage_stats: { data: [] } });
      await svc.recordSkillView(ORG, 'deploy', 'generated');
      expect(db.admin.from).toHaveBeenCalledWith('skill_usage_stats');
    });

    it('keeps a recently-used category expanded even when off-goal', async () => {
      const data = [
        ...Array.from({ length: 8 }, (_, i) => skillRow(`code-${i}`, 'coding', 'deploy and build code')),
        ...Array.from({ length: 8 }, (_, i) => skillRow(`cook-${i}`, 'cooking', 'recetas de pasta')),
      ];
      const svc = await build({
        skills: { data },
        // cook-0 fue usada hace poco → su categoría se expande pese a no matchear el goal.
        skill_usage_stats: { data: [{ skill_slug: 'cook-0' }] },
      });
      const block = await svc.getSkillIndexBlock(ORG, { goal: 'necesito deploy de code' });

      expect(block).toContain('  cooking:');
      expect(block).toContain('    - cook-0: recetas de pasta');
      expect(block).not.toContain('cooking [solo nombres]');
    });
  });
});
