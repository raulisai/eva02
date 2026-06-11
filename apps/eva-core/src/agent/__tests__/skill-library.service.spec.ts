import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../../database/database.service';
import { SkillLibraryService } from '../skill-library.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Mock encadenable estilo supabase-js: cada método devuelve el builder. */
function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, jest.Mock> = {};
  const self = () => builder;
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = jest.fn(self);
  }
  builder['maybeSingle'] = jest.fn().mockResolvedValue(result);
  // .limit() es el último eslabón en findRelevant — debe resolver el resultado
  builder['limit'] = jest.fn().mockResolvedValue(result);
  return builder;
}

describe('SkillLibraryService', () => {
  let service: SkillLibraryService;
  let from: jest.Mock;

  async function build(tables: Record<string, { data: unknown; error: unknown }[]>) {
    const queues = new Map(Object.entries(tables).map(([k, v]) => [k, [...v]]));
    from = jest.fn((table: string) => {
      const queue = queues.get(table) ?? [];
      const result = queue.length > 1 ? queue.shift()! : queue[0] ?? { data: null, error: null };
      return chain(result);
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillLibraryService,
        { provide: DatabaseService, useValue: { admin: { from } } },
      ],
    }).compile();
    service = module.get(SkillLibraryService);
  }

  describe('findRelevant', () => {
    it('ranks skills by keyword overlap with the goal and drops zero-score ones', async () => {
      await build({
        skills: [{
          data: [
            { slug: 'gen-cleaner', display_name: 'cleaner.py', description: 'Limpia descargas viejas del usuario' },
            { slug: 'gen-csv-report', display_name: 'report.py', description: 'Genera reporte CSV de ventas' },
            { slug: 'gen-otra', display_name: 'otra.py', description: 'Convierte temperaturas' },
          ],
          error: null,
        }],
      });

      const result = await service.findRelevant(ORG, 'genera el reporte de ventas en csv');

      expect(result.map((s) => s.slug)).toEqual(['gen-csv-report']);
      expect(from).toHaveBeenCalledWith('skills');
    });

    it('returns empty list on db errors instead of throwing', async () => {
      await build({ skills: [{ data: null, error: { message: 'boom' } }] });

      await expect(service.findRelevant(ORG, 'ventas')).resolves.toEqual([]);
    });
  });

  describe('getRunnable', () => {
    it('loads the latest version code with its language and filename', async () => {
      await build({
        skills: [{
          data: { id: 'sk-1', slug: 'gen-cleaner', latest_version: '1.0.0', metadata: { language: 'python' } },
          error: null,
        }],
        skill_versions: [{
          data: { instructions: 'print("clean")', manifest: { language: 'python', filename: 'cleaner.py' } },
          error: null,
        }],
      });

      const runnable = await service.getRunnable(ORG, 'gen-cleaner');

      expect(runnable).toEqual({
        slug: 'gen-cleaner', language: 'python', code: 'print("clean")', filename: 'cleaner.py',
      });
    });

    it('returns null when the skill or its version is missing', async () => {
      await build({ skills: [{ data: null, error: null }] });
      await expect(service.getRunnable(ORG, 'nope')).resolves.toBeNull();
    });

    it('defaults unknown languages to python', async () => {
      await build({
        skills: [{ data: { id: 'sk-1', slug: 's', latest_version: '1.0.0', metadata: {} }, error: null }],
        skill_versions: [{ data: { instructions: 'x', manifest: { language: 'ruby' } }, error: null }],
      });

      const runnable = await service.getRunnable(ORG, 's');
      expect(runnable!.language).toBe('python');
    });
  });
});
