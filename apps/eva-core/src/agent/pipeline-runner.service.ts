import { Injectable, Logger } from '@nestjs/common';
import { AgentLoopService } from './agent-loop.service';
import { SandboxService } from './sandbox.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { EventBusService } from '../events/event-bus.service';
import { DatabaseService } from '../database/database.service';
import type {
  PipelineDefinition,
  PipelineOutcome,
  PipelineRunOptions,
  PhaseResult,
  PhaseStatus,
} from './pipeline-runner.types';

// ─── Detection patterns ──────────────────────────────────────────────────────
// (1) pronoun back-reference: "créalo… envíalo"
// (2) connector chain: "primero / luego / finalmente"
// (3) artifact transformation + delivery: "informe → PDF → Telegram"
// (4) numbered steps
const MULTI_PHASE_PATTERNS = [
  // (1) create X → pronoun action on X
  /\b(crea|genera|redacta|elabora|escribe|prepara|haz|construye)\b.{10,250}\b(conviértelo?|pásalo?|envíalo?|mándalo?|compártelo?|súbelo?|guardalo?|archívalo?)\b/is,
  // (2) action A + connector + action B (distinct verb categories)
  /\b(crea|genera|redacta|busca|analiza|investiga|extrae|recopila)\b.{10,200}\b(después|luego|finalmente|por último|a continuación|posteriormente)\b.{10,200}\b(envía|manda|sube|exporta|convierte|telegram|email|correo)\b/is,
  // (3) document artifact → format → delivery channel
  /\b(informe|reporte|análisis|documento|resumen|presentación|reporte)\b.{5,250}\b(pdf|word|docx|excel|xlsx)\b.{5,200}\b(telegram|email|correo|whatsapp|envía|manda|comparte)\b/is,
  // (4) explicit numbered / labeled steps
  /(?:\bpaso\s+1\b|^\s*1[).]\s|\bprimero\b).{10,350}(?:\bpaso\s+2\b|\b2[).]\s|\bsegundo\b|\bluego\b|\bdespués\b)/is,
  // (5) explicit pipeline language
  /\b(pipeline|flujo de trabajo|proceso automático|automatización completa|en fases|por etapas)\b/i,
];

const PHASE_SYNTH_SYSTEM = `Eres el planificador de pipelines de EVA.
Analiza el objetivo y descomponlo en 2-5 fases ordenadas.
Reglas:
- Cada fase tiene UN objetivo atómico y verificable.
- El output de una fase puede usarse en las siguientes con {{outputKey}}.
- outputKey: slug simple (report_content, pdf_path, telegram_result, etc.).
- maxSteps: 3 para fases simples (enviar, convertir), 5-6 para fases complejas (crear, analizar).
- dependsOn: lista las fases previas de las que depende; [] si no depende de ninguna.
- El goal de cada fase debe ser autocontenido y no hacer referencia a frases del usuario como "conviértelo" — escribe el objetivo explícitamente.

Responde SOLO JSON estricto (sin markdown, sin explicación adicional):
{
  "phases": [
    { "name": "slug_fase", "goal": "objetivo completo de la fase", "outputKey": "clave_slug", "dependsOn": [], "maxSteps": 4 }
  ]
}`;

/** Max chars injected per phase output into subsequent phase context. */
const PHASE_CTX_LIMIT = 1800;
/** Max chars persisted per phase output into task metadata for phase retry. */
const PHASE_METADATA_OUTPUT_LIMIT = 4000;
/** Hard cap on maxSteps per phase regardless of LLM request. */
const PHASE_MAX_STEPS_CAP = 8;

interface StoredPipelineState {
  pipeline: PipelineDefinition;
  results: PhaseResult[];
}

@Injectable()
export class PipelineRunnerService {
  private readonly logger = new Logger(PipelineRunnerService.name);

  constructor(
    private readonly agentLoop: AgentLoopService,
    private readonly modelRouter: ModelRouterService,
    private readonly events: EventBusService,
    private readonly db: DatabaseService,
    private readonly sandbox: SandboxService,
  ) {}

  /** Returns true when `goal` contains strong multi-phase signals. */
  isMultiPhase(goal: string): boolean {
    return MULTI_PHASE_PATTERNS.some((p) => p.test(goal));
  }

  /**
   * Decompose `goal` into an ordered phase list using a cheap LLM call.
   * Falls back to a single-phase wrapper on parse failure.
   */
  async synthesizePipeline(goal: string, orgId?: string): Promise<PipelineDefinition> {
    try {
      const result = await this.modelRouter.generate(
        `Objetivo: ${goal}`,
        { budget: 'cheap', systemPrompt: PHASE_SYNTH_SYSTEM, responseFormat: 'json', orgId },
      );
      const raw = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(raw) as PipelineDefinition;
      if (!Array.isArray(parsed.phases) || parsed.phases.length < 2) {
        throw new Error('insufficient phases');
      }
      parsed.phases = parsed.phases.map((p) => ({
        ...p,
        maxSteps: Math.min(Math.max(p.maxSteps ?? 4, 2), PHASE_MAX_STEPS_CAP),
      }));
      return parsed;
    } catch (err) {
      this.logger.warn(`synthesizePipeline failed (${(err as Error).message}) — single-phase fallback`);
      return { phases: [{ name: 'ejecutar', goal, outputKey: 'resultado', dependsOn: [], maxSteps: 6 }] };
    }
  }

  /**
   * Execute the pipeline: synthesize phases → run each in order → return outcome.
   *
   * The sandbox workspace is shared across all phases (same taskId = same /work dir),
   * so Phase 1 can write files that Phase 2 reads without explicit handoff — the
   * filesystem acts as a zero-copy channel between phases.
   */
  async run(
    orgId: string,
    taskId: string,
    goal: string,
    opts: PipelineRunOptions = {},
  ): Promise<PipelineOutcome> {
    const log = opts.log ?? (async () => undefined);
    const startedAt = Date.now();

    // ── 1. Phase synthesis / resume ──────────────────────────────────────────
    let pipeline: PipelineDefinition;
    let phaseResults: PhaseResult[];
    const resumed = opts.retryFailedPhases ? await this.loadPipelineState(orgId, taskId) : null;
    if (resumed) {
      pipeline = resumed.pipeline;
      phaseResults = resumed.results.map((result) => {
        if (result.status === 'completed') return result;
        return {
          name: result.name,
          status: 'pending' as PhaseStatus,
          output: '',
          stepsUsed: 0,
          tokensUsed: 0,
          durationMs: 0,
        };
      });
      await log(
        `Reintentando pipeline desde fases fallidas/omitidas: ${phaseResults.filter((r) => r.status === 'pending').map((r) => r.name).join(', ') || 'ninguna'}`,
        'pipeline',
      );
    } else {
      try {
      await log('Sintetizando fases del pipeline…', 'pipeline');
      pipeline = await this.synthesizePipeline(goal, orgId);
      await log(
        `Pipeline: ${pipeline.phases.length} fases → ${pipeline.phases.map((p) => p.name).join(' → ')}`,
        'pipeline',
      );
    } catch (err) {
      return {
        ok: false,
        text: `No se pudo descomponer la tarea: ${(err as Error).message}`,
        phases: [],
        totalTokens: 0,
        totalSteps: 0,
        durationMs: Date.now() - startedAt,
      };
    }

      phaseResults = pipeline.phases.map((p) => ({
        name: p.name,
        status: 'pending' as PhaseStatus,
        output: '',
        stepsUsed: 0,
        tokensUsed: 0,
        durationMs: 0,
      }));
    }

    const pipelineCtx: Record<string, string> = {};
    pipeline.phases.forEach((phase, i) => {
      const result = phaseResults[i];
      if (result?.status === 'completed' && result.output) {
        pipelineCtx[phase.outputKey] = result.output;
      }
    });
    let totalTokens = phaseResults.reduce((sum, result) => sum + (result.status === 'completed' ? result.tokensUsed : 0), 0);
    let totalSteps = phaseResults.reduce((sum, result) => sum + (result.status === 'completed' ? result.stepsUsed : 0), 0);

    await this.savePipelineMetadata(orgId, taskId, pipeline, phaseResults);

    // ── 2. Phase execution — wave-based parallel execution ──────────────────
    // Phases in the same wave (same dependency depth) run concurrently.
    // Phases with dependsOn execute only after all their dependencies complete.
    try {
      let wave = 0;
      while (phaseResults.some((r) => r.status === 'pending')) {
        // Collect all phases that are ready to run (all deps completed)
        const ready = pipeline.phases.filter((phase, i) => {
          if (phaseResults[i].status !== 'pending') return false;
          return phase.dependsOn.every((dep) => {
            const depR = phaseResults.find((r) => r.name === dep);
            return depR?.status === 'completed';
          });
        });

        // If nothing is ready but pending phases remain, deps failed → skip them
        if (ready.length === 0) {
          for (let i = 0; i < pipeline.phases.length; i++) {
            if (phaseResults[i].status !== 'pending') continue;
            const phase = pipeline.phases[i];
            const blockedBy = phase.dependsOn.filter((dep) => {
              const depR = phaseResults.find((r) => r.name === dep);
              return !depR || depR.status !== 'completed';
            });
            phaseResults[i].status = 'skipped';
            phaseResults[i].error = `Dependencias no completadas: ${blockedBy.join(', ')}`;
            await log(`⏭ Fase "${phase.name}" omitida — ${phaseResults[i].error}`, 'pipeline');
          }
          break;
        }

        wave++;
        if (ready.length > 1) {
          await log(`▶ Wave ${wave}: ${ready.map((p) => `"${p.name}"`).join(', ')} (paralelo)`, 'pipeline-phase');
        }

        await Promise.all(ready.map(async (phase) => {
          const i = pipeline.phases.indexOf(phase);
          const result = phaseResults[i];

          result.status = 'running';
          if (ready.length === 1) {
            await log(`▶ Fase ${i + 1}/${pipeline.phases.length}: "${phase.name}"`, 'pipeline-phase');
          }
          await this.savePipelineMetadata(orgId, taskId, pipeline, phaseResults, i);

          const interpolatedGoal = this.interpolate(phase.goal, pipelineCtx);

          const contextParts: string[] = [];
          if (opts.context) contextParts.push(opts.context);
          if (Object.keys(pipelineCtx).length > 0) {
            contextParts.push('[PIPELINE — salidas de fases anteriores]');
            for (const [key, val] of Object.entries(pipelineCtx)) {
              const excerpt = val.length > PHASE_CTX_LIMIT ? val.slice(0, PHASE_CTX_LIMIT) + '…' : val;
              contextParts.push(`${key}:\n${excerpt}`);
            }
          }
          const phaseContext = contextParts.length > 0 ? contextParts.join('\n\n') : undefined;

          const phaseStart = Date.now();
          try {
            const outcome = await this.agentLoop.run(orgId, taskId, interpolatedGoal, {
              maxSteps: phase.maxSteps,
              context: phaseContext,
              userId: opts.userId,
              log,
            });

            result.durationMs = Date.now() - phaseStart;
            result.stepsUsed = outcome.steps.length;
            result.tokensUsed = outcome.tokensUsed;
            totalTokens += outcome.tokensUsed;
            totalSteps += outcome.steps.length;

            if (outcome.ok && outcome.text) {
              result.status = 'completed';
              result.output = outcome.text;
              pipelineCtx[phase.outputKey] = outcome.text;
              await log(
                `✓ "${phase.name}" completada — ${outcome.steps.length} pasos, ${outcome.tokensUsed} tokens, ${(result.durationMs / 1000).toFixed(1)}s`,
                'pipeline-phase',
              );
            } else {
              result.status = 'failed';
              result.error = outcome.text || 'La fase no produjo resultado';
              await log(`✗ "${phase.name}" falló: ${result.error.slice(0, 200)}`, 'pipeline-phase');
            }
          } catch (err) {
            result.status = 'failed';
            result.error = (err as Error).message;
            result.durationMs = Date.now() - phaseStart;
            await log(`✗ "${phase.name}" error: ${result.error.slice(0, 200)}`, 'pipeline-phase');
          }

          await this.savePipelineMetadata(orgId, taskId, pipeline, phaseResults, i + 1);
        }));
      }
    } finally {
      // Release shared sandbox workspace after all phases finish
      void this.sandbox.release(taskId).catch(() => undefined);
    }

    // ── 3. Build outcome ─────────────────────────────────────────────────────
    const completed = phaseResults.filter((r) => r.status === 'completed');
    const failed = phaseResults.filter((r) => r.status === 'failed');
    const skipped = phaseResults.filter((r) => r.status === 'skipped');

    const text = this.buildSummary(phaseResults, completed, failed, skipped);
    const ok = failed.length === 0 && skipped.length === 0;

    return { ok, text, phases: phaseResults, totalTokens, totalSteps, durationMs: Date.now() - startedAt };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private interpolate(goal: string, ctx: Record<string, string>): string {
    return goal.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const val = ctx[key];
      if (!val) return `[${key}]`;
      return val.length > 1000 ? val.slice(0, 1000) + '…' : val;
    });
  }

  private buildSummary(
    all: PhaseResult[],
    completed: PhaseResult[],
    failed: PhaseResult[],
    skipped: PhaseResult[],
  ): string {
    if (failed.length === 0 && skipped.length === 0 && completed.length > 0) {
      const lastOutput = completed[completed.length - 1].output;
      const phaseList = completed
        .map((r, i) => `  ${i + 1}. **${r.name}** — ${(r.durationMs / 1000).toFixed(1)}s, ${r.stepsUsed} pasos`)
        .join('\n');
      return `${lastOutput}\n\n---\n*Pipeline completado · ${completed.length} fases*\n${phaseList}`;
    }

    const lines: string[] = ['**Pipeline** — resultado parcial'];
    for (const r of all) {
      const icon = r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '⏭';
      const detail = r.error ? ` — ${r.error.slice(0, 120)}` : '';
      lines.push(`${icon} **${r.name}**: ${r.status}${detail}`);
    }
    if (completed.length > 0) {
      lines.push('', '_Último resultado disponible:_');
      lines.push(completed[completed.length - 1].output);
    }
    return lines.join('\n');
  }

  private async loadPipelineState(orgId: string, taskId: string): Promise<StoredPipelineState | null> {
    try {
      const { data: task } = await this.db.admin
        .from('tasks')
        .select('metadata')
        .eq('org_id', orgId)
        .eq('id', taskId)
        .single();
      const metadata = (task?.metadata as Record<string, unknown> | null) ?? {};
      const raw = metadata.pipeline;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const stored = raw as Record<string, unknown>;
      const definition = stored.definition;
      const rawPhases = stored.phases;
      if (!definition || typeof definition !== 'object' || Array.isArray(definition) || !Array.isArray(rawPhases)) return null;
      const phases = (definition as Record<string, unknown>).phases;
      if (!Array.isArray(phases) || phases.length === 0) return null;

      const pipeline: PipelineDefinition = {
        phases: phases.map((phase) => {
          const row = (phase && typeof phase === 'object' && !Array.isArray(phase)) ? phase as Record<string, unknown> : {};
          return {
            name: String(row.name ?? ''),
            goal: String(row.goal ?? ''),
            outputKey: String(row.outputKey ?? ''),
            dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.map(String) : [],
            maxSteps: Math.min(Math.max(Number(row.maxSteps ?? 4), 2), PHASE_MAX_STEPS_CAP),
          };
        }).filter((phase) => phase.name && phase.goal && phase.outputKey),
      };
      if (pipeline.phases.length !== rawPhases.length) return null;

      const results: PhaseResult[] = rawPhases.map((phase, i) => {
        const row = (phase && typeof phase === 'object' && !Array.isArray(phase)) ? phase as Record<string, unknown> : {};
        const rawStatus = String(row.status ?? 'pending');
        const status: PhaseStatus = ['pending', 'running', 'completed', 'failed', 'skipped'].includes(rawStatus)
          ? rawStatus as PhaseStatus
          : 'pending';
        return {
          name: String(row.name ?? pipeline.phases[i].name),
          status,
          output: typeof row.output === 'string' ? row.output : '',
          error: typeof row.error === 'string' ? row.error : undefined,
          stepsUsed: Number(row.stepsUsed ?? 0),
          tokensUsed: Number(row.tokensUsed ?? 0),
          durationMs: Number(row.durationMs ?? 0),
        };
      });
      if (!results.some((result) => result.status === 'failed' || result.status === 'skipped')) return null;
      return { pipeline, results };
    } catch {
      return null;
    }
  }

  /** Best-effort: persist pipeline state to task.metadata for UI progress tracking. */
  private async savePipelineMetadata(
    orgId: string,
    taskId: string,
    pipeline: PipelineDefinition,
    results: PhaseResult[],
    currentIndex?: number,
  ): Promise<void> {
    try {
      const { data: task } = await this.db.admin
        .from('tasks')
        .select('metadata')
        .eq('org_id', orgId)
        .eq('id', taskId)
        .single();

      const existing = (task?.metadata as Record<string, unknown>) ?? {};
      await this.db.admin
        .from('tasks')
        .update({
          metadata: {
            ...existing,
            pipeline: {
              totalPhases: pipeline.phases.length,
              currentPhase: currentIndex ?? 0,
              currentPhaseName: currentIndex !== undefined ? (pipeline.phases[currentIndex]?.name ?? null) : null,
              retryable: results.some((r) => r.status === 'failed' || r.status === 'skipped'),
              definition: {
                phases: pipeline.phases,
              },
              phases: results.map((r) => ({
                name: r.name,
                status: r.status,
                outputKey: pipeline.phases.find((phase) => phase.name === r.name)?.outputKey,
                stepsUsed: r.stepsUsed,
                tokensUsed: r.tokensUsed,
                durationMs: r.durationMs,
                ...(r.output ? { output: r.output.slice(0, PHASE_METADATA_OUTPUT_LIMIT) } : {}),
                ...(r.error ? { error: r.error.slice(0, 200) } : {}),
              })),
            },
          },
        })
        .eq('org_id', orgId)
        .eq('id', taskId);
    } catch {
      // metadata update is best-effort; never block execution
    }
  }
}
