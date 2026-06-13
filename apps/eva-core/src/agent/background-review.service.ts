import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { SkillDocsService } from './skill-docs.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { SaveMemoryDto } from '../memory/dto/save-memory.dto';
import { AgentLoopStep } from './agent-loop.service';

/**
 * Prompt that drives the background skill-review agent.
 * Mirrors Hermes' _SKILL_REVIEW_PROMPT from agent/background_review.py.
 */
const SKILL_REVIEW_SYSTEM = `Eres un agente de revisión de aprendizaje para EVA. Tu única función es analizar una conversación de agente y decidir si se debe crear o actualizar alguna skill (conocimiento procedimental) en la biblioteca.

Las skills son la MEMORIA PROCEDIMENTAL de EVA — encapsulan CÓMO hacer clases de tareas. La memoria declarativa (perfil del usuario) dice QUÉ sabe EVA sobre el usuario; las skills dicen CÓMO actuar.

SEÑALES que justifican actualizar skills (cualquiera es suficiente):
  • El usuario corrigió el estilo, tono, formato, verbosidad o enfoque del agente.
  • El agente descubrió una técnica, fix, workaround o patrón de debugging no trivial.
  • Una skill cargada resultó incorrecta, incompleta o desactualizada — parchearla AHORA.
  • Emergió un workflow multi-paso reproducible que beneficiaría una sesión futura.

ORDEN DE PREFERENCIA (usa el primero que aplique):
  1. ACTUALIZAR skill ya usada en la sesión (patch si tuvo pasos incorrectos o faltantes).
  2. ACTUALIZAR skill umbrella existente (añade subsección o pitfall).
  3. AÑADIR archivo de soporte (references/tema.md, templates/nombre.ext, scripts/nombre.ext).
  4. CREAR nueva skill de clase cuando ninguna cubre el área.

NUNCA captures:
  • Errores transitorios que ya se resolvieron en la sesión.
  • Afirmaciones negativas sobre tools ('X no funciona', 'no tengo acceso a Y').
  • Tareas únicas que no son una clase reutilizable de trabajo.
  • Progreso de sesión, SHAs de commits, números de PR o estado efímero.

Responde con JSON:
{
  "action": "create" | "patch" | "edit" | "write_file" | "none",
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
@Injectable()
export class BackgroundReviewService {
  private readonly logger = new Logger(BackgroundReviewService.name);

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly skillDocs: SkillDocsService,
    private readonly memoryAgent: MemoryAgentService,
  ) {}

  /**
   * Schedules a background review after task completion.
   * Non-blocking — returns immediately.
   * Only triggers when the task had meaningful work (≥2 tool steps).
   */
  scheduleReview(input: ReviewInput): void {
    const meaningfulSteps = input.steps.filter(
      (s) => s.tool !== 'final_answer' && !s.observation.startsWith('ERROR:'),
    ).length;

    if (meaningfulSteps < 2) return;

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

  private async runSkillReview(input: ReviewInput, transcript: string): Promise<void> {
    try {
      // Get existing skill index so the reviewer knows what already exists
      const existingIndex = await this.skillDocs.getSkillIndex(input.orgId);
      const indexSummary = existingIndex.length > 0
        ? `\nSkills existentes en la biblioteca (${existingIndex.length} total):\n` +
          existingIndex.slice(0, 30).map((s) => `  - ${s.slug}: ${s.description.slice(0, 80)}`).join('\n')
        : '\nBiblioteca de skills vacía — si encuentras un workflow valioso, créala.';

      const prompt = `${transcript}\n\n${indexSummary}\n\n---\nRevisa la conversación arriba. Decide si crear, parchear o actualizar alguna skill de clase nivel en la biblioteca.`;

      const result = await this.modelRouter.generate(prompt, {
        orgId: input.orgId,
        taskId: input.taskId,
        budget: 'cheap',
        systemPrompt: SKILL_REVIEW_SYSTEM,
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 1200,
      });

      const parsed = this.parseJson<{
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
      }>(result.text);

      if (!parsed || parsed.action === 'none') {
        this.logger.debug(`background-review: no skill action (task ${input.taskId}): ${parsed?.reason ?? 'none'}`);
        return;
      }

      await this.executeSkillAction(input.orgId, input.taskId, parsed);
    } catch (err) {
      this.logger.debug(`skill-review skipped (task ${input.taskId}): ${(err as Error).message}`);
    }
  }

  private async executeSkillAction(
    orgId: string,
    taskId: string,
    parsed: {
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
    },
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
