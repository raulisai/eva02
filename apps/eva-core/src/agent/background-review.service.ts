import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { SkillDocsService } from './skill-docs.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { SaveMemoryDto } from '../memory/dto/save-memory.dto';
import { AgentLoopStep } from './agent-loop.service';
import { EventBusService } from '../events/event-bus.service';

/**
 * Prompt that drives the background skill-review agent.
 * Mirrors Hermes' _SKILL_REVIEW_PROMPT from agent/background_review.py.
 */
const SKILL_REVIEW_SYSTEM = `Eres un agente de revisión de aprendizaje para EVA. Analizas una conversación de agente y actualizas la biblioteca de skills (conocimiento procedimental).

Las skills son la MEMORIA PROCEDIMENTAL de EVA — encapsulan CÓMO hacer clases de tareas. La memoria declarativa (perfil del usuario) dice QUÉ sabe EVA sobre el usuario; las skills dicen CÓMO actuar.

SÉ ACTIVO. La mayoría de sesiones produce al menos una actualización de skill, aunque sea pequeña. Una pasada que no hace nada es una oportunidad de aprendizaje perdida, no un resultado neutral. "none" es una opción real pero NO el default.

FORMA OBJETIVO de la biblioteca: skills de CLASE (cada una con un SKILL.md rico y un directorio references/ para detalle específico), NO una lista plana de entradas estrechas de una-sesión-una-skill.

SEÑALES que justifican actualizar skills (cualquiera es suficiente):
  • El usuario corrigió el estilo, tono, formato, verbosidad o enfoque del agente. La frustración ('deja de hacer X', 'esto es muy verboso', 'solo dame la respuesta') es señal de skill de PRIMERA CLASE, no solo de memoria — embebe la lección en la skill que gobierna esa tarea para que la próxima sesión arranque ya corregida.
  • El usuario corrigió el workflow, enfoque o secuencia de pasos. Codifícalo como pitfall o paso explícito.
  • Emergió una técnica, fix, workaround o patrón de debugging no trivial.
  • Una skill cargada resultó incorrecta, incompleta o desactualizada — parchearla AHORA.

ORDEN DE PREFERENCIA (usa el primero que aplique):
  1. ACTUALIZAR una skill que se cargó en la sesión (patch si tuvo pasos incorrectos o faltantes). Es la que estaba en juego.
  2. ACTUALIZAR skill umbrella existente (inspecciónala con action="view" antes de parchear; añade subsección o pitfall).
  3. AÑADIR archivo de soporte: references/tema.md (detalle de sesión, recetas de reproducción, quirks, bancos de conocimiento condensado), templates/nombre.ext (boilerplate copiable), scripts/nombre.ext (acciones re-ejecutables).
  4. CREAR nueva skill de CLASE cuando ninguna cubre el área. El nombre DEBE ser de clase — NUNCA un número de PR, string de error, codename, o 'fix-X / debug-Y' de la tarea de hoy. Si el nombre solo tiene sentido para la tarea de hoy, está mal: cae a (1), (2) o (3).

NUNCA captures (se endurecen en restricciones auto-impuestas que te muerden cuando el entorno cambia):
  • Fallos dependientes del entorno: binarios faltantes, errores de instalación fresca, 'command not found', credenciales sin configurar. El usuario los arregla — no son reglas durables. Si un tool falló por estado de setup, captura el FIX (comando de instalación, paso de config), nunca 'este tool no funciona'.
  • Afirmaciones negativas sobre tools o features ('los browser tools no funcionan', 'X está roto', 'no tengo acceso a Y'). Se endurecen en negativas que el agente se cita a sí mismo durante meses tras arreglarse el problema real.
  • Errores transitorios que se resolvieron antes de terminar la sesión. Si el retry funcionó, la lección es el patrón de retry, no el fallo.
  • Narrativas de tarea única ('resume el mercado de hoy', 'analiza este PR') — no son una clase reutilizable.

Skills PROTEGIDAS (NO las edites): bundled (metadata.generated === false). Las pinned SÍ se pueden mejorar — pin solo bloquea borrado, no actualizaciones de contenido.

PUEDES inspeccionar una skill existente antes de comprometerte. Responde {"action":"view","slug":"..."} para leer su SKILL.md y archivos; te devolveré el contenido y podrás decidir el patch exacto. Úsalo cuando vayas a parchear/editar y no tengas el contenido a la vista.

Responde con JSON:
{
  "action": "view" | "create" | "patch" | "edit" | "write_file" | "none",
  "slug": "nombre-de-skill",
  "display_name": "Nombre legible",
  "description": "Qué hace esta skill (≤120 caracteres)",
  "category": "categoria-slug",
  "content_md": "Contenido completo de SKILL.md...",
  "patch_find": "texto a buscar (solo si action=patch)",
  "patch_replace": "texto de reemplazo (solo si action=patch)",
  "file_path": "references/tema.md (solo si action=write_file)",
  "file_content": "contenido del archivo (solo si action=write_file)",
  "reason": "Por qué esta acción es valiosa"
}

Si genuinamente nada justifica una acción, responde: {"action":"none","reason":"Sin aprendizajes nuevos en esta sesión."}`;

const MEMORY_REVIEW_SYSTEM = `Eres un agente de revisión de memoria para EVA. Tu función es analizar una conversación y decidir si el usuario reveló información duradera que vale la pena recordar.

GUARDAR como memoria (hechos que reducen futura corrección del usuario):
  • Preferencias, estilo de comunicación, expectativas del usuario.
  • Información personal durable: nombre, ocupación, ubicación, relaciones clave.
  • Convenciones del entorno/proyecto que aplican a futuras sesiones.

NO guardar en memoria:
  • Progreso de tareas, resultados de sesión, logs operativos.
  • Información que estará obsoleta en 7 días.
  • Procedimientos o workflows — esos van en skills.

Responde con JSON:
{
  "should_save": true | false,
  "facts": ["hecho 1", "hecho 2"],
  "reason": "Por qué estos hechos son durables"
}

Si nada vale la pena: {"should_save":false,"facts":[],"reason":"Sin información durable nueva."}`;

export interface ReviewInput {
  orgId: string;
  taskId: string;
  goal: string;
  steps: AgentLoopStep[];
  finalText: string;
  userId?: string;
  /** True when the user injected a live steer correction — always triggers review regardless of interval. */
  nudge?: boolean;
}

/** One decision emitted by the skill-review mini-agent. */
interface SkillReviewDecision {
  action: string;
  slug?: string;
  display_name?: string;
  description?: string;
  category?: string;
  content_md?: string;
  patch_find?: string;
  patch_replace?: string;
  file_path?: string;
  file_content?: string;
  reason?: string;
}

/**
 * BackgroundReviewService — learning loop post-tarea.
 *
 * Inspirado en Hermes' agent/background_review.py:
 * Después de cada tarea completada, dispara revisiones async (no-blocking)
 * que analizan la conversación y crean/parchean skills y memoria.
 *
 * El diseño es deliberadamente barato:
 *   - Modelo "cheap" (no Opus) para minimizar coste.
 *   - Corre en fire-and-forget: nunca bloquea la respuesta al usuario.
 *   - Whitelist de acciones: solo skill_manage y memory_save.
 *   - Guarded: no toca skills bundled ni pinned.
 */
/** Fire background review after this many meaningful completions per org (absent a nudge). */
const REVIEW_INTERVAL = 5;

@Injectable()
export class BackgroundReviewService {
  private readonly logger = new Logger(BackgroundReviewService.name);
  /** Completions since last review, keyed by orgId. Resets to 0 each time review fires. */
  private readonly completionsSinceReview = new Map<string, number>();

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly skillDocs: SkillDocsService,
    private readonly memoryAgent: MemoryAgentService,
    @Optional() private readonly events?: EventBusService,
  ) {}

  /**
   * Surface a compact "what I learned" note to the user after the learning loop
   * (Hermes parity: summarize_background_review_actions). Best-effort.
   */
  private async surface(orgId: string, taskId: string, text: string): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.publish({ type: 'task.say', orgId, taskId, payload: { text } });
    } catch (err) {
      this.logger.debug(`learning-surface skipped (task ${taskId}): ${(err as Error).message}`);
    }
  }

  /**
   * Schedules a background review after task completion.
   * Non-blocking — returns immediately.
   * Only triggers when the task had meaningful work (≥2 tool steps) AND either:
   *   - input.nudge is true (user injected a live steer correction — always worth learning from), OR
   *   - completionsSinceReview for this org has reached REVIEW_INTERVAL.
   */
  scheduleReview(input: ReviewInput): void {
    const meaningfulSteps = input.steps.filter(
      (s) => s.tool !== 'final_answer' && s.tool !== 'user_steer' && !s.observation.startsWith('ERROR:'),
    ).length;

    if (meaningfulSteps < 2) return;

    const prev = this.completionsSinceReview.get(input.orgId) ?? 0;
    const count = prev + 1;
    const shouldReview = input.nudge === true || count >= REVIEW_INTERVAL;

    if (!shouldReview) {
      this.completionsSinceReview.set(input.orgId, count);
      this.logger.debug(`background-review: deferred (${count}/${REVIEW_INTERVAL}) for org ${input.orgId}`);
      return;
    }

    this.completionsSinceReview.set(input.orgId, 0);
    // Fire and forget — no await
    void this.runReview(input).catch((err) => {
      this.logger.warn(`background-review failed (task ${input.taskId}): ${(err as Error).message}`);
    });
  }

  private async runReview(input: ReviewInput): Promise<void> {
    const transcript = this.buildTranscript(input);

    // Run skill review and memory review in parallel
    await Promise.allSettled([
      this.runSkillReview(input, transcript),
      this.runMemoryReview(input, transcript),
    ]);
  }

  /**
   * Skill review as a bounded mini-agent (Hermes parity — background_review.py
   * forks a real agent with a memory+skills tool whitelist). Instead of a single
   * blind JSON call, the reviewer may inspect an existing skill's full SKILL.md
   * with {"action":"view"} before committing, so its patch_find/patch_replace
   * target real text rather than guessing. Bounded to MAX_REVIEW_STEPS turns.
   */
  private async runSkillReview(input: ReviewInput, transcript: string): Promise<void> {
    const MAX_REVIEW_STEPS = 3;
    try {
      // Get existing skill index so the reviewer knows what already exists
      const existingIndex = await this.skillDocs.getSkillIndex(input.orgId);
      const indexSummary = existingIndex.length > 0
        ? `\nSkills existentes en la biblioteca (${existingIndex.length} total):\n` +
          existingIndex.slice(0, 40).map((s) => `  - ${s.slug}: ${s.description.slice(0, 80)}`).join('\n')
        : '\nBiblioteca de skills vacía — si encuentras un workflow valioso, créala.';

      let context = `${transcript}\n\n${indexSummary}\n\n---\nRevisa la conversación arriba. Decide si crear, parchear o actualizar alguna skill de clase. Si vas a parchear una skill existente, inspecciónala primero con {"action":"view","slug":"..."}.`;
      const viewed = new Set<string>();

      for (let step = 0; step < MAX_REVIEW_STEPS; step++) {
        const result = await this.modelRouter.generate(context, {
          orgId: input.orgId,
          taskId: input.taskId,
          budget: 'cheap',
          systemPrompt: SKILL_REVIEW_SYSTEM,
          responseFormat: 'json',
          temperature: 0,
          maxTokens: 1500,
        });

        const parsed = this.parseJson<SkillReviewDecision>(result.text);

        if (!parsed || parsed.action === 'none') {
          this.logger.debug(`background-review: no skill action (task ${input.taskId}): ${parsed?.reason ?? 'none'}`);
          return;
        }

        if (parsed.action === 'view') {
          const slug = parsed.slug?.trim();
          // Guard against loops: re-viewing the same skill ends the loop.
          if (!slug || viewed.has(slug) || step === MAX_REVIEW_STEPS - 1) {
            this.logger.debug(`background-review: view exhausted/looped (task ${input.taskId}, slug=${slug ?? '∅'})`);
            return;
          }
          viewed.add(slug);
          const detail = await this.skillDocs.viewSkill(input.orgId, slug);
          const rendered = detail
            ? `SKILL.md de '${slug}':\n${(detail.content_md ?? '(vacío)').slice(0, 4000)}\n\nArchivos de soporte: ${detail.files.map((f) => f.path).join(', ') || '(ninguno)'}`
            : `Skill '${slug}' no encontrada (quizá no existe aún — usa action="create").`;
          context = `${context}\n\nInspeccionaste '${slug}':\n${rendered}\n\n---\nAhora decide la acción definitiva (patch/edit/write_file/create/none).`;
          continue;
        }

        await this.executeSkillAction(input.orgId, input.taskId, parsed);
        return;
      }
    } catch (err) {
      this.logger.debug(`skill-review skipped (task ${input.taskId}): ${(err as Error).message}`);
    }
  }

  private async executeSkillAction(
    orgId: string,
    taskId: string,
    parsed: SkillReviewDecision,
  ): Promise<void> {
    const slug = parsed.slug?.trim();
    if (!slug) return;

    let manageResult;
    switch (parsed.action) {
      case 'create':
        if (!parsed.content_md) return;
        manageResult = await this.skillDocs.createSkill(orgId, {
          slug,
          displayName: parsed.display_name ?? slug,
          description: (parsed.description ?? '').slice(0, 500),
          category: parsed.category,
          contentMd: parsed.content_md,
          origin: 'background-review',
        });
        break;

      case 'edit':
        if (!parsed.content_md) return;
        manageResult = await this.skillDocs.editSkill(orgId, slug, parsed.content_md);
        break;

      case 'patch':
        if (!parsed.patch_find || parsed.patch_replace === undefined) return;
        manageResult = await this.skillDocs.patchSkill(orgId, {
          slug,
          find: parsed.patch_find,
          replace: parsed.patch_replace,
        });
        break;

      case 'write_file': {
        if (!parsed.file_path || !parsed.file_content) return;
        const parts = parsed.file_path.split('/');
        if (parts.length !== 2) return;
        const [subdir, filename] = parts;
        manageResult = await this.skillDocs.writeSkillFile(orgId, {
          slug,
          subdir: subdir as 'references' | 'templates' | 'scripts' | 'assets',
          filename,
          content: parsed.file_content,
        });
        break;
      }

      default:
        return;
    }

    if (manageResult.ok) {
      this.logger.log(`background-review: ${parsed.action} skill '${slug}' (task ${taskId}) — ${parsed.reason ?? ''}`);
      const verb = parsed.action === 'create' ? 'creada' : parsed.action === 'write_file' ? 'ampliada' : 'actualizada';
      await this.surface(orgId, taskId, `💾 Aprendí algo: skill '${slug}' ${verb}.`);
    } else {
      this.logger.debug(`background-review: skill action failed for '${slug}': ${manageResult.error}`);
    }
  }

  private async runMemoryReview(input: ReviewInput, transcript: string): Promise<void> {
    try {
      const prompt = `${transcript}\n\n---\nRevisa la conversación. ¿El usuario reveló información durable sobre sí mismo que vale la pena recordar?`;

      const result = await this.modelRouter.generate(prompt, {
        orgId: input.orgId,
        taskId: input.taskId,
        budget: 'cheap',
        systemPrompt: MEMORY_REVIEW_SYSTEM,
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 600,
      });

      const parsed = this.parseJson<{ should_save: boolean; facts: string[]; reason?: string }>(result.text);
      if (!parsed?.should_save || !parsed.facts?.length) return;

      // Save each fact as a semantic memory entry
      for (const fact of parsed.facts.slice(0, 5)) {
        const dto = new SaveMemoryDto();
        dto.summary = fact.slice(0, 200);
        dto.content = fact;
        dto.memory_type = 'semantic';
        dto.task_id = input.taskId;
        dto.metadata = { origin: 'background-review' };
        await this.memoryAgent.ingest(dto, input.orgId).catch(() => {/* non-critical */});
      }

      this.logger.log(`background-review: ${parsed.facts.length} hechos guardados en memoria (task ${input.taskId})`);
      const n = Math.min(parsed.facts.length, 5);
      await this.surface(input.orgId, input.taskId, `🧠 Recordaré ${n} ${n === 1 ? 'cosa nueva' : 'cosas nuevas'} sobre ti.`);
    } catch (err) {
      this.logger.debug(`memory-review skipped (task ${input.taskId}): ${(err as Error).message}`);
    }
  }

  private buildTranscript(input: ReviewInput): string {
    const lines: string[] = [
      `OBJETIVO: ${input.goal}`,
      '',
      'PASOS DEL AGENTE:',
    ];

    for (const step of input.steps) {
      if (step.tool === 'final_answer') continue;
      const args = Object.entries(step.args)
        .map(([k, v]) => `${k}=${String(v).slice(0, 200)}`)
        .join(', ');
      lines.push(`  [${step.tool}] ${args}`);
      if (step.observation && !step.observation.startsWith('ERROR:')) {
        lines.push(`  → ${step.observation.slice(0, 300)}`);
      } else if (step.observation.startsWith('ERROR:')) {
        lines.push(`  → ERROR: ${step.observation.slice(0, 200)}`);
      }
    }

    if (input.finalText) {
      lines.push('', `RESPUESTA FINAL: ${input.finalText.slice(0, 400)}`);
    }

    return lines.join('\n');
  }

  private parseJson<T>(text: string): T | null {
    try {
      const clean = text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
      return JSON.parse(clean) as T;
    } catch {
      return null;
    }
  }
}
