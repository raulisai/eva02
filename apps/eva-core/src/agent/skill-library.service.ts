import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BUNDLED_SKILL_CATALOG, BUNDLED_SKILL_BY_SLUG, BundledSkillCatalogEntry, SkillSource } from './bundled-skills.catalog';
import { DatabaseService } from '../database/database.service';
import { SandboxLanguage } from './sandbox.service';
import { formatScanSummary, scanSkillCode, shouldBlockAgentSkill } from './skill-guard';

export interface SkillSummary {
  slug: string;
  display_name: string;
  description: string;
  source?: SkillSource;
  category?: string;
  agentRole?: string;
  score?: number;
  maxConcurrency?: number;
  useMode?: 'prompt' | 'run';
  reason?: string;
  /** true = registrada automáticamente, aún no verificada con ≥2 éxitos reales. */
  isProvisional?: boolean;
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
  /**
   * Estado inicial de la skill.
   * - 'active': verificada y disponible (default para skill_save explícito).
   * - 'provisional': auto-sedimentada, penalizada en score hasta ≥2 éxitos.
   */
  status?: 'active' | 'provisional';
}

export type RegisterSkillResult =
  | { ok: true; slug: string; version: string }
  | { ok: false; reason: string };

export interface SkillOutcomeInput {
  taskId?: string;
  goal: string;
  selected: SkillSummary[];
  usedSlugs?: string[];
  toolsUsed?: string[];
  success: boolean;
  finalText?: string;
}

export interface SkillSelectionInput {
  goal: string;
  selected: SkillSummary[];
}

export type UserFeedbackReaction = 'positive' | 'negative' | 'neutral';

export interface UserFeedbackInput {
  taskId: string;
  userId: string;
  reaction?: UserFeedbackReaction;
  rating?: number;
  comment?: string;
}

export interface UserFeedbackResult {
  taskId: string;
  reward: number;
  appliedSkills: number;
}

interface SkillUsageStat {
  skill_slug: string;
  source: SkillSource;
  context_key: string;
  attempts: number;
  successes: number;
  failures: number;
  positive_feedback: number;
  negative_feedback: number;
  active_runs: number;
  avg_score: number | null;
}

interface SkillGraphEdge {
  from_skill_slug: string;
  to_skill_slug: string;
  relation: string;
  weight: number;
  evidence_count: number;
}

interface SkillSelectionEventRow {
  id: string;
  skill_slug: string;
  source: SkillSource;
  context_key: string;
  selected_score: number;
  outcome: 'success' | 'failure' | 'skipped';
  metadata: Record<string, unknown> | null;
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
 * Matching deliberadamente barato: texto + catálogo curado + métricas de
 * resultados + grafo de relaciones. Si el catálogo crece, el upgrade natural
 * sigue siendo pgvector, pero este índice aprende sin gastar tokens.
 */
@Injectable()
export class SkillLibraryService {
  private readonly logger = new Logger(SkillLibraryService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Top-N skills del org relevantes al objetivo. [] si ninguna supera el umbral. */
  async findRelevant(orgId: string, goal: string, limit = 4): Promise<SkillSummary[]> {
    try {
      const goalTokens = this.tokenize(goal);
      if (goalTokens.size === 0) return [];

      const [generated, stats, learnedEdges] = await Promise.all([
        this.loadGeneratedSkills(orgId),
        this.loadUsageStats(orgId),
        this.loadLearnedGraph(orgId),
      ]);
      const contextKey = this.contextKey(goalTokens);
      const candidates = [
        ...BUNDLED_SKILL_CATALOG.map((skill) => this.bundledToSummary(skill)),
        ...generated,
      ];

      const baseScores = new Map<string, number>();
      const scored = candidates
        .map((skill) => {
          const score = this.scoreSkill(skill, goal, goalTokens, contextKey, stats, learnedEdges, baseScores);
          return { skill: { ...skill, score }, score };
        })
        .filter(({ score }) => score > 0.2)
        .sort((a, b) => b.score - a.score || a.skill.slug.localeCompare(b.skill.slug))
        .slice(0, limit)
        .map(({ skill }) => skill);

      return scored;
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

      const initialStatus = input.status ?? 'active';
      const { data: skill, error } = await this.db.admin
        .from('skills')
        .upsert({
          org_id: orgId,
          slug,
          display_name: input.displayName.slice(0, 120),
          description: input.description.slice(0, 500),
          status: initialStatus,
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

      this.logger.log(`skill "${slug}" v${version} registrada (origin=${input.origin}, status=${initialStatus}, verdict=${scan.verdict})`);
      return { ok: true, slug, version };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async recordOutcome(orgId: string, input: SkillOutcomeInput): Promise<void> {
    if (input.selected.length === 0) return;
    const now = new Date().toISOString();
    const contextKey = this.contextKey(this.tokenize(input.goal));
    const used = new Set(input.usedSlugs ?? []);
    const selectedSlugs = input.selected.map((skill) => skill.slug);

    await Promise.all(input.selected.map(async (skill) => {
      const wasUsed = used.has(skill.slug) || skill.useMode === 'prompt';
      const success = input.success && wasUsed;
      const failure = !input.success && wasUsed;
      await this.incrementUsageStat(orgId, {
        skill,
        contextKey: '__global__',
        success,
        failure,
        attempted: wasUsed,
        score: skill.score ?? 0,
        now,
      });
      await this.incrementUsageStat(orgId, {
        skill,
        contextKey,
        success,
        failure,
        attempted: wasUsed,
        score: skill.score ?? 0,
        now,
      });
      await this.insertSelectionEvent(orgId, input, skill, success, failure, now);
      await this.adjustActiveRuns(orgId, skill, '__global__', -1, now);
      await this.adjustActiveRuns(orgId, skill, contextKey, -1, now);
    }));

    for (let i = 0; i < selectedSlugs.length; i += 1) {
      for (let j = i + 1; j < selectedSlugs.length; j += 1) {
        await this.reinforceGraphEdge(orgId, selectedSlugs[i], selectedSlugs[j], input.success ? 0.08 : -0.04, now);
        await this.reinforceGraphEdge(orgId, selectedSlugs[j], selectedSlugs[i], input.success ? 0.08 : -0.04, now);
      }
    }

    // C — Promotion: after recording outcome, check if any used provisional skill can be promoted.
    if (input.success && used.size > 0) {
      await Promise.all(
        [...used].map((slug) => this.maybePromoteProvisional(orgId, slug)),
      );
    }
  }

  async beginSelection(orgId: string, input: SkillSelectionInput): Promise<void> {
    if (input.selected.length === 0) return;
    const now = new Date().toISOString();
    const contextKey = this.contextKey(this.tokenize(input.goal));
    await Promise.all(input.selected.map(async (skill) => {
      await this.adjustActiveRuns(orgId, skill, '__global__', 1, now);
      await this.adjustActiveRuns(orgId, skill, contextKey, 1, now);
    }));
  }

  async recordUserFeedback(orgId: string, input: UserFeedbackInput): Promise<UserFeedbackResult> {
    const reward = this.feedbackReward(input);
    const now = new Date().toISOString();

    try {
      const { data, error } = await this.db.admin
        .from('skill_selection_events')
        .select('id, skill_slug, source, context_key, selected_score, outcome, metadata')
        .eq('org_id', orgId)
        .eq('task_id', input.taskId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error || !data) return { taskId: input.taskId, reward, appliedSkills: 0 };

      const rows = (data as SkillSelectionEventRow[]).filter((row) => row.outcome !== 'skipped');
      await Promise.all(rows.map(async (row) => {
        await this.applyFeedbackToStat(orgId, row, '__global__', reward, now);
        await this.applyFeedbackToStat(orgId, row, row.context_key, reward, now);
        await this.annotateSelectionFeedback(orgId, row, input, reward, now);
      }));

      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const delta = reward * 0.12;
          await this.reinforceGraphEdge(orgId, rows[i].skill_slug, rows[j].skill_slug, delta, now);
          await this.reinforceGraphEdge(orgId, rows[j].skill_slug, rows[i].skill_slug, delta, now);
        }
      }

      return { taskId: input.taskId, reward, appliedSkills: rows.length };
    } catch (err) {
      this.logger.debug(`user feedback skipped: ${(err as Error).message}`);
      return { taskId: input.taskId, reward, appliedSkills: 0 };
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

  private async loadGeneratedSkills(orgId: string): Promise<SkillSummary[]> {
    const { data, error } = await this.db.admin
      .from('skills')
      .select('slug, display_name, description, status, metadata')
      .eq('org_id', orgId)
      .in('status', ['active', 'provisional'])
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error || !data) return [];

    return (data as Array<SkillSummary & { status?: string; metadata?: Record<string, unknown> }>)
      .map((skill) => ({
        slug: skill.slug,
        display_name: skill.display_name,
        description: skill.description ?? '',
        source: 'generated' as const,
        category: String(skill.metadata?.category ?? 'generated'),
        agentRole: String(skill.metadata?.agent_role ?? 'automation specialist'),
        maxConcurrency: Number(skill.metadata?.max_concurrency ?? 1),
        useMode: 'run' as const,
        isProvisional: skill.status === 'provisional',
      }));
  }

  private bundledToSummary(skill: BundledSkillCatalogEntry): SkillSummary {
    return {
      slug: skill.slug,
      display_name: skill.displayName,
      description: skill.description,
      source: 'bundled',
      category: skill.category,
      agentRole: skill.agentRole,
      maxConcurrency: skill.maxConcurrency,
      useMode: 'prompt',
    };
  }

  private async loadUsageStats(orgId: string): Promise<Map<string, SkillUsageStat>> {
    try {
      const { data, error } = await this.db.admin
        .from('skill_usage_stats')
        .select('skill_slug, source, context_key, attempts, successes, failures, positive_feedback, negative_feedback, active_runs, avg_score')
        .eq('org_id', orgId)
        .limit(500);
      if (error || !data) return new Map();
      return new Map((data as SkillUsageStat[]).map((row) => [this.statKey(row.skill_slug, row.source, row.context_key), row]));
    } catch {
      return new Map();
    }
  }

  private async loadLearnedGraph(orgId: string): Promise<SkillGraphEdge[]> {
    try {
      const { data, error } = await this.db.admin
        .from('skill_graph_edges')
        .select('from_skill_slug, to_skill_slug, relation, weight, evidence_count')
        .eq('org_id', orgId)
        .limit(500);
      if (error || !data) return [];
      return data as SkillGraphEdge[];
    } catch {
      return [];
    }
  }

  private scoreSkill(
    skill: SkillSummary,
    goal: string,
    goalTokens: Set<string>,
    contextKey: string,
    stats: Map<string, SkillUsageStat>,
    learnedEdges: SkillGraphEdge[],
    baseScores: Map<string, number>,
  ): number {
    const bundled = BUNDLED_SKILL_BY_SLUG.get(skill.slug);
    const source = skill.source ?? 'generated';
    const textTokens = this.tokenize(`${skill.slug} ${skill.display_name} ${skill.description} ${bundled?.triggers.join(' ') ?? ''}`);
    const overlap = this.overlapScore(goalTokens, textTokens);
    const global = stats.get(this.statKey(skill.slug, source, '__global__'));
    const context = stats.get(this.statKey(skill.slug, source, contextKey));
    let score = overlap;

    if (bundled) {
      score += this.phraseHits(goal, bundled.triggers) * 1.25;
      score += this.staticGraphBoost(goalTokens, bundled);
      score -= this.phraseHits(goal, bundled.negativeTriggers ?? []) * 1.75;
      if (score <= 0 && !global?.attempts && !context?.attempts) {
        baseScores.set(skill.slug, 0);
        return 0;
      }
      score += bundled.baseWeight;
    } else {
      if (score <= 0 && !global?.attempts && !context?.attempts) {
        baseScores.set(skill.slug, 0);
        return 0;
      }
      score += 0.75;
    }

    baseScores.set(skill.slug, score);

    score += this.statsBoost(global) * 0.75;
    score += this.statsBoost(context) * 1.25;

    const activeRuns = Math.max(global?.active_runs ?? 0, context?.active_runs ?? 0);
    const maxConcurrency = skill.maxConcurrency ?? bundled?.maxConcurrency ?? 1;
    if (activeRuns >= maxConcurrency) score -= 2.5 + activeRuns;

    score += this.learnedGraphBoost(skill.slug, learnedEdges, baseScores);

    // C — Skill quarantine: provisional skills ranked lower until promoted.
    if (skill.isProvisional) score -= 1.5;

    skill.reason = this.reasonFor(skill, score, global, context);
    return score;
  }

  /**
   * Promueve una skill provisional a 'active' cuando acumula ≥2 éxitos en
   * skill_usage_stats. Llamado desde recordOutcome tras cada resultado exitoso.
   */
  private async maybePromoteProvisional(orgId: string, skillSlug: string): Promise<void> {
    try {
      const { data: skill } = await this.db.admin
        .from('skills')
        .select('id, status')
        .eq('org_id', orgId)
        .eq('slug', skillSlug)
        .eq('status', 'provisional')
        .maybeSingle();
      if (!skill) return;

      const { data: stat } = await this.db.admin
        .from('skill_usage_stats')
        .select('successes')
        .eq('org_id', orgId)
        .eq('skill_slug', skillSlug)
        .eq('context_key', '__global__')
        .maybeSingle();

      const successes = Number((stat as { successes?: number } | null)?.successes ?? 0);
      if (successes >= 2) {
        await this.db.admin
          .from('skills')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('org_id', orgId)
          .eq('id', skill.id);
        this.logger.log(`skill "${skillSlug}" promovida de provisional a active (${successes} éxitos)`);
      }
    } catch (err) {
      this.logger.debug(`maybePromoteProvisional skipped: ${(err as Error).message}`);
    }
  }

  private phraseHits(goal: string, phrases: string[]): number {
    const normalized = goal.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return phrases.filter((phrase) => normalized.includes(phrase.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))).length;
  }

  private staticGraphBoost(goalTokens: Set<string>, skill: BundledSkillCatalogEntry): number {
    let boost = 0;
    for (const edge of skill.graph) {
      const neighbor = BUNDLED_SKILL_BY_SLUG.get(edge.to);
      if (!neighbor) continue;
      const neighborTokens = this.tokenize(`${neighbor.slug} ${neighbor.description} ${neighbor.triggers.join(' ')}`);
      if (this.overlapScore(goalTokens, neighborTokens) > 0) boost += edge.weight;
    }
    return boost;
  }

  private learnedGraphBoost(slug: string, edges: SkillGraphEdge[], baseScores: Map<string, number>): number {
    return edges
      .filter((edge) => edge.to_skill_slug === slug)
      .reduce((sum, edge) => sum + Math.max(0, edge.weight) * Math.min(2, Math.max(0, baseScores.get(edge.from_skill_slug) ?? 0) / 3), 0);
  }

  private statsBoost(stat?: SkillUsageStat): number {
    if (!stat || stat.attempts === 0) return 0;
    const successRate = stat.successes / stat.attempts;
    const failureRate = stat.failures / stat.attempts;
    const feedback = (stat.positive_feedback - stat.negative_feedback) / Math.max(1, stat.attempts);
    return successRate * 2.5 - failureRate * 2 + feedback;
  }

  private reasonFor(skill: SkillSummary, score: number, global?: SkillUsageStat, context?: SkillUsageStat): string {
    const parts = [`score=${score.toFixed(2)}`];
    if (skill.source) parts.push(skill.source);
    if (skill.agentRole) parts.push(`role=${skill.agentRole}`);
    if (context?.attempts) parts.push(`context ${context.successes}/${context.attempts} ok`);
    else if (global?.attempts) parts.push(`global ${global.successes}/${global.attempts} ok`);
    return parts.join(', ');
  }

  private contextKey(tokens: Set<string>): string {
    return [...tokens].sort().slice(0, 6).join(':') || '__global__';
  }

  private statKey(slug: string, source: SkillSource, contextKey: string): string {
    return `${source}:${slug}:${contextKey}`;
  }

  private async incrementUsageStat(
    orgId: string,
    input: {
      skill: SkillSummary;
      contextKey: string;
      attempted: boolean;
      success: boolean;
      failure: boolean;
      score: number;
      now: string;
    },
  ): Promise<void> {
    try {
      const source = input.skill.source ?? 'generated';
      const { data } = await this.db.admin
        .from('skill_usage_stats')
        .select('attempts, successes, failures, positive_feedback, negative_feedback, avg_score')
        .eq('org_id', orgId)
        .eq('source', source)
        .eq('skill_slug', input.skill.slug)
        .eq('context_key', input.contextKey)
        .maybeSingle();
      const current = (data ?? {}) as Partial<SkillUsageStat>;
      const attempts = Number(current.attempts ?? 0) + (input.attempted ? 1 : 0);
      const successes = Number(current.successes ?? 0) + (input.success ? 1 : 0);
      const failures = Number(current.failures ?? 0) + (input.failure ? 1 : 0);
      const priorAvg = Number(current.avg_score ?? 0);
      const avgScore = attempts > 0 ? ((priorAvg * Math.max(0, attempts - 1)) + input.score) / attempts : input.score;

      await this.db.admin.from('skill_usage_stats').upsert({
        org_id: orgId,
        source,
        skill_slug: input.skill.slug,
        context_key: input.contextKey,
        attempts,
        successes,
        failures,
        positive_feedback: Number(current.positive_feedback ?? 0) + (input.success ? 1 : 0),
        negative_feedback: Number(current.negative_feedback ?? 0) + (input.failure ? 1 : 0),
        active_runs: Math.max(0, Number(current.active_runs ?? 0)),
        avg_score: avgScore,
        last_used_at: input.now,
        updated_at: input.now,
      }, { onConflict: 'org_id,source,skill_slug,context_key' });
    } catch (err) {
      this.logger.debug(`skill usage stat skipped: ${(err as Error).message}`);
    }
  }

  private async adjustActiveRuns(orgId: string, skill: SkillSummary, contextKey: string, delta: number, now: string): Promise<void> {
    try {
      const source = skill.source ?? 'generated';
      const { data } = await this.db.admin
        .from('skill_usage_stats')
        .select('attempts, successes, failures, positive_feedback, negative_feedback, active_runs, avg_score')
        .eq('org_id', orgId)
        .eq('source', source)
        .eq('skill_slug', skill.slug)
        .eq('context_key', contextKey)
        .maybeSingle();
      const current = (data ?? {}) as Partial<SkillUsageStat>;
      await this.db.admin.from('skill_usage_stats').upsert({
        org_id: orgId,
        source,
        skill_slug: skill.slug,
        context_key: contextKey,
        attempts: Number(current.attempts ?? 0),
        successes: Number(current.successes ?? 0),
        failures: Number(current.failures ?? 0),
        positive_feedback: Number(current.positive_feedback ?? 0),
        negative_feedback: Number(current.negative_feedback ?? 0),
        active_runs: Math.max(0, Number(current.active_runs ?? 0) + delta),
        avg_score: current.avg_score ?? null,
        updated_at: now,
      }, { onConflict: 'org_id,source,skill_slug,context_key' });
    } catch (err) {
      this.logger.debug(`skill active_runs skipped: ${(err as Error).message}`);
    }
  }

  private async insertSelectionEvent(
    orgId: string,
    input: SkillOutcomeInput,
    skill: SkillSummary,
    success: boolean,
    failure: boolean,
    now: string,
  ): Promise<void> {
    try {
      await this.db.admin.from('skill_selection_events').insert({
        org_id: orgId,
        task_id: input.taskId,
        skill_slug: skill.slug,
        source: skill.source ?? 'generated',
        context_key: this.contextKey(this.tokenize(input.goal)),
        selected_score: skill.score ?? 0,
        outcome: success ? 'success' : failure ? 'failure' : 'skipped',
        tools_used: input.toolsUsed ?? [],
        metadata: {
          role: skill.agentRole,
          category: skill.category,
          reason: skill.reason,
          final_text_len: input.finalText?.length ?? 0,
        },
        created_at: now,
      });
    } catch (err) {
      this.logger.debug(`skill selection event skipped: ${(err as Error).message}`);
    }
  }

  private async reinforceGraphEdge(orgId: string, from: string, to: string, delta: number, now: string): Promise<void> {
    try {
      const { data } = await this.db.admin
        .from('skill_graph_edges')
        .select('weight, evidence_count')
        .eq('org_id', orgId)
        .eq('from_skill_slug', from)
        .eq('to_skill_slug', to)
        .eq('relation', 'co_selected')
        .maybeSingle();
      const current = (data ?? {}) as Partial<SkillGraphEdge>;
      const nextWeight = Math.max(-2, Math.min(4, Number(current.weight ?? 0) + delta));
      await this.db.admin.from('skill_graph_edges').upsert({
        org_id: orgId,
        from_skill_slug: from,
        to_skill_slug: to,
        relation: 'co_selected',
        weight: nextWeight,
        evidence_count: Number(current.evidence_count ?? 0) + 1,
        last_reinforced_at: now,
        updated_at: now,
      }, { onConflict: 'org_id,from_skill_slug,to_skill_slug,relation' });
    } catch (err) {
      this.logger.debug(`skill graph edge skipped: ${(err as Error).message}`);
    }
  }

  private feedbackReward(input: UserFeedbackInput): number {
    if (typeof input.rating === 'number') {
      return Math.max(-1, Math.min(1, (input.rating - 3) / 2));
    }
    if (input.reaction === 'positive') return 1;
    if (input.reaction === 'negative') return -1;
    return 0;
  }

  private async applyFeedbackToStat(
    orgId: string,
    event: SkillSelectionEventRow,
    contextKey: string,
    reward: number,
    now: string,
  ): Promise<void> {
    try {
      const { data } = await this.db.admin
        .from('skill_usage_stats')
        .select('attempts, successes, failures, positive_feedback, negative_feedback, active_runs, avg_score')
        .eq('org_id', orgId)
        .eq('source', event.source)
        .eq('skill_slug', event.skill_slug)
        .eq('context_key', contextKey)
        .maybeSingle();
      const current = (data ?? {}) as Partial<SkillUsageStat>;
      const attempts = Number(current.attempts ?? 0);
      const priorAvg = Number(current.avg_score ?? event.selected_score ?? 0);
      const avgScore = attempts > 0
        ? (priorAvg * 0.85) + ((event.selected_score ?? 0) + reward) * 0.15
        : (event.selected_score ?? 0) + reward;

      await this.db.admin.from('skill_usage_stats').upsert({
        org_id: orgId,
        source: event.source,
        skill_slug: event.skill_slug,
        context_key: contextKey,
        attempts,
        successes: Number(current.successes ?? 0),
        failures: Number(current.failures ?? 0),
        positive_feedback: Number(current.positive_feedback ?? 0) + (reward > 0 ? 1 : 0),
        negative_feedback: Number(current.negative_feedback ?? 0) + (reward < 0 ? 1 : 0),
        active_runs: Math.max(0, Number(current.active_runs ?? 0)),
        avg_score: avgScore,
        last_used_at: now,
        updated_at: now,
      }, { onConflict: 'org_id,source,skill_slug,context_key' });
    } catch (err) {
      this.logger.debug(`skill feedback stat skipped: ${(err as Error).message}`);
    }
  }

  private async annotateSelectionFeedback(
    orgId: string,
    event: SkillSelectionEventRow,
    input: UserFeedbackInput,
    reward: number,
    now: string,
  ): Promise<void> {
    try {
      const feedback = {
        user_id: input.userId,
        reaction: input.reaction ?? null,
        rating: input.rating ?? null,
        reward,
        comment: input.comment?.slice(0, 500) ?? null,
        recorded_at: now,
      };
      await this.db.admin
        .from('skill_selection_events')
        .update({
          metadata: {
            ...(event.metadata ?? {}),
            user_feedback: feedback,
          },
        })
        .eq('org_id', orgId)
        .eq('id', event.id);
    } catch (err) {
      this.logger.debug(`skill feedback annotation skipped: ${(err as Error).message}`);
    }
  }
}
