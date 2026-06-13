import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Subdirectories allowed for skill support files — mirrors Hermes layout:
 *   references/ — API docs, research excerpts, domain notes
 *   templates/  — boilerplate files meant to be copied and modified
 *   scripts/    — re-runnable verification/probe scripts
 *   assets/     — supplementary files (images, data, etc.)
 */
export const ALLOWED_SKILL_SUBDIRS = ['references', 'templates', 'scripts', 'assets'] as const;
export type SkillSubdir = typeof ALLOWED_SKILL_SUBDIRS[number];

export interface SkillDocEntry {
  slug: string;
  display_name: string;
  description: string;
  category: string | null;
  kind: 'code' | 'doc';
  is_pinned: boolean;
  source: 'bundled' | 'generated';
}

export interface SkillDocDetail extends SkillDocEntry {
  content_md: string | null;
  files: Array<{ subdir: string; filename: string; path: string }>;
  /** Neighbors from the skill graph (skill_graph_edges) — supports/precedes/etc. */
  related_skills: Array<{ slug: string; relation: string; weight: number }>;
}

export interface CreateSkillDocInput {
  slug: string;
  displayName: string;
  description: string;
  category?: string;
  contentMd: string;
  origin?: 'agent-loop' | 'background-review' | 'user';
}

export interface PatchSkillDocInput {
  slug: string;
  find: string;
  replace: string;
  /** If provided, patch a support file instead of SKILL.md */
  filePath?: string;
}

export interface WriteSkillFileInput {
  slug: string;
  subdir: SkillSubdir;
  filename: string;
  content: string;
}

export type SkillManageResult =
  | { ok: true; slug: string; action: string; message: string }
  | { ok: false; error: string };

const MAX_CONTENT_CHARS = 60_000;
const MAX_FILE_BYTES = 512_000;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Below this many skills the index expands every category (no token pressure). */
const EXPAND_ALL_THRESHOLD = 15;

/**
 * SkillDocsService — procedural memory for EVA agents.
 *
 * Skills are Markdown runbooks (SKILL.md) that the agent reads via
 * skill_view() and writes via skill_manage(). They encode HOW to do
 * a class of task — complements declarative memory (facts about the user).
 *
 * The agent-loop injects a compact index of all skills into EVERY system
 * prompt (mandatory tier), so the model always knows what procedural
 * knowledge exists before it decides anything.
 *
 * Architecture mirrors Hermes Agent's skill system:
 *   tools/skills_tool.py      → getSkillIndex() / viewSkill() / viewSkillFile()
 *   tools/skill_manager_tool.py → createSkill() / patchSkill() / editSkill() / writeSkillFile()
 *   agent/prompt_builder.py   → getSkillIndexBlock() (used by AgentLoopService)
 */
@Injectable()
export class SkillDocsService {
  private readonly logger = new Logger(SkillDocsService.name);

  constructor(private readonly db: DatabaseService) {}

  // ── Index (compact — for system prompt injection) ─────────────────────────

  /**
   * Returns a compact index of all skills for an org, grouped by category.
   * This is injected into every agent-loop system prompt as a mandatory block.
   *
   * Format mirrors Hermes' ## Skills (mandatory) block:
   *   category:
   *     - slug: description
   *
   * Token control (Hermes parity — prompt_builder._build_skills_system_prompt):
   * cuando la biblioteca supera EXPAND_ALL_THRESHOLD skills, las categorías que
   * NO son relevantes al goal se degradan a "solo nombres" (se omiten las
   * descripciones para recortar tokens) pero NUNCA se ocultan — todo nombre
   * sigue visible para que el recall anclado en memoria ("carga <slug>") funcione.
   * Las skills pinned siempre se expanden.
   */
  async getSkillIndexBlock(orgId: string, opts?: { goal?: string }): Promise<string> {
    const skills = await this.getSkillIndex(orgId);
    if (skills.length === 0) return '';

    const byCategory = new Map<string, SkillDocEntry[]>();
    for (const skill of skills) {
      const cat = skill.category ?? 'general';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(skill);
    }

    // Decide which categories stay expanded. Below the threshold, expand all.
    // Above it, expand only categories relevant to the goal (keyword overlap),
    // any category that holds a pinned skill, OR one with a recently-used skill
    // (rank by real usage, not just goal keywords — skill_usage_stats).
    const goalTokens = this.tokenize(opts?.goal ?? '');
    const expandAll = skills.length <= EXPAND_ALL_THRESHOLD || goalTokens.size === 0;
    const expanded = new Set<string>();
    if (!expandAll) {
      const recentSlugs = await this.recentlyUsedSlugs(orgId);
      for (const [cat, entries] of byCategory) {
        const hasPinned = entries.some((e) => e.is_pinned);
        const hasRecent = entries.some((e) => recentSlugs.has(e.slug));
        const catTokens = this.tokenize(
          `${cat} ${entries.map((e) => `${e.slug} ${e.description}`).join(' ')}`,
        );
        let overlap = 0;
        for (const t of goalTokens) if (catTokens.has(t)) overlap++;
        if (hasPinned || hasRecent || overlap > 0) expanded.add(cat);
      }
    }

    const lines: string[] = [];
    let demotedCount = 0;
    for (const [category, entries] of [...byCategory.entries()].sort()) {
      const sorted = entries.sort((a, b) => a.slug.localeCompare(b.slug));
      if (!expandAll && !expanded.has(category)) {
        // Names-only demotion: keep slugs, drop descriptions.
        demotedCount += sorted.length;
        lines.push(`  ${category} [solo nombres]: ${sorted.map((s) => s.slug).join(', ')}`);
        continue;
      }
      lines.push(`  ${category}:`);
      for (const s of sorted) {
        const pin = s.is_pinned ? ' [pinned]' : '';
        const src = s.source === 'bundled' ? ' [bundled]' : '';
        lines.push(`    - ${s.slug}${pin}${src}: ${s.description.slice(0, 120)}`);
      }
    }

    const demotedNote = demotedCount > 0
      ? '\n(Las categorías marcadas [solo nombres] están fuera del contexto actual, así que se omiten sus descripciones — las skills funcionan igual y se cargan con skill_view(slug) como siempre.)'
      : '';

    return (
      '## Skills (memoria procedimental — obligatorio)\n' +
      'Antes de responder, revisa las skills de abajo. Si alguna coincide o es relevante ' +
      'a tu tarea, DEBES cargarla con skill_view(slug) y seguir sus instrucciones. ' +
      'Es mejor cargar contexto que no necesitas que saltarte pasos críticos o workflows establecidos. ' +
      'Las skills codifican el enfoque preferido del usuario, convenciones y estándares de calidad — ' +
      'cárgalas incluso para tareas que ya sabes hacer, porque la skill define CÓMO hacerlo aquí.\n' +
      'Si una skill que cargaste está desactualizada o le faltan pasos, corrígela con skill_manage(action="patch") antes de terminar.\n' +
      'Después de tareas complejas (5+ pasos de herramientas) o fixes difíciles, guarda el enfoque como skill con skill_manage(action="create").\n\n' +
      '<available_skills>\n' +
      lines.join('\n') + '\n' +
      '</available_skills>\n\n' +
      'Solo procede sin cargar una skill si genuinamente ninguna es relevante.' +
      demotedNote
    );
  }

  /** Lowercase word tokens ≥3 chars — used for goal↔category relevance scoring. */
  private tokenize(text: string): Set<string> {
    return new Set(
      (text.toLowerCase().match(/[a-záéíóúñ0-9]+/g) ?? []).filter((t) => t.length >= 3),
    );
  }

  /**
   * Top skill-graph neighbors of *slug*, ordered by edge weight.
   * Reads skill_graph_edges (populated by SkillLibraryService outcome logging),
   * so viewing a skill can point the agent at related ones.
   */
  private async fetchRelatedSkills(
    orgId: string,
    slug: string,
    limit = 5,
  ): Promise<Array<{ slug: string; relation: string; weight: number }>> {
    try {
      const { data } = await this.db.admin
        .from('skill_graph_edges')
        .select('to_skill_slug, relation, weight')
        .eq('org_id', orgId)
        .eq('from_skill_slug', slug)
        .order('weight', { ascending: false })
        .limit(limit);

      return ((data ?? []) as Array<{ to_skill_slug: string; relation: string; weight: number }>)
        .filter((e) => e.to_skill_slug && e.to_skill_slug !== slug && (e.weight ?? 0) > 0)
        .map((e) => ({ slug: e.to_skill_slug, relation: e.relation, weight: Number(e.weight) || 0 }));
    } catch {
      return [];
    }
  }

  /**
   * Record a usage bump when the agent loads a skill (skill_view). Feeds
   * skill_usage_stats so the index demotion can rank by real usage, not just
   * goal keyword overlap. Best-effort; bundled and doc skills both tracked.
   */
  async recordSkillView(orgId: string, slug: string, source: 'bundled' | 'generated'): Promise<void> {
    try {
      const now = new Date().toISOString();
      const { data } = await this.db.admin
        .from('skill_usage_stats')
        .select('attempts')
        .eq('org_id', orgId)
        .eq('source', source)
        .eq('skill_slug', slug)
        .eq('context_key', '__global__')
        .maybeSingle();
      const attempts = Number((data as { attempts?: number } | null)?.attempts ?? 0) + 1;
      await this.db.admin.from('skill_usage_stats').upsert({
        org_id: orgId,
        source,
        skill_slug: slug,
        context_key: '__global__',
        attempts,
        last_used_at: now,
        updated_at: now,
      }, { onConflict: 'org_id,source,skill_slug,context_key' });
    } catch (err) {
      this.logger.debug(`recordSkillView(${slug}) skipped: ${(err as Error).message}`);
    }
  }

  /** Slugs viewed/used within the last `sinceDays` — drives index expansion. */
  private async recentlyUsedSlugs(orgId: string, sinceDays = 14, limit = 40): Promise<Set<string>> {
    try {
      const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      const { data } = await this.db.admin
        .from('skill_usage_stats')
        .select('skill_slug')
        .eq('org_id', orgId)
        .gte('last_used_at', since)
        .order('last_used_at', { ascending: false })
        .limit(limit);
      return new Set(((data ?? []) as Array<{ skill_slug: string }>).map((r) => r.skill_slug));
    } catch {
      return new Set();
    }
  }

  /**
   * Substitute ${EVA_SKILL_DIR} / ${EVA_TASK_ID} tokens in skill content.
   * Mirrors Hermes' skill_preprocessing.substitute_template_vars — only tokens
   * with a concrete value are replaced; unresolved ones are left as-is so the
   * author can spot them. Inline-shell (`!\`cmd\``) is expanded separately by the
   * agent-loop through the sandbox, since that requires execution context.
   */
  substituteTemplateVars(
    content: string | null,
    vars: { skillDir?: string; taskId?: string },
  ): string | null {
    if (!content) return content;
    return content.replace(/\$\{(EVA_SKILL_DIR|EVA_TASK_ID)\}/g, (match, token) => {
      if (token === 'EVA_SKILL_DIR' && vars.skillDir) return vars.skillDir;
      if (token === 'EVA_TASK_ID' && vars.taskId) return vars.taskId;
      return match;
    });
  }

  async getSkillIndex(orgId: string): Promise<SkillDocEntry[]> {
    try {
      const { data, error } = await this.db.admin
        .from('skills')
        .select('slug, display_name, description, category, kind, is_pinned, metadata')
        .eq('org_id', orgId)
        .in('status', ['active', 'provisional'])
        .order('category', { ascending: true, nullsFirst: false })
        .order('slug', { ascending: true })
        .limit(200);

      if (error || !data) return [];

      return (data as Array<{
        slug: string; display_name: string; description: string;
        category: string | null; kind: string; is_pinned: boolean;
        metadata: Record<string, unknown> | null;
      }>).map((row) => ({
        slug: row.slug,
        display_name: row.display_name,
        description: row.description ?? '',
        category: row.category ?? null,
        kind: (row.kind ?? 'code') as 'code' | 'doc',
        is_pinned: row.is_pinned ?? false,
        source: (row.metadata?.generated === false ? 'bundled' : 'generated') as 'bundled' | 'generated',
      }));
    } catch (err) {
      this.logger.warn(`getSkillIndex failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── View (progressive disclosure) ─────────────────────────────────────────

  /**
   * Returns full SKILL.md content + list of support files.
   * Progressive disclosure tier 2 — called when agent decides a skill is relevant.
   */
  async viewSkill(orgId: string, slug: string, opts?: { taskId?: string }): Promise<SkillDocDetail | null> {
    try {
      const { data: skill, error } = await this.db.admin
        .from('skills')
        .select('id, slug, display_name, description, category, kind, is_pinned, content_md, metadata, latest_version')
        .eq('org_id', orgId)
        .eq('slug', slug)
        .in('status', ['active', 'provisional'])
        .maybeSingle();

      if (error || !skill) return null;

      const row = skill as {
        slug: string; display_name: string; description: string;
        category: string | null; kind: string; is_pinned: boolean;
        content_md: string | null; metadata: Record<string, unknown> | null;
        latest_version: string | null;
      };

      // If it's a code skill with no content_md, fall back to instructions from skill_versions
      let contentMd = row.content_md;
      if (!contentMd && row.kind === 'code') {
        const { data: version } = await this.db.admin
          .from('skill_versions')
          .select('instructions, manifest')
          .eq('org_id', orgId)
          .eq('skill_id', (skill as { id?: string }).id ?? '')
          .eq('version', row.latest_version ?? '1.0.0')
          .maybeSingle();
        if (version?.instructions) {
          const manifest = (version.manifest ?? {}) as Record<string, unknown>;
          const lang = String(manifest.language ?? 'python');
          contentMd = `\`\`\`${lang}\n${version.instructions}\n\`\`\``;
        }
      }

      const { data: files } = await this.db.admin
        .from('skill_files')
        .select('subdir, filename')
        .eq('org_id', orgId)
        .eq('skill_id', (skill as { id?: string }).id ?? '')
        .order('subdir', { ascending: true })
        .order('filename', { ascending: true });

      const fileList = ((files ?? []) as Array<{ subdir: string; filename: string }>).map((f) => ({
        subdir: f.subdir,
        filename: f.filename,
        path: `${f.subdir}/${f.filename}`,
      }));

      // Skill-graph neighbors: surface related skills so loading one suggests
      // the others that historically co-occur or support it (Hermes parity:
      // skills_tool related_skills, backed here by skill_graph_edges).
      const related = await this.fetchRelatedSkills(orgId, row.slug);

      // Template-var substitution (Hermes skill_preprocessing.substitute_template_vars).
      const renderedContent = this.substituteTemplateVars(contentMd ?? null, {
        skillDir: `skill://${row.slug}`,
        taskId: opts?.taskId,
      });

      return {
        slug: row.slug,
        display_name: row.display_name,
        description: row.description ?? '',
        category: row.category ?? null,
        kind: (row.kind ?? 'code') as 'code' | 'doc',
        is_pinned: row.is_pinned ?? false,
        source: (row.metadata?.generated === false ? 'bundled' : 'generated') as 'bundled' | 'generated',
        content_md: renderedContent,
        files: fileList,
        related_skills: related,
      };
    } catch (err) {
      this.logger.warn(`viewSkill(${slug}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Returns content of a specific support file — tier 3 progressive disclosure.
   * Called as skill_view(slug, file_path="references/api.md").
   */
  async viewSkillFile(orgId: string, slug: string, filePath: string): Promise<string | null> {
    try {
      const parts = filePath.split('/');
      if (parts.length !== 2) return null;
      const [subdir, filename] = parts;
      if (!ALLOWED_SKILL_SUBDIRS.includes(subdir as SkillSubdir)) return null;

      const { data: skill } = await this.db.admin
        .from('skills')
        .select('id')
        .eq('org_id', orgId)
        .eq('slug', slug)
        .maybeSingle();
      if (!skill) return null;

      const { data: file } = await this.db.admin
        .from('skill_files')
        .select('content')
        .eq('org_id', orgId)
        .eq('skill_id', (skill as { id: string }).id)
        .eq('subdir', subdir)
        .eq('filename', filename)
        .maybeSingle();

      return (file as { content?: string } | null)?.content ?? null;
    } catch (err) {
      this.logger.warn(`viewSkillFile(${slug}, ${filePath}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Manage (create / patch / edit / write_file / delete) ──────────────────

  async createSkill(orgId: string, input: CreateSkillDocInput): Promise<SkillManageResult> {
    const slugError = this.validateSlug(input.slug);
    if (slugError) return { ok: false, error: slugError };

    const contentError = this.validateContent(input.contentMd);
    if (contentError) return { ok: false, error: contentError };

    try {
      // Check if slug already exists
      const { data: existing } = await this.db.admin
        .from('skills')
        .select('id, slug')
        .eq('org_id', orgId)
        .eq('slug', input.slug)
        .maybeSingle();

      if (existing) {
        return { ok: false, error: `Skill '${input.slug}' ya existe. Usa action='edit' para reescribirla o action='patch' para modificarla.` };
      }

      const { error } = await this.db.admin.from('skills').insert({
        org_id: orgId,
        slug: input.slug,
        display_name: input.displayName.slice(0, 120),
        description: input.description.slice(0, 500),
        category: input.category?.slice(0, 60) ?? null,
        status: 'active',
        kind: 'doc',
        content_md: input.contentMd,
        latest_version: '1.0.0',
        is_pinned: false,
        metadata: {
          generated: true,
          origin: input.origin ?? 'agent-loop',
          created_at: new Date().toISOString(),
        },
      });

      if (error) return { ok: false, error: error.message };

      this.logger.log(`skill doc "${input.slug}" created (org=${orgId}, origin=${input.origin})`);
      return { ok: true, slug: input.slug, action: 'create', message: `Skill '${input.slug}' creada exitosamente.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async editSkill(orgId: string, slug: string, contentMd: string): Promise<SkillManageResult> {
    const contentError = this.validateContent(contentMd);
    if (contentError) return { ok: false, error: contentError };

    const guard = await this.checkEditAllowed(orgId, slug);
    if (guard) return { ok: false, error: guard };

    try {
      const { error } = await this.db.admin
        .from('skills')
        .update({ content_md: contentMd, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('slug', slug);

      if (error) return { ok: false, error: error.message };
      this.logger.log(`skill doc "${slug}" edited (org=${orgId})`);
      return { ok: true, slug, action: 'edit', message: `Skill '${slug}' reescrita exitosamente.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async patchSkill(orgId: string, input: PatchSkillDocInput): Promise<SkillManageResult> {
    const guard = await this.checkEditAllowed(orgId, input.slug);
    if (guard) return { ok: false, error: guard };

    try {
      if (input.filePath) {
        return this.patchSkillFile(orgId, input.slug, input.filePath, input.find, input.replace);
      }

      const { data: skill } = await this.db.admin
        .from('skills')
        .select('content_md')
        .eq('org_id', orgId)
        .eq('slug', input.slug)
        .maybeSingle();

      const current = (skill as { content_md?: string } | null)?.content_md ?? '';
      if (!current.includes(input.find)) {
        return { ok: false, error: `Texto '${input.find.slice(0, 60)}...' no encontrado en SKILL.md de '${input.slug}'.` };
      }

      const patched = current.replace(input.find, input.replace);
      const { error } = await this.db.admin
        .from('skills')
        .update({ content_md: patched, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('slug', input.slug);

      if (error) return { ok: false, error: error.message };
      this.logger.log(`skill doc "${input.slug}" patched (org=${orgId})`);
      return { ok: true, slug: input.slug, action: 'patch', message: `Skill '${input.slug}' parcheada exitosamente.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async writeSkillFile(orgId: string, input: WriteSkillFileInput): Promise<SkillManageResult> {
    if (!ALLOWED_SKILL_SUBDIRS.includes(input.subdir)) {
      return { ok: false, error: `Subdirectorio '${input.subdir}' no permitido. Usa: ${ALLOWED_SKILL_SUBDIRS.join(', ')}` };
    }
    if (Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES) {
      return { ok: false, error: `Archivo excede límite de ${MAX_FILE_BYTES / 1024}KB.` };
    }

    try {
      const { data: skill } = await this.db.admin
        .from('skills')
        .select('id')
        .eq('org_id', orgId)
        .eq('slug', input.slug)
        .maybeSingle();

      if (!skill) return { ok: false, error: `Skill '${input.slug}' no encontrada. Créala primero con action='create'.` };

      const { error } = await this.db.admin.from('skill_files').upsert({
        org_id: orgId,
        skill_id: (skill as { id: string }).id,
        subdir: input.subdir,
        filename: input.filename,
        content: input.content,
        size_bytes: Buffer.byteLength(input.content, 'utf8'),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,skill_id,subdir,filename' });

      if (error) return { ok: false, error: error.message };
      const path = `${input.subdir}/${input.filename}`;
      this.logger.log(`skill file "${input.slug}/${path}" written (org=${orgId})`);
      return { ok: true, slug: input.slug, action: 'write_file', message: `Archivo '${path}' guardado en skill '${input.slug}'.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async removeSkillFile(orgId: string, slug: string, filePath: string): Promise<SkillManageResult> {
    const parts = filePath.split('/');
    if (parts.length !== 2) return { ok: false, error: `file_path debe tener formato 'subdir/filename', p.ej. 'references/api.md'.` };
    const [subdir, filename] = parts;
    if (!ALLOWED_SKILL_SUBDIRS.includes(subdir as SkillSubdir)) {
      return { ok: false, error: `Subdirectorio '${subdir}' no permitido.` };
    }

    try {
      const { data: skill } = await this.db.admin
        .from('skills')
        .select('id')
        .eq('org_id', orgId)
        .eq('slug', slug)
        .maybeSingle();
      if (!skill) return { ok: false, error: `Skill '${slug}' no encontrada.` };

      await this.db.admin.from('skill_files')
        .delete()
        .eq('org_id', orgId)
        .eq('skill_id', (skill as { id: string }).id)
        .eq('subdir', subdir)
        .eq('filename', filename);

      return { ok: true, slug, action: 'remove_file', message: `Archivo '${filePath}' eliminado de skill '${slug}'.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async deleteSkill(orgId: string, slug: string): Promise<SkillManageResult> {
    try {
      const { data: skill } = await this.db.admin
        .from('skills')
        .select('id, is_pinned, metadata')
        .eq('org_id', orgId)
        .eq('slug', slug)
        .maybeSingle();

      if (!skill) return { ok: false, error: `Skill '${slug}' no encontrada.` };

      const row = skill as { id: string; is_pinned: boolean; metadata: Record<string, unknown> | null };
      if (row.is_pinned) {
        return { ok: false, error: `Skill '${slug}' está protegida (pinned) y no puede eliminarse. Editar y parchear sí está permitido.` };
      }
      if (row.metadata?.generated === false) {
        return { ok: false, error: `Skill '${slug}' es bundled y no puede eliminarse con skill_manage.` };
      }

      await this.db.admin.from('skills')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('slug', slug);

      this.logger.log(`skill doc "${slug}" archived/deleted (org=${orgId})`);
      return { ok: true, slug, action: 'delete', message: `Skill '${slug}' archivada.` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async patchSkillFile(
    orgId: string, slug: string, filePath: string, find: string, replace: string,
  ): Promise<SkillManageResult> {
    const parts = filePath.split('/');
    if (parts.length !== 2) return { ok: false, error: `file_path debe ser 'subdir/filename'.` };
    const [subdir, filename] = parts;

    const { data: skill } = await this.db.admin.from('skills').select('id').eq('org_id', orgId).eq('slug', slug).maybeSingle();
    if (!skill) return { ok: false, error: `Skill '${slug}' no encontrada.` };

    const { data: file } = await this.db.admin
      .from('skill_files')
      .select('content')
      .eq('org_id', orgId)
      .eq('skill_id', (skill as { id: string }).id)
      .eq('subdir', subdir)
      .eq('filename', filename)
      .maybeSingle();

    const current = (file as { content?: string } | null)?.content ?? '';
    if (!current.includes(find)) {
      return { ok: false, error: `Texto no encontrado en '${filePath}' de la skill '${slug}'.` };
    }

    const patched = current.replace(find, replace);
    await this.db.admin.from('skill_files')
      .update({ content: patched, size_bytes: Buffer.byteLength(patched, 'utf8'), updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('skill_id', (skill as { id: string }).id)
      .eq('subdir', subdir)
      .eq('filename', filename);

    return { ok: true, slug, action: 'patch', message: `Archivo '${filePath}' de skill '${slug}' parcheado.` };
  }

  private async checkEditAllowed(orgId: string, slug: string): Promise<string | null> {
    const { data: skill } = await this.db.admin
      .from('skills')
      .select('id, metadata')
      .eq('org_id', orgId)
      .eq('slug', slug)
      .maybeSingle();

    if (!skill) return `Skill '${slug}' no encontrada. Usa action='create' para crearla.`;
    if ((skill as { metadata?: Record<string, unknown> }).metadata?.generated === false) {
      return `Skill '${slug}' es bundled y no puede modificarse con skill_manage.`;
    }
    return null;
  }

  private validateSlug(slug: string): string | null {
    if (!slug) return 'El slug es requerido.';
    if (slug.length > 64) return 'El slug no puede exceder 64 caracteres.';
    if (!SLUG_RE.test(slug)) return `Slug '${slug}' inválido. Usa letras minúsculas, números, guiones y puntos. Debe empezar con letra o número.`;
    return null;
  }

  private validateContent(content: string): string | null {
    if (!content?.trim()) return 'El contenido no puede estar vacío.';
    if (content.length > MAX_CONTENT_CHARS) {
      return `El contenido excede ${MAX_CONTENT_CHARS.toLocaleString()} caracteres. Divide en SKILL.md + archivos de soporte en references/.`;
    }
    return null;
  }
}
