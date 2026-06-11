import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SandboxLanguage } from './sandbox.service';

export interface SkillSummary {
  slug: string;
  display_name: string;
  description: string;
}

export interface RunnableSkill {
  slug: string;
  language: SandboxLanguage;
  code: string;
  filename: string;
}

/** Palabras vacías que no aportan señal al matching de skills. */
const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'que', 'con', 'para', 'por',
  'en', 'y', 'o', 'a', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'me', 'te', 'se', 'lo', 'al', 'es',
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'with', 'eva', 'script', 'auto',
  'generada', 'generado', 'crea', 'crear', 'genera', 'generar', 'haz', 'hacer', 'dame',
]);

/**
 * SkillLibraryService — cierra el ciclo de auto-mejora: las skills que
 * script-forge registra dejan de ser write-only. El agent-loop las recupera
 * por relevancia léxica (slug + nombre + descripción) y las re-ejecuta con
 * skill_run sin regenerar el código (cero tokens de generación la 2ª vez).
 *
 * Matching deliberadamente barato (keyword overlap, sin embeddings): no gasta
 * tokens ni requiere migración. Si el catálogo crece, el upgrade natural es
 * una columna pgvector en `skills`.
 */
@Injectable()
export class SkillLibraryService {
  private readonly logger = new Logger(SkillLibraryService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Top-N skills del org relevantes al objetivo. [] si ninguna supera el umbral. */
  async findRelevant(orgId: string, goal: string, limit = 4): Promise<SkillSummary[]> {
    try {
      const { data, error } = await this.db.admin
        .from('skills')
        .select('slug, display_name, description')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error || !data) return [];

      const goalTokens = this.tokenize(goal);
      if (goalTokens.size === 0) return [];

      return (data as SkillSummary[])
        .map((skill) => ({
          skill,
          score: this.overlapScore(goalTokens, this.tokenize(`${skill.slug} ${skill.display_name} ${skill.description}`)),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ skill }) => skill);
    } catch (err) {
      this.logger.warn(`findRelevant failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Carga el código ejecutable de una skill (última versión registrada). */
  async getRunnable(orgId: string, slug: string): Promise<RunnableSkill | null> {
    try {
      const { data: skill, error } = await this.db.admin
        .from('skills')
        .select('id, slug, latest_version, metadata')
        .eq('org_id', orgId)
        .eq('slug', slug)
        .eq('status', 'active')
        .maybeSingle();
      if (error || !skill) return null;

      const { data: version, error: vError } = await this.db.admin
        .from('skill_versions')
        .select('instructions, manifest')
        .eq('org_id', orgId)
        .eq('skill_id', skill.id)
        .eq('version', skill.latest_version ?? '1.0.0')
        .maybeSingle();
      if (vError || !version?.instructions) return null;

      const manifest = (version.manifest ?? {}) as Record<string, unknown>;
      const metadata = (skill.metadata ?? {}) as Record<string, unknown>;
      const rawLanguage = String(manifest.language ?? metadata.language ?? 'python');
      const language: SandboxLanguage = rawLanguage === 'node' || rawLanguage === 'bash' ? rawLanguage : 'python';

      return {
        slug: skill.slug as string,
        language,
        code: version.instructions as string,
        filename: String(manifest.filename ?? `${slug}.${language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh'}`),
      };
    } catch (err) {
      this.logger.warn(`getRunnable(${slug}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
  }

  private overlapScore(goal: Set<string>, skill: Set<string>): number {
    let hits = 0;
    for (const token of goal) if (skill.has(token)) hits += 1;
    return hits;
  }
}
