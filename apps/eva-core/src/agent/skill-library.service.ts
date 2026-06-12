import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { SandboxLanguage } from './sandbox.service';
import { formatScanSummary, scanSkillCode, shouldBlockAgentSkill } from './skill-guard';

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

export interface RegisterSkillInput {
  slug?: string;
  displayName: string;
  description: string;
  language: SandboxLanguage;
  code: string;
  filename?: string;
  /** Procedencia (estilo hermes skill_provenance): quién escribió la skill. */
  origin: 'forge' | 'agent-loop' | 'agent-loop-auto';
  taskId?: string;
}

export type RegisterSkillResult =
  | { ok: true; slug: string; version: string }
  | { ok: false; reason: string };

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

  /**
   * Registro único de skills generadas por el agente (forge, loop o
   * sedimentación automática). Pasa por SkillGuard antes de tocar la base:
   * "dangerous" se bloquea; "caution" se registra con los findings en
   * metadata para revisión humana. Si el slug ya existe, se versiona
   * (1.0.0 → 1.0.1 → …) en vez de pisar la historia — el "patch it
   * immediately" de hermes sin perder lo anterior.
   */
  async register(orgId: string, input: RegisterSkillInput): Promise<RegisterSkillResult> {
    const scan = scanSkillCode(input.code, input.description);
    if (shouldBlockAgentSkill(scan)) {
      this.logger.warn(`skill blocked by guard (org ${orgId}): ${formatScanSummary(scan)}`);
      return { ok: false, reason: `SkillGuard bloqueó el registro: ${formatScanSummary(scan)}. Reintenta sin ese contenido.` };
    }

    const slug = this.slugify(input.slug ?? input.displayName);
    if (!slug) return { ok: false, reason: 'slug inválido' };
    const filename = input.filename ?? `${slug}.${input.language === 'python' ? 'py' : input.language === 'node' ? 'js' : 'sh'}`;
    const checksum = createHash('md5').update(input.code).digest('hex');

    try {
      const { data: existing } = await this.db.admin
        .from('skills')
        .select('id, latest_version')
        .eq('org_id', orgId)
        .eq('slug', slug)
        .maybeSingle();
      const version = existing ? this.bumpVersion(String(existing.latest_version ?? '1.0.0')) : '1.0.0';

      const { data: skill, error } = await this.db.admin
        .from('skills')
        .upsert({
          org_id: orgId,
          slug,
          display_name: input.displayName.slice(0, 120),
          description: input.description.slice(0, 500),
          status: 'active',
          latest_version: version,
          updated_at: new Date().toISOString(),
          metadata: {
            generated: true,
            language: input.language,
            origin: input.origin,
            guard_verdict: scan.verdict,
            ...(scan.findings.length > 0 ? { guard_findings: scan.findings.map((f) => f.pattern_id) } : {}),
          },
        }, { onConflict: 'org_id,slug' })
        .select()
        .single();
      if (error || !skill) return { ok: false, reason: error?.message ?? 'skill upsert failed' };

      const { error: vError } = await this.db.admin.from('skill_versions').upsert({
        org_id: orgId,
        skill_id: skill.id,
        version,
        manifest: { name: slug, version, generated: true, language: input.language, filename, origin: input.origin, task_id: input.taskId },
        instructions: input.code,
        checksum,
      }, { onConflict: 'org_id,skill_id,version' });
      if (vError) return { ok: false, reason: vError.message };

      this.logger.log(`skill "${slug}" v${version} registrada (origin=${input.origin}, verdict=${scan.verdict})`);
      return { ok: true, slug, version };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  private slugify(raw: string): string {
    return raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private bumpVersion(current: string): string {
    const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return '1.0.1';
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
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
