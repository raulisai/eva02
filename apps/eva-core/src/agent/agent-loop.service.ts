import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as pathLib from 'node:path';
import { ApprovalsService } from '../approvals/approvals.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { GenerateResult, ModelBudget, ToolDefinition } from '../model-router/model-router.types';
import { GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDriveService } from './google-drive.service';
import { DatabaseService } from '../database/database.service';
import { TaskCancelledError } from '../tasks/task.types';
import { MissingInformationError, ResearchToolsService } from './research-tools.service';
import { SandboxLanguage, SandboxService } from './sandbox.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { SkillLibraryService, SkillSummary } from './skill-library.service';
import { EventBusService } from '../events/event-bus.service';
import { TelegramAdapter } from '../communication/telegram.adapter';
import { AgentProfile, DELEGATE_ROLE_CATALOG, resolveAgentProfile } from './agent-profiles';
import { AgentTrajectoryService, ModelBudgetStep } from './agent-trajectory.service';
import { AgentIntelligenceService, AgentPlanItem } from './agent-intelligence.service';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';
import { UberWebService } from '../integrations/uber-web.service';
import { RappiWebService } from '../integrations/rappi-web.service';
import { ScheduledJobsService } from '../jobs/scheduled-jobs.service';
import { z } from 'zod';


/** One executed cycle of the loop: what the model decided + what the tool observed. */
export interface AgentLoopStep {
  tool: string;
  args: Record<string, unknown>;
  thought: string;
  observation: string;
}

export interface AgentLoopOutcome {
  ok: boolean;
  text: string;
  steps: AgentLoopStep[];
  /** Tokens spent by the decide/synthesis calls of THIS loop (tool-internal LLM calls not included). */
  tokensUsed: number;
  toolsUsed: string[];
  /** true cuando la respuesta es de recuperación (todo falló → opciones honestas, no el resultado pedido). */
  degraded?: boolean;
}

export interface AgentLoopOptions {
  /** Hard cap of perceive→decide→act cycles. Root default 6, sub-agents 3. */
  maxSteps?: number;
  /** Recursion depth — 0 = root agent, 1 = delegated sub-agent (max). */
  depth?: number;
  /** Compact extra context (recent conversation turns, recalled memories). */
  context?: string;
  /** Rol del agente (sub-agentes delegados con perfil: "investigador", "programador"…). */
  role?: string;
  /** Necesario para crear approvals (ejecución con red). */
  userId?: string;
  /** Step-by-step transparency log, same shape agent-runner uses everywhere. */
  log?: (message: string, scope: string) => Promise<unknown>;
  forceDodCriteria?: boolean;
  blackboard?: Record<string, string>;
}

type ToolExecutor = (orgId: string, taskId: string, args: Record<string, unknown>) => Promise<string>;
type AgentDecision = { thought: string; tool: string; args: Record<string, unknown> };

interface ToolSpec {
  name: string;
  /** One line shown to the model — keep it short, every char repeats per step. */
  usage: string;
  /** JSON Schema for native tool-use (Claude tool_use / OpenAI function calling). */
  inputSchema: Record<string, unknown>;
  execute: ToolExecutor;
  zodSchema?: z.ZodSchema;
  /** Tools hidden from delegated sub-agents (depth ≥ 1). */
  rootOnly?: boolean;
}

/** Extras de prompt que se resuelven una vez por run() (solo raíz). */
interface LoopExtras {
  skills: SkillSummary[];
  secretAliases: string[];
}

const MAX_DEPTH = 1;
const OBSERVATION_LIMIT = 1200;
/** Args mostrados en PASOS PREVIOS — el código propio debe verse para poder corregirlo. */
const ARGS_HISTORY_LIMIT = 800;
/** Cuántos pasos recientes se muestran a fidelidad completa; los previos se comprimen. */
const RECENT_FULL_STEPS = 2;
const DEFAULT_ROOT_STEPS = 6;
const DEFAULT_SUB_STEPS = 3;
/** Two consecutive unparseable decisions → the model/key isn't up to it, bail out. */
const MAX_PARSE_FAILURES = 2;
/** El decide puede traer código literal en args — el cap debe dejarlo respirar. */
const DECIDE_MAX_TOKENS = 1400;
/** Herramientas cuyo uso exitoso amerita memorizar la solución (tipo procedural). */
const CODE_TOOLS = new Set(['code_execute', 'terminal_run', 'script_forge', 'skill_run']);
/** Código más corto que esto no vale como skill (one-liners exploratorios). */
const MIN_SKILL_CODE_LENGTH = 80;
/** Ventana de pasos para la detección de estancamiento semántico. */
const STALL_WINDOW = 4;
/** Firmas iguales en la ventana → ciclo detectado. */
const STALL_THRESHOLD = 2;
/** Máx rechazos de definition-of-done antes de aceptar la respuesta de todas formas. */
const MAX_DOD_REJECTIONS = 2;
/** Texto que indica reporte honesto de fallo — no aplicar DoD a respuestas honestas. */
const HONEST_FAILURE_RE = /\b(no se pudo|no pude|no fue posible|bloqueado|error|falló|fall[oó]|no logr[eé]|no dispon|no encontr|no hay|no tengo acceso|requiere|pendiente de aprobaci[oó]n|sin [eé]xito)\b/i;
/** Herramientas de solo lectura que se pueden ejecutar en paralelo sin carreras sobre /work. */
const PARALLEL_READ_ONLY_TOOLS = new Set(['web_search', 'gmail_read', 'calendar_read', 'drive_read', 'memory_recall', 'sandbox_ls']);

const isParallelizable = (toolName: string, args: Record<string, unknown>): boolean => {
  if (PARALLEL_READ_ONLY_TOOLS.has(toolName)) return true;
  if (toolName === 'delegate') {
    const role = String(args.role ?? '').trim().toLowerCase();
    return role === 'investigador' || role === 'planeador';
  }
  return false;
};

/**
 * AgentLoopService — bucle agéntico genérico (estilo agent-zero):
 * el modelo ve el objetivo + catálogo de herramientas, decide UNA acción por
 * ciclo, observa el resultado y repite hasta dar `final_answer` o agotar pasos.
 *
 * Mejoras v2:
 * - Tool-use nativo (Claude tool_use / OpenAI function calling) con fallback JSON.
 * - Detección de estancamiento semántico (ciclos A→B→A y errores repetidos).
 * - Definition-of-done: el final_answer se valida antes de aceptarse.
 * - Skill quarantine: la auto-sedimentación registra skills como 'provisional'.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);
  private readonly tools: ToolSpec[];

  constructor(
    private readonly db: DatabaseService,
    private readonly modelRouter: ModelRouterService,
    private readonly research: ResearchToolsService,
    private readonly gmail: GmailService,
    private readonly calendar: GoogleCalendarService,
    private readonly schedule: ScheduleService,
    private readonly drive: GoogleDriveService,
    private readonly memoryAgent: MemoryAgentService,
    private readonly forge: ScriptForgeService,
    private readonly sandbox: SandboxService,
    private readonly skillLibrary: SkillLibraryService,
    private readonly whatsapp: WhatsAppWebService,
    private readonly uber: UberWebService,
    private readonly rappi: RappiWebService,
    private readonly scheduledJobs: ScheduledJobsService,
    @Optional() private readonly approvals?: ApprovalsService,
    @Optional() private readonly integrations?: IntegrationsService,
    @Optional() private readonly events?: EventBusService,
    @Optional() private readonly telegram?: TelegramAdapter,
    @Optional() private readonly trajectories?: AgentTrajectoryService,
    @Optional() private readonly intelligence?: AgentIntelligenceService,
  ) {
    this.tools = this.buildToolCatalog();
    this.attachZodSchemas();
  }

  async run(orgId: string, taskId: string, goal: string, opts: AgentLoopOptions = {}): Promise<AgentLoopOutcome> {
    if (!opts.blackboard) {
      opts.blackboard = {};
    }
    const depth = Math.min(Math.max(opts.depth ?? 0, 0), MAX_DEPTH);
    const profile = depth > 0 ? resolveAgentProfile(opts.role) : null;
    const defaultSteps = depth === 0 ? DEFAULT_ROOT_STEPS : profile?.maxSteps ?? DEFAULT_SUB_STEPS;
    const maxSteps = Math.min(Math.max(opts.maxSteps ?? defaultSteps, 1), 10);
    const log = opts.log ?? (async () => undefined);
    const available = this.tools.filter((t) => {
      if (t.rootOnly && depth > 0) return false;
      if (profile?.tools && !profile.tools.includes(t.name)) return false;
      return true;
    });
    const extras = depth === 0 ? await this.resolveExtras(orgId, goal) : { skills: [], secretAliases: [] };
    const systemPrompt = this.buildSystemPrompt(opts, available, extras, profile);
    // Tool definitions para tool-use nativo — se construyen UNA vez por run.
    const toolDefinitions = this.buildToolDefinitions(available);
    const startedAt = Date.now();

    const steps: AgentLoopStep[] = [];
    let tokensUsed = 0;
    let parseFailures = 0;
    let formatHint: string | undefined;
    let dodRejections = 0;
    let stallCount = 0;
    let currentBudget: ModelBudget = 'cheap';
    let budgetReason = 'initial';
    const modelBudgetPerStep: ModelBudgetStep[] = [];
    let plan: AgentPlanItem[] = [];
    const replayContext = depth === 0 && this.intelligence ? await this.intelligence.replayExample(orgId, goal).catch(() => null) : null;
    const inputContext = depth === 0 ? await this.latestInputAnswerContext(orgId, taskId).catch(() => null) : null;
    const dynamicContext = [opts.context, replayContext, inputContext].filter(Boolean).join('\n\n') || undefined;
    if (depth === 0 && maxSteps >= DEFAULT_ROOT_STEPS && this.intelligence) {
      plan = await this.intelligence.createInitialPlan(orgId, taskId, goal);
    }

    let dodCriteria: string[] = [];
    const shouldGenDod = (depth === 0 && maxSteps >= DEFAULT_ROOT_STEPS) &&
      (process.env.NODE_ENV !== 'test' || opts.forceDodCriteria === true);
    if (shouldGenDod) {
      try {
        const dodGenRes = await this.modelRouter.generate(
          `Meta: "${goal}"\n\nGenera de 2 a 4 criterios de aceptación concretos para verificar el éxito. Responde SOLO en formato JSON: {"criteria": ["criterio 1", "criterio 2"]}`,
          {
            orgId,
            taskId,
            budget: 'cheap',
            systemPrompt: 'Eres EVA. Genera criterios de aceptación técnicos y verificables para la meta en formato JSON.',
          }
        );
        const parsed = JSON.parse(dodGenRes.text.trim());
        if (parsed && Array.isArray(parsed.criteria)) {
          dodCriteria = parsed.criteria.map((c: any) => String(c));
          await log(`agent-loop: DoD Criterios generados: [${dodCriteria.join(' | ')}]`, 'loop');
        }
      } catch (err) {
        this.logger.debug(`Failed to generate DoD criteria: ${(err as Error).message}`);
      }
    }

    await log(`agent-loop${depth > 0 ? ` (sub-agente d${depth})` : ''}: objetivo "${goal.slice(0, 120)}" — máx ${maxSteps} pasos`, 'loop');
    this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
    if (extras.skills.length > 0) {
      await log(`agent-loop: ${extras.skills.length} skills relevantes disponibles [${extras.skills.map((s) => s.slug).join(', ')}]`, 'loop');
      if (depth === 0) {
        await this.skillLibrary.beginSelection(orgId, { goal, selected: extras.skills }).catch((err) => {
          this.logger.debug(`skill beginSelection skipped: ${(err as Error).message}`);
        });
      }
    }

    for (let i = 0; i < maxSteps; i += 1) {
      const { data: currentTask } = await this.db.admin
        .from('tasks')
        .select('status')
        .eq('id', taskId)
        .eq('org_id', orgId)
        .maybeSingle();

      if (currentTask?.status === 'cancelled') {
        this.recordTrajectory(orgId, taskId, goal, steps, 'cancelled', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        throw new TaskCancelledError();
      }

      if (depth === 0 && this.intelligence) {
        const capMessage = await this.intelligence.enforceTokenCap(orgId, taskId, tokensUsed).catch(() => null);
        if (capMessage) {
          steps.push({ tool: 'final_answer', args: { text: capMessage }, thought: 'token cap', observation: capMessage });
          this.recordTrajectory(orgId, taskId, goal, steps, 'degraded', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          return { ok: true, degraded: true, text: capMessage, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
        }
      }

      let decision: AgentDecision | null = null;
      let parallelDecisions: AgentDecision[] = [];
      let res: GenerateResult | undefined = undefined;
      try {
        res = await this.modelRouter.generate(
          this.buildUserPrompt(goal, dynamicContext, steps, maxSteps - i, formatHint, plan, opts.blackboard),
          {
            orgId,
            taskId,
            requestType: 'reasoning',
            budget: currentBudget,
            responseFormat: 'json',
            temperature: 0,
            maxTokens: DECIDE_MAX_TOKENS,
            systemPrompt,
            cacheSystem: true,
            tools: toolDefinitions,
            toolChoice: 'required',
          },
        );
        tokensUsed += res.usage.totalTokens;
        modelBudgetPerStep.push({ step: i + 1, budget: currentBudget, reason: budgetReason });

        // A — Tool-use nativo: leer toolCalls primero, fallback a JSON parsing.
        if (res.toolCalls && res.toolCalls.length > 0) {
          const responseText = res.text;
          const nativeDecisions = res.toolCalls.map((tc) => ({
            thought: (responseText || tc.name).slice(0, 300),
            tool: tc.name,
            args: tc.input,
          }));
          if (nativeDecisions.length > 1 && nativeDecisions.every((d) => isParallelizable(d.tool, d.args))) {
            parallelDecisions = nativeDecisions;
            decision = nativeDecisions[0];
          } else {
            decision = nativeDecisions[0];
          }
        } else {
          decision = this.parseDecision(res.text);
        }
      } catch (error) {
        await log(`agent-loop: decide falló — ${(error as Error).message}`, 'loop');
      }

      if (!decision) {
        parseFailures += 1;
        ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'parse_failure'));
        const rawResText = res?.text ? ` (Respuesta del modelo: ${this.truncate(res.text, 200)})` : '';
        await log(`agent-loop: fallo de parseo JSON ${parseFailures}/${MAX_PARSE_FAILURES}${rawResText}`, 'loop');
        if (parseFailures >= MAX_PARSE_FAILURES) {
          await log('agent-loop: el modelo no produjo decisiones válidas — abortando bucle', 'loop');
          this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
          this.recordTrajectory(orgId, taskId, goal, steps, 'failed', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
        }
        formatHint = `Tu respuesta anterior no fue JSON válido${res?.text ? ` (empezaba: ${this.truncate(res.text, 120)})` : ''}. Responde SOLO el objeto {"thought":"...","tool":"...","args":{...}} sin texto adicional.`;
        continue;
      }
      parseFailures = 0;
      formatHint = undefined;

      // B — Definition-of-done: validar final_answer antes de aceptarlo.
      if (decision.tool === 'final_answer') {
        const text = String(decision.args.text ?? '').trim();
        if (!text) {
          steps.push({ tool: decision.tool, args: decision.args, thought: decision.thought, observation: 'ERROR: final_answer sin texto. Incluye args.text.' });
          continue;
        }

        const dodViolation = dodRejections < MAX_DOD_REJECTIONS && depth === 0
          ? await this.validateFinalAnswer(text, steps, dodCriteria, orgId, taskId)
          : null;

        if (dodViolation) {
          dodRejections += 1;
          ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'dod_rejection'));
          await log(`agent-loop: DoD rechazó final_answer (${dodRejections}/${MAX_DOD_REJECTIONS}): ${dodViolation.slice(0, 80)}`, 'loop');
          steps.push({
            tool: decision.tool, args: decision.args, thought: decision.thought,
            observation: `VERIFICACIÓN FALLIDA: ${dodViolation} Corrige el problema antes de declarar éxito.`,
          });
          this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          continue;
        }

        let securityCheckedText = text;
        if (depth === 0 && this.intelligence) {
          const review = await this.intelligence.securityReview(orgId, taskId, goal, steps, text).catch(() => ({ ok: true, text }));
          if (!review.ok) {
            steps.push({
              tool: decision.tool,
              args: decision.args,
              thought: decision.thought,
              observation: `VERIFICACIÓN DE SEGURIDAD FALLIDA: ${review.text}`,
            });
            ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'security_review'));
            this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
            continue;
          }
          securityCheckedText = review.text;
        }

        await log(`agent-loop: final_answer en paso ${i + 1} (${tokensUsed} tokens de razonamiento)`, 'loop');
        const refinedText = depth === 0 ? await this.refineAndValidateResponse(orgId, taskId, goal, securityCheckedText) : securityCheckedText;
        this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, true, refinedText);
        this.maybeMemorizeSolution(orgId, taskId, goal, steps, depth);
        this.recordTrajectory(orgId, taskId, goal, steps, 'ok', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        return { ok: true, text: refinedText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
      }

      if (decision.tool === 'plan_update') {
        const items = Array.isArray(decision.args.items) ? decision.args.items : [];
        const nextPlan = items
          .map((item, idx) => {
            const obj: Record<string, unknown> = item && typeof item === 'object' ? item as Record<string, unknown> : { text: item };
            const rawStatus = String(obj.status ?? '');
            const status = rawStatus === 'done' || rawStatus === 'active' || rawStatus === 'pending' ? rawStatus : (idx === 0 ? 'active' : 'pending');
            return { id: String(obj.id ?? `u${idx + 1}`), text: String(obj.text ?? '').trim(), status };
          })
          .filter((item): item is AgentPlanItem => !!item.text)
          .slice(0, 6);
        if (nextPlan.length > 0) plan = nextPlan;
        steps.push({
          tool: 'plan_update',
          args: decision.args,
          thought: decision.thought,
          observation: nextPlan.length > 0 ? 'PLAN actualizado.' : 'ERROR: plan_update requiere args.items con text/status.',
        });
        this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        continue;
      }

      const spec = available.find((t) => t.name === decision!.tool);
      if (!spec) {
        steps.push({
          tool: decision.tool, args: decision.args, thought: decision.thought,
          observation: `ERROR: herramienta desconocida "${decision.tool}". Usa una de: ${available.map((t) => t.name).join(', ')}, final_answer.`,
        });
        ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'unknown_tool'));
        this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        continue;
      }

      // Loop guard — same tool + same args as the previous step is a stall.
      const prev = steps[steps.length - 1];
      if (prev && prev.tool === spec.name && JSON.stringify(prev.args) === JSON.stringify(decision.args)) {
        steps.push({
          tool: spec.name, args: decision.args, thought: decision.thought,
          observation: 'ERROR: acción repetida idéntica al paso anterior. Cambia de herramienta/args o entrega final_answer con lo que ya tienes.',
        });
        ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'repeated_action'));
        this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        continue;
      }

      // D — Detección de estancamiento semántico (ciclos A→B→A y errores repetidos).
      const stallMsg = this.detectStall(steps);
      if (stallMsg) {
        stallCount += 1;
        steps.push({
          tool: spec.name, args: decision.args, thought: decision.thought,
          observation: `ERROR: ${stallMsg}`,
        });
        ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, stallCount >= 2 ? 'persistent_stall' : 'stall'));
        if (stallCount >= 2 && depth === 0 && this.intelligence) {
          plan = await this.intelligence.replan(orgId, taskId, goal, steps);
        }
        this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        continue;
      }

      if (parallelDecisions.length > 1) {
        const runnable = parallelDecisions
          .map((d) => ({ decision: d, spec: available.find((t) => t.name === d.tool) }))
          .filter((item): item is { decision: AgentDecision; spec: ToolSpec } => !!item.spec && isParallelizable(item.spec.name, item.decision.args));

        if (runnable.length === parallelDecisions.length) {
          await log(`agent-loop paso ${i + 1}/${maxSteps}: ${runnable.length} lecturas en paralelo (${runnable.map((r) => r.spec.name).join(', ')})`, 'loop');
          const results = await Promise.all(runnable.map(async ({ decision: d, spec: tool }) => {
            await this.announceAction(orgId, taskId, tool.name, d.args);
            try {
              const rateLimit = depth === 0 && this.intelligence ? await this.intelligence.enforceToolRateLimit(orgId, tool.name) : null;
              if (rateLimit) return { tool, decision: d, observation: `ERROR: ${rateLimit}` };
              const validationError = this.validateToolArgs(tool, d.args);
              if (validationError) return { tool, decision: d, observation: validationError };
              
              let observation: string;
              if (tool.name === 'delegate') {
                observation = await this.runDelegate(orgId, taskId, d.args, depth, opts, log, steps);
              } else if (tool.name === 'code_execute') {
                observation = await this.runCodeExecute(orgId, taskId, d.args, opts);
              } else {
                observation = await tool.execute(orgId, taskId, d.args);
              }
              return { tool, decision: d, observation };
            } catch (error) {
              if (error instanceof MissingInformationError) throw error;
              return { tool, decision: d, observation: `ERROR: ${(error as Error).message.slice(0, 300)}` };
            }
          }));
          for (const result of results) {
            steps.push({
              tool: result.tool.name,
              args: result.decision.args,
              thought: result.decision.thought,
              observation: this.truncate(result.observation, OBSERVATION_LIMIT),
            });
            if (depth === 0 && this.intelligence) {
              plan = this.intelligence.updatePlanFromObservation(plan, result.observation);
            }
          }
          if (results.some((r) => r.observation.startsWith('ERROR:'))) {
            ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'tool_error'));
          }
          this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          continue;
        }
      }

      await log(`agent-loop paso ${i + 1}/${maxSteps}: ${spec.name}(${JSON.stringify(decision.args).slice(0, 160)}) — ${decision.thought.slice(0, 120)}`, 'loop');
      await this.announceAction(orgId, taskId, spec.name, decision.args);

      let observation: string;
      try {
        const rateLimit = depth === 0 && this.intelligence ? await this.intelligence.enforceToolRateLimit(orgId, spec.name) : null;
        const validationError = this.validateToolArgs(spec, decision.args);
        if (rateLimit) {
          observation = `ERROR: ${rateLimit}`;
        } else if (validationError) {
          observation = validationError;
        } else
        if (spec.name === 'delegate') {
          observation = await this.runDelegate(orgId, taskId, decision.args, depth, opts, log, steps);
        } else if (spec.name === 'code_execute') {
          observation = await this.runCodeExecute(orgId, taskId, decision.args, opts);
        } else {
          observation = await spec.execute(orgId, taskId, decision.args);
        }
      } catch (error) {
        if (error instanceof MissingInformationError) throw error;
        observation = `ERROR: ${(error as Error).message.slice(0, 300)}`;
      }

      steps.push({
        tool: spec.name,
        args: decision.args,
        thought: decision.thought,
        observation: this.truncate(observation, OBSERVATION_LIMIT),
      });
      if (observation.startsWith('ERROR:')) {
        ({ currentBudget, budgetReason } = this.escalateBudget(currentBudget, 'tool_error'));
      } else if (depth === 0 && this.intelligence) {
        plan = this.intelligence.updatePlanFromObservation(plan, observation);
      }
      this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
    }

    // Out of steps — synthesise an answer from what was gathered instead of failing dry.
    const gathered = steps.filter((s) => !s.observation.startsWith('ERROR:'));
    if (gathered.length === 0) {
      if (depth === 0 && steps.length >= 2) {
        try {
          const recovery = await this.synthesizeRecoveryOptions(orgId, taskId, goal, steps);
          tokensUsed += recovery.usage.totalTokens;
          await log(`agent-loop: todos los pasos fallaron — entregando respuesta de recuperación con opciones (${tokensUsed} tokens)`, 'loop');
          this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, recovery.text);
          this.recordTrajectory(orgId, taskId, goal, steps, 'degraded', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          return { ok: true, degraded: true, text: recovery.text.trim(), steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
        } catch (error) {
          await log(`agent-loop: síntesis de recuperación falló — ${(error as Error).message}`, 'loop');
        }
      }
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
      this.recordTrajectory(orgId, taskId, goal, steps, 'failed', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
    try {
      const synthesis = await this.modelRouter.generate(
        `OBJETIVO: ${goal}\n\nHALLAZGOS:\n${gathered.map((s) => `[${s.tool}] ${s.observation}`).join('\n\n')}\n\nRedacta la mejor respuesta posible al objetivo usando SOLO los hallazgos. Español, directo.`,
        { orgId, taskId, requestType: 'response', budget: 'cheap', maxTokens: 600, temperature: 0.2 },
      );
      tokensUsed += synthesis.usage.totalTokens;
      const refinedText = depth === 0 ? await this.refineAndValidateResponse(orgId, taskId, goal, synthesis.text) : synthesis.text;
      await log(`agent-loop: pasos agotados — sintetizando respuesta con ${gathered.length} hallazgos (${tokensUsed} tokens)`, 'loop');
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, true, refinedText);
      this.maybeMemorizeSolution(orgId, taskId, goal, steps, depth);
      this.recordTrajectory(orgId, taskId, goal, steps, 'ok', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
      return { ok: true, text: refinedText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    } catch (error) {
      await log(`agent-loop: síntesis falló — ${(error as Error).message}`, 'loop');
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
      this.recordTrajectory(orgId, taskId, goal, steps, 'failed', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
  }

  // ── prompt ────────────────────────────────────────────────────────────────

  private buildSystemPrompt(opts: AgentLoopOptions, tools: ToolSpec[], extras: LoopExtras, profile?: AgentProfile | null): string {
    const blocks: string[] = [
      `Eres EVA en modo agente autónomo${opts.role ? `, actuando como ${opts.role}` : ''}. Resuelve el OBJETIVO eligiendo UNA acción por turno.`,
      ...(profile ? [profile.mission] : []),
      '',
      'HERRAMIENTAS:',
      ...tools.map((t) => `- ${t.usage}`),
      '- final_answer{"text"}: entrega la respuesta final al usuario (español, directa).',
    ];
    if (extras.skills.length > 0) {
      blocks.push(
        '',
        'CATÁLOGO INTELIGENTE DE SKILLS (ordenado por aptitud, resultados previos y concurrencia):',
        ...extras.skills.map((s) => {
          const mode = s.useMode === 'run' ? 'ejecutable con skill_run' : 'guía para razonar/delegar';
          const role = s.agentRole ? `; sub-agente sugerido: ${s.agentRole}` : '';
          const reason = s.reason ? `; ${s.reason}` : '';
          const prov = s.isProvisional ? ' [provisional, no verificada aún]' : '';
          return `- ${s.slug} [${s.source ?? 'unknown'}, ${mode}${prov}${role}${reason}]: ${s.description}`;
        }),
      );
      const roles = extras.skills
        .filter((s) => s.agentRole && s.useMode !== 'run')
        .slice(0, 3)
        .map((s) => `${s.slug}→${s.agentRole}`)
        .join(', ');
      if (roles) blocks.push(`DISTRIBUCIÓN SUGERIDA: si delegas, divide por especialidad (${roles}). No delegues todo el objetivo completo.`);
      if (extras.skills.some((s) => s.useMode === 'run')) {
        blocks.push('Las skills ejecutables son código ya probado: usa skill_run solo para las marcadas como "ejecutable con skill_run".');
      }
      if (extras.skills.some((s) => s.useMode !== 'run')) {
        blocks.push('Las skills guía NO se ejecutan con skill_run: úsalas para elegir enfoque, pruebas, revisión o rol del sub-agente.');
      }
    }
    if (extras.secretAliases.length > 0) {
      blocks.push(
        '',
        `SECRETS DISPONIBLES (escribe el alias literal en tu código; EVA sustituye el valor al ejecutar y tú NUNCA lo ves): ${extras.secretAliases.join(', ')}`,
      );
    }
    const has = (name: string) => tools.some((t) => t.name === name);
    blocks.push(
      '',
      'REGLAS:',
      ...(has('delegate')
        ? ['- Objetivos complejos (varias partes, código + datos externos): delega primero a "planeador" para descomponer, ejecuta las subpartes con "investigador"/"programador", y si generaste código sensible o acciones con riesgo, valida con "seguridad" antes del final_answer. Cada sub-agente recibe tus hallazgos previos.']
        : []),
      '- Antes de resolver desde cero, revisa memory_recall y el CATÁLOGO INTELIGENTE DE SKILLS.',
      '- Para código: divide en pasos pequeños (inspeccionar→preparar→ejecutar→verificar). Los archivos en /work persisten entre pasos de esta tarea.',
      ...(has('code_execute') && has('telegram_send_file')
        ? ['- Para descargar medios/videos (YouTube, Platzi, etc.): el sandbox tiene preinstalado y listo para usar yt-dlp y ffmpeg. Escribe código de Python o Bash que use yt-dlp directamente para descargar el video/audio a /work. IMPORTANTE: Para que yt-dlp funcione y tenga acceso a internet, debes pasar el argumento "network": true al llamar a code_execute. Luego usa telegram_send_file para enviarlo. Evita clonar repositorios externos o instalar paquetes pesados.']
        : []),
      '- Si una herramienta devuelve ERROR, NO repitas lo mismo ni te rindas: corrige los args, prueba otra herramienta o un enfoque distinto (ej. web_search si falla una API, code_execute si falla una búsqueda).',
      '- Nunca declares éxito con salida parcial, timeout o un proceso aún corriendo: verifica con una ejecución/lectura antes de final_answer.',
      '- NUNCA inventes salida que ninguna herramienta produjo (datos, contenidos de archivo, respuestas de API). Reportar un bloqueo honesto siempre vale más que un resultado fabricado.',
      ...(has('skill_save')
        ? ['- Cuando un código funcione y resuelva algo no trivial (un fix, un método, un flujo), guárdalo con skill_save ANTES de final_answer. Si una skill que ejecutaste salió mal o desactualizada, corrígela y vuelve a guardarla con el mismo name.']
        : []),
      '- Las herramientas son de solo lectura/sandbox: si el objetivo exige enviar o modificar algo externo, junta la información y explica en final_answer qué quedaría pendiente de aprobación.',
      '- PROHIBIDO cerrar con "no se pudo" a secas: si algo queda fuera de tu alcance, tu final_answer debe traer lo que SÍ conseguiste + 2-3 opciones concretas de solución (qué reintentar, qué conectar, qué harías tú en el siguiente paso).',
      'Responde SOLO con JSON: {"thought":"breve","tool":"<nombre>","args":{...}}',
    );
    return blocks.join('\n');
  }

  private buildUserPrompt(
    goal: string,
    context: string | undefined,
    steps: AgentLoopStep[],
    stepsLeft: number,
    formatHint?: string,
    plan: AgentPlanItem[] = [],
    blackboard?: Record<string, string>,
  ): string {
    const blocks: string[] = [`OBJETIVO: ${goal}`];
    if (context) blocks.push('', `CONTEXTO:\n${context}`);
    if (blackboard && Object.keys(blackboard).length > 0) {
      const entries = Object.entries(blackboard)
        .map(([task, result]) => `- Sub-tarea [${task}]: ${result}`)
        .join('\n');
      blocks.push('', `PIZARRÓN DE TRABAJO (BLACKBOARD):\n${entries}`);
    }
    if (plan.length > 0) blocks.push('', `PLAN:\n${this.renderPlan(plan)}`);
    if (steps.length > 0) {
      blocks.push('', 'PASOS PREVIOS:', ...this.renderHistory(steps));
    }
    if (formatHint) blocks.push('', `ATENCIÓN: ${formatHint}`);
    blocks.push('', `Te quedan ${stepsLeft} acciones. Elige la siguiente acción y responde SOLO con el JSON.`);
    return blocks.join('\n');
  }

  private renderPlan(plan: AgentPlanItem[]): string {
    return plan.map((item) => {
      const marker = item.status === 'done' ? '[✓]' : item.status === 'active' ? '[→]' : '[ ]';
      return `${marker} ${item.text}`;
    }).join('\n');
  }

  private renderHistory(steps: AgentLoopStep[]): string[] {
    return steps.map((s, idx) => {
      const recent = idx >= steps.length - RECENT_FULL_STEPS;
      if (recent) {
        const args = this.truncate(JSON.stringify(s.args), ARGS_HISTORY_LIMIT);
        return `→ ${s.tool}(${args}) ⇒ ${s.observation}`;
      } else {
        // Semantic history compression for older turns:
        // We summarize what the tool did and the outcome.
        const argsSummary = this.truncate(JSON.stringify(s.args), 60);
        let obsSummary = s.observation;
        if (s.observation.startsWith('ERROR:') || s.observation.startsWith('VERIFICACIÓN')) {
          obsSummary = s.observation.trim(); // Keep errors in full detail
        } else {
          // Keep key summary details from observation: e.g. first and last lines or a computed summary
          const lines = s.observation.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length > 2) {
            obsSummary = `${lines[0]} ... ${lines[lines.length - 1]} (${lines.length} líneas)`;
          } else {
            obsSummary = lines.join('; ');
          }
          obsSummary = this.truncate(obsSummary, 160);
        }
        return `→ [Paso previo resumido] ${s.tool}(${argsSummary}) ⇒ ${obsSummary}`;
      }
    });
  }

  private compactObservation(obs: string): string {
    if (obs.startsWith('ERROR:') || obs.startsWith('VERIFICACIÓN')) {
      return this.truncate(obs, 320);
    }
    const firstMeaningful = obs.split('\n').find((l) => l.trim()) ?? obs;
    return this.truncate(firstMeaningful, 160);
  }

  private parseDecision(raw: string): { thought: string; tool: string; args: Record<string, unknown> } | null {
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { obj = JSON.parse(match[0]) as Record<string, unknown>; } catch { obj = null; }
      }
    }
    if (!obj || typeof obj['tool'] !== 'string' || !obj['tool']) return null;
    const args = (obj['args'] && typeof obj['args'] === 'object') ? obj['args'] as Record<string, unknown> : {};
    return { thought: String(obj['thought'] ?? '').slice(0, 300), tool: obj['tool'], args };
  }

  // ── D: detección de estancamiento semántico ───────────────────────────────

  /**
   * Detecta ciclos y errores repetidos que el loop-guard consecutivo no ve.
   * Retorna el mensaje de error a inyectar como observación, o null si no hay stall.
   */
  private detectStall(steps: AgentLoopStep[]): string | null {
    if (steps.length < 3) return null;

    // Firma semántica: tool + prefijo normalizado de la observación.
    const sig = (s: AgentLoopStep): string =>
      `${s.tool}||${s.observation.replace(/\s+/g, ' ').trim().slice(0, 80)}`;

    const window = steps.slice(-STALL_WINDOW);
    const counts = new Map<string, number>();
    for (const s of window) {
      const k = sig(s);
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      if (n >= STALL_THRESHOLD) {
        return 'Ciclo detectado: la misma herramienta produjo el mismo resultado ≥2 veces en los últimos pasos. Cambia de estrategia, prueba otra herramienta distinta, o entrega final_answer con lo que ya tienes.';
      }
    }

    // Error idéntico repetido 3 veces consecutivas (aunque con tools distintas).
    const last3 = steps.slice(-3);
    if (last3.length === 3 && last3.every((s) => s.observation.startsWith('ERROR:'))) {
      const prefixes = last3.map((s) => s.observation.slice(0, 80));
      if (new Set(prefixes).size === 1) {
        return `El mismo error se repitió 3 veces seguidas: "${last3[0].observation.slice(7, 80)}". Cambia de enfoque completamente o explica el bloqueo en final_answer.`;
      }
    }

    return null;
  }

  // ── B: definition-of-done ─────────────────────────────────────────────────

  /**
   * Valida el texto del final_answer contra criterios mínimos antes de aceptarlo.
   * Retorna string con la violación, o null si todo está bien.
   * Solo aplica a code_execute / terminal_run (código que el agente escribió).
   */
  private async validateFinalAnswer(
    text: string,
    steps: AgentLoopStep[],
    criteria: string[],
    orgId: string,
    taskId: string,
  ): Promise<string | null> {
    // Si la respuesta es un reporte honesto de fallo, no bloquear.
    if (HONEST_FAILURE_RE.test(text)) return null;

    // Si el último paso de código propio falló, no declarar éxito.
    const lastCodeStep = [...steps]
      .reverse()
      .find((s) => s.tool === 'code_execute' || s.tool === 'terminal_run');

    if (lastCodeStep && lastCodeStep.observation.startsWith('ERROR:')) {
      return `El último código falló: "${lastCodeStep.observation.slice(7, 120)}". Verifica y corrige antes de declarar éxito, o reporta el estado real en tu respuesta.`;
    }

    if (criteria.length > 0) {
      try {
        const verificationInput = `
Criterios de Aceptación a verificar:
${criteria.map((c, idx) => `${idx + 1}. ${c}`).join('\n')}

Pasos de ejecución del agente:
${steps.map((s, idx) => `Paso ${idx + 1}: Tool "${s.tool}" con args ${JSON.stringify(s.args)}\nObservación: ${s.observation.slice(0, 300)}`).join('\n\n')}

Respuesta final del agente:
${text}

Determina si todos los criterios se cumplieron de forma exitosa según las observaciones y el resultado.
Si todo se cumple, responde únicamente "OK".
Si alguno no se cumple o falta verificar, responde con una explicación de qué falló o falta.
`;
        const verifyRes = await this.modelRouter.generate(verificationInput, {
          orgId,
          taskId,
          budget: 'cheap',
          systemPrompt: 'Eres un auditor de calidad. Valida el cumplimiento de los criterios. Responde "OK" o describe el fallo.',
        });

        const reply = verifyRes.text.trim();
        if (reply !== 'OK' && !reply.startsWith('OK')) {
          return `Criterios no satisfechos según auditoría de calidad: ${reply}`;
        }
      } catch (err) {
        this.logger.warn(`Failed to verify DoD criteria via model: ${(err as Error).message}`);
      }
    }

    return null;
  }

  // ── A: tool definitions para tool-use nativo ──────────────────────────────

  /** Construye el array de ToolDefinition desde los ToolSpec disponibles + final_answer. */
  private buildToolDefinitions(tools: ToolSpec[]): ToolDefinition[] {
    const defs: ToolDefinition[] = tools.map((t) => ({
      name: t.name,
      description: t.usage,
      inputSchema: t.inputSchema,
    }));
    // final_answer es especial: no está en buildToolCatalog pero el modelo debe usarla.
    defs.push({
      name: 'final_answer',
      description: 'Entrega la respuesta final al usuario (español, directa). Úsala cuando tengas toda la información necesaria.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Respuesta final para el usuario, en español.' },
        },
        required: ['text'],
      },
    });
    defs.push({
      name: 'plan_update',
      description: 'Actualiza el plan de trabajo cuando descubras nueva información, cambie el orden o haya un bloqueo.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'active', 'done'] },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    });
    return defs;
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  private buildToolCatalog(): ToolSpec[] {
    return [
      {
        name: 'web_search',
        usage: 'web_search{"query"}: busca en internet/APIs públicas (clima, noticias, precios, lugares, datos actuales).',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Término o pregunta a buscar.' } },
          required: ['query'],
        },
        execute: async (orgId, _taskId, args) => {
          const query = String(args.query ?? '').trim();
          if (!query) return 'ERROR: web_search requiere args.query';
          const answer = await this.research.answer(query, orgId);
          return answer.text;
        },
      },
      {
        name: 'gmail_read',
        usage: 'gmail_read{"query"?}: lee correos del usuario; query opcional estilo Gmail (from:, subject:, texto).',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Filtro estilo Gmail (from:, subject:, palabra clave). Omitir = últimos 3 correos.' } },
        },
        execute: async (orgId, _taskId, args) => {
          const query = String(args.query ?? '').trim();
          const result = query
            ? await this.gmail.fetchSearchWithFallback(orgId, query)
            : await this.gmail.fetchLatest(orgId, 3);
          return result.ok ? result.text : `ERROR: gmail ${result.reason}${result.error ? ` — ${result.error}` : ''}`;
        },
      },
      {
        name: 'calendar_read',
        usage: 'calendar_read{"days"?}: agenda próxima del usuario (local + Google Calendar).',
        inputSchema: {
          type: 'object',
          properties: { days: { type: 'number', description: 'Días hacia adelante (1-30, default 7).' } },
        },
        execute: async (orgId, _taskId, args) => {
          const days = Math.min(Math.max(Number(args.days ?? 7) || 7, 1), 30);
          const [local, gcal] = await Promise.all([
            this.schedule.formatUpcomingForSoul(orgId, days).catch(() => null),
            this.calendar.formatUpcomingForSoul(orgId, days).catch(() => null),
          ]);
          const merged = [local, gcal].filter(Boolean).join('\n');
          return merged || 'Sin eventos próximos en la agenda.';
        },
      },
      {
        name: 'drive_read',
        usage: 'drive_read{"query"}: busca archivos/carpetas en el Google Drive del usuario.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Nombre o descripción del archivo/carpeta a buscar.' } },
          required: ['query'],
        },
        execute: async (orgId, _taskId, args) => {
          const query = String(args.query ?? '').trim();
          if (!query) return 'ERROR: drive_read requiere args.query';
          const result = await this.drive.fetchForQuery(orgId, query);
          return result.ok ? result.text : `ERROR: drive ${result.reason}${result.error ? ` — ${result.error}` : ''}`;
        },
      },
      {
        name: 'memory_recall',
        usage: 'memory_recall{"query"}: recuerda conversaciones, datos y soluciones pasadas del usuario.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Tema o pregunta a recordar.' } },
          required: ['query'],
        },
        execute: async (orgId, _taskId, args) => {
          const query = String(args.query ?? '').trim();
          if (!query) return 'ERROR: memory_recall requiere args.query';
          const memories = await this.memoryAgent.recall(query, orgId, 5, 0.6);
          if (memories.length === 0) return 'Sin memorias relevantes.';
          return memories.map((m) => `[${m.created_at.slice(0, 10)}] ${m.summary}`).join('\n');
        },
      },
      {
        name: 'ask_user',
        usage: 'ask_user{"question","options"?}: pregunta al usuario cuando falta una decisión o dato crítico; pausa la tarea en waiting_for_input.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Pregunta breve y concreta para el usuario.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Opciones sugeridas opcionales.' },
          },
          required: ['question'],
        },
        rootOnly: true,
        execute: async (orgId, taskId, args) => {
          if (!this.intelligence) return 'ERROR: ask_user no disponible en este contexto.';
          const question = String(args.question ?? '').trim();
          if (!question) return 'ERROR: ask_user requiere args.question';
          const options = Array.isArray(args.options) ? args.options.map((o) => String(o)).filter(Boolean).slice(0, 5) : [];
          return this.intelligence.askUser(orgId, taskId, question, options);
        },
      },
      {
        name: 'code_execute',
        usage: 'code_execute{"language":"python|node|bash","code","network"?}: ejecuta TU código literal en el sandbox de la tarea. /work persiste entre pasos; imprime resultados por stdout. Sin red por defecto (pasa "network":true si necesitas descargar de internet o llamar APIs externas; en este entorno la red está permitida y no requiere aprobación humana). Python incluye requests/pandas/numpy si la imagen eva-sandbox está instalada.',
        inputSchema: {
          type: 'object',
          properties: {
            language: { type: 'string', enum: ['python', 'node', 'bash'], description: 'Lenguaje del código.' },
            code: { type: 'string', description: 'Código a ejecutar. Usa print()/console.log() para ver resultados.' },
            network: { type: 'boolean', description: 'true = permitir acceso a red (para descargas y llamadas a APIs).' },
          },
          required: ['language', 'code'],
        },
        execute: async () => 'ERROR: code_execute no disponible',
      },
      {
        name: 'terminal_run',
        usage: 'terminal_run{"cmd","background"?}: comando de shell en el sandbox de la tarea (cwd /work). background:true para procesos largos; léelos con terminal_output.',
        inputSchema: {
          type: 'object',
          properties: {
            cmd: { type: 'string', description: 'Comando de shell a ejecutar en /work.' },
            background: { type: 'boolean', description: 'true = ejecutar en background (leer con terminal_output).' },
          },
          required: ['cmd'],
        },
        execute: async (orgId, taskId, args) => {
          const cmd = String(args.cmd ?? '').trim();
          if (!cmd) return 'ERROR: terminal_run requiere args.cmd';
          const result = await this.sandbox.execInSession(taskId, {
            kind: 'terminal', code: cmd, orgId, background: args.background === true,
          });
          return this.formatSandboxResult(result);
        },
      },
      {
        name: 'terminal_output',
        usage: 'terminal_output{}: lee la salida acumulada del proceso en background del sandbox.',
        inputSchema: { type: 'object', properties: {} },
        execute: async (_orgId, taskId) => {
          const result = await this.sandbox.readBackgroundOutput(taskId);
          return this.formatSandboxResult(result);
        },
      },
      {
        name: 'skill_run',
        usage: 'skill_run{"slug"}: re-ejecuta una skill guardada (código ya probado) en el sandbox, sin regenerarla.',
        inputSchema: {
          type: 'object',
          properties: { slug: { type: 'string', description: 'Slug de la skill a ejecutar.' } },
          required: ['slug'],
        },
        execute: async (orgId, taskId, args) => {
          const slug = String(args.slug ?? '').trim();
          if (!slug) return 'ERROR: skill_run requiere args.slug';
          const skill = await this.skillLibrary.getRunnable(orgId, slug);
          if (!skill) return `ERROR: no encontré la skill "${slug}" (¿slug correcto y activa?)`;
          const result = await this.sandbox.execInSession(taskId, {
            kind: skill.language, code: skill.code, orgId,
          });
          return `[skill ${slug}] ${this.formatSandboxResult(result)}`;
        },
      },
      {
        name: 'skill_save',
        usage: 'skill_save{"name","description","language":"python|node|bash","code"}: guarda código YA PROBADO como skill reutilizable (pasa por un escáner de seguridad). Úsalo tras verificar que funciona; mismo name = nueva versión.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nombre corto de la skill.' },
            description: { type: 'string', description: 'Qué hace esta skill.' },
            language: { type: 'string', enum: ['python', 'node', 'bash'] },
            code: { type: 'string', description: 'Código ya verificado que funciona.' },
          },
          required: ['name', 'description', 'language', 'code'],
        },
        execute: async (orgId, taskId, args) => {
          const code = String(args.code ?? '').trim();
          const name = String(args.name ?? '').trim();
          const description = String(args.description ?? '').trim();
          if (!code || !name || !description) return 'ERROR: skill_save requiere args.name, args.description y args.code';
          const rawLang = String(args.language ?? 'python');
          const language: SandboxLanguage = rawLang === 'node' || rawLang === 'bash' ? rawLang : 'python';
          const result = await this.skillLibrary.register(orgId, {
            displayName: name, description, language, code, origin: 'agent-loop', taskId,
          });
          if (!result.ok) return `ERROR: ${result.reason}`;
          await this.saveArtifact(orgId, taskId, `${result.slug}.${language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh'}`, code, {
            language, skill_slug: result.slug, origin: 'agent-loop',
          });
          return `Skill "${result.slug}" v${result.version} guardada (y como artifact). Reutilízala con skill_run{"slug":"${result.slug}"}.`;
        },
      },
      {
        name: 'script_forge',
        usage: 'script_forge{"spec"}: pide a un modelo especializado escribir Y ejecutar un script completo (queda registrado como skill reutilizable). Prefiere code_execute para iterar tú mismo.',
        inputSchema: {
          type: 'object',
          properties: { spec: { type: 'string', description: 'Descripción detallada de qué debe hacer el script.' } },
          required: ['spec'],
        },
        execute: async (orgId, taskId, args) => {
          const spec = String(args.spec ?? '').trim();
          if (!spec) return 'ERROR: script_forge requiere args.spec';
          const outcome = await this.forge.forge(orgId, taskId, spec, async () => undefined);
          return outcome.executed
            ? `Script ${outcome.filename} (${outcome.language}) ejecutado.${outcome.skillSlug ? ` Skill: ${outcome.skillSlug}.` : ''} Salida:\n${outcome.output || '(sin salida)'}`
            : `Script ${outcome.filename} generado pero no ejecutado: ${outcome.note ?? 'sandbox no disponible'}`;
        },
      },
      {
        name: 'delegate',
        usage: `delegate{"goal","role"?}: delega un sub-objetivo acotado a un sub-agente especializado. Roles: ${DELEGATE_ROLE_CATALOG}. Divide tareas grandes; no delegues el objetivo completo.`,
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'Sub-objetivo concreto y acotado.' },
            role: { type: 'string', description: `Rol del sub-agente: ${DELEGATE_ROLE_CATALOG}.` },
          },
          required: ['goal'],
        },
        rootOnly: true,
        execute: async () => 'ERROR: delegate no disponible',
      },
      {
        name: 'image_analyze',
        usage: 'image_analyze{"path","prompt"?}: analiza una imagen (captura de pantalla, foto, etc.) guardada en el sandbox (ruta relativa o absoluta) o desde una URL pública, usando un modelo de visión para extraer texto, leer códigos o resolver dudas contextuales.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Ruta de la imagen en /work o URL pública.' },
            prompt: { type: 'string', description: 'Qué analizar en la imagen.' },
          },
          required: ['path'],
        },
        execute: async (orgId, taskId, args) => {
          const pathArg = String(args.path ?? '').trim();
          if (!pathArg) return 'ERROR: image_analyze requiere args.path';
          const prompt = String(args.prompt ?? 'Extrae todo el texto legible de la imagen con el mayor detalle posible.').trim();

          let buffer: Buffer;
          let mimeType = 'image/png';

          try {
            if (pathArg.startsWith('http://') || pathArg.startsWith('https://')) {
              const res = await fetch(pathArg);
              if (!res.ok) throw new Error(`HTTP status ${res.status}`);
              const arrayBuffer = await res.arrayBuffer();
              buffer = Buffer.from(arrayBuffer);
              const contentType = res.headers.get('content-type');
              if (contentType) mimeType = contentType;
            } else {
              let resolvedPath = pathArg;
              if (!pathLib.isAbsolute(resolvedPath)) {
                let cleanPath = pathArg;
                if (cleanPath.startsWith('/work/')) {
                  cleanPath = cleanPath.slice(6);
                } else if (cleanPath.startsWith('work/')) {
                  cleanPath = cleanPath.slice(5);
                }

                const hostDir = this.sandbox.getHostDir(taskId);
                if (hostDir) {
                  const sandboxCandidate = pathLib.join(hostDir, cleanPath);
                  try {
                    await fs.access(sandboxCandidate);
                    resolvedPath = sandboxCandidate;
                  } catch {
                    // ignore
                  }
                }

                if (!pathLib.isAbsolute(resolvedPath)) {
                  resolvedPath = pathLib.resolve(process.cwd(), cleanPath);
                }
              }

              buffer = await fs.readFile(resolvedPath);
              const ext = pathLib.extname(resolvedPath).toLowerCase();
              if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
              else if (ext === '.gif') mimeType = 'image/gif';
              else if (ext === '.webp') mimeType = 'image/webp';
            }
          } catch (err) {
            return `ERROR al cargar la imagen: ${(err as Error).message}`;
          }

          try {
            const result = await this.modelRouter.generate(prompt, {
              orgId,
              taskId,
              imageBase64: buffer.toString('base64'),
              imageMimeType: mimeType,
              systemPrompt: 'Eres EVA, una asistente de IA capaz de ver y analizar imágenes y capturas de pantalla para resolver las peticiones del usuario con total precisión.',
            });
            return result.text || 'Sin respuesta del modelo de visión.';
          } catch (err) {
            return `ERROR al analizar con el modelo de visión: ${(err as Error).message}`;
          }
        },
      },
      {
        name: 'sandbox_ls',
        usage: 'sandbox_ls{"path"?}: lista los archivos en /work del sandbox de la tarea (o en un subdirectorio). Usa esto para verificar que un archivo fue descargado antes de enviarlo.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Subdirectorio dentro de /work (opcional).' } },
        },
        execute: async (_orgId, taskId, args) => {
          const subPath = String(args.path ?? '').trim().replace(/^\/work\/?/, '');
          const hostDir = this.sandbox.getHostDir(taskId);
          if (!hostDir) return 'No hay sesión sandbox activa para esta tarea. Ejecuta primero code_execute o terminal_run.';
          const targetDir = subPath ? pathLib.join(hostDir, subPath) : hostDir;
          try {
            const entries = await fs.readdir(targetDir, { withFileTypes: true });
            if (entries.length === 0) return '(directorio vacío)';
            const lines = await Promise.all(
              entries.map(async (e) => {
                if (e.isDirectory()) return `📁 ${e.name}/`;
                try {
                  const stat = await fs.stat(pathLib.join(targetDir, e.name));
                  const kb = (stat.size / 1024).toFixed(1);
                  const mb = stat.size / 1024 / 1024;
                  const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${kb} KB`;
                  return `📄 ${e.name} (${size})`;
                } catch {
                  return `📄 ${e.name}`;
                }
              }),
            );
            return lines.join('\n');
          } catch (err) {
            return `ERROR al listar directorio: ${(err as Error).message}`;
          }
        },
      },
      {
        name: 'telegram_send_file',
        usage: 'telegram_send_file{"file","caption"?,"chat_id"?}: envía un archivo del workspace (/work) directamente a Telegram. file=nombre del archivo (ej. "video.mp4"). Si no se especifica chat_id, se usa el de la conversación activa de la tarea.',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Nombre del archivo en /work (ej. "video.mp4").' },
            caption: { type: 'string', description: 'Pie de foto/descripción del archivo.' },
            chat_id: { type: 'string', description: 'Chat ID de Telegram (opcional, se infiere de la tarea).' },
          },
          required: ['file'],
        },
        execute: async (orgId, taskId, args) => {
          if (!this.telegram) return 'ERROR: TelegramAdapter no disponible en este contexto.';

          const fileArg = String(args.file ?? '').trim().replace(/^\/work\/?/, '');
          if (!fileArg) return 'ERROR: telegram_send_file requiere args.file (nombre o ruta relativa en /work)';

          const hostDir = this.sandbox.getHostDir(taskId);
          if (!hostDir) return 'ERROR: no hay sesión sandbox activa. El archivo debe existir en /work (usa code_execute primero).';

          const filePath = pathLib.join(hostDir, fileArg);
          let buffer: Buffer;
          try {
            buffer = await fs.readFile(filePath);
          } catch (err) {
            return `ERROR: no se pudo leer el archivo "${fileArg}" desde /work: ${(err as Error).message}. Usa sandbox_ls para ver los archivos disponibles.`;
          }

          const caption = String(args.caption ?? '').trim() || undefined;
          const filename = pathLib.basename(fileArg);

          let chatId = String(args.chat_id ?? '').trim();
          if (!chatId) {
            try {
              const { data: task } = await this.db.admin
                .from('tasks')
                .select('metadata, created_by')
                .eq('id', taskId)
                .eq('org_id', orgId)
                .maybeSingle();
              const meta = (task?.metadata ?? {}) as Record<string, unknown>;
              chatId = String(meta['chat_id'] ?? meta['telegram_chat_id'] ?? '');

              if (!chatId && task?.created_by) {
                const { data: acc } = await this.db.admin
                  .from('communication_accounts')
                  .select('external_chat_id')
                  .eq('org_id', orgId)
                  .eq('user_id', task.created_by)
                  .eq('channel', 'telegram')
                  .eq('status', 'active')
                  .maybeSingle();
                if (acc?.external_chat_id) {
                  chatId = acc.external_chat_id;
                }
              }
            } catch {
              // ignore
            }
          }

          if (!chatId) {
            return 'ERROR: no se encontró chat_id de Telegram. Pasa args.chat_id explícitamente o asegúrate de que la tarea venga de un mensaje de Telegram.';
          }

          let botToken: string | null | undefined;
          if (this.integrations) {
            botToken = await this.integrations
              .getSecret(orgId, 'channel', 'telegram')
              .catch(() => null);
          }

          const result = await this.telegram.sendDocument(
            { chat_id: chatId },
            buffer,
            filename,
            caption,
            botToken,
          );

          if (!result.ok) {
            if ((result as { oversized?: boolean }).oversized) {
              return `ADVERTENCIA: ${result.error} — El agente descargó el archivo correctamente en /work pero no puede enviarlo porque supera el límite de Telegram. Opciones: (1) usa code_execute para comprimirlo con ffmpeg, (2) dile al usuario que lo descargue directamente.`;
            }
            return `ERROR al enviar a Telegram: ${result.error}`;
          }

          const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
          return `✅ Archivo "${filename}" (${sizeMb} MB) enviado a Telegram (chat ${chatId}, message_id=${result.externalMessageId ?? 'N/A'})`;
        },
      },
      {
        name: 'whatsapp_send',
        usage: 'whatsapp_send{"contact","text"}: prepara y envía un mensaje de WhatsApp. El envío real requiere aprobación humana.',
        inputSchema: {
          type: 'object',
          properties: {
            contact: { type: 'string', description: 'Nombre del contacto o grupo.' },
            text: { type: 'string', description: 'Mensaje de texto a enviar.' },
          },
          required: ['contact', 'text'],
        },
        execute: async (orgId, taskId, args) => {
          if (!this.approvals) return 'ERROR: ApprovalsService no disponible.';
          const contact = String(args.contact ?? '').trim();
          const text = String(args.text ?? '').trim();
          if (!contact || !text) return 'ERROR: whatsapp_send requiere contact y text.';

          const session = await this.whatsapp.startSession(orgId, taskId);
          if (session.state === 'qr_required') {
            return 'ERROR: WhatsApp Web requiere vinculación QR. Primero dile al usuario que escanee el QR desde el dashboard.';
          }

          const { data: task } = await this.db.admin
            .from('tasks')
            .select('created_by')
            .eq('id', taskId)
            .eq('org_id', orgId)
            .maybeSingle();
          const userId = task?.created_by ?? 'system';

          const approval = await this.approvals.requestForPreparedAction({
            orgId,
            userId,
            taskId,
            actionType: 'whatsapp.message.send',
            source: 'browser',
            payload: {
              session_id: session.session_id,
              contact,
              text,
            },
            summary: `Enviar WhatsApp a ${contact}: ${text.slice(0, 160)}`,
          });

          return `Petición de envío de WhatsApp creada para "${contact}" con el mensaje: "${text}". Estado: PENDIENTE DE APROBACIÓN (Hash: ${approval.action_hash})`;
        }
      },
      {
        name: 'whatsapp_read',
        usage: 'whatsapp_read{"contact"?,"unread_only"?,"unanswered_only"?}: lee mensajes recientes de WhatsApp. contact: nombre de contacto opcional. unread_only: solo mensajes sin leer. unanswered_only: solo chats pendientes de responder.',
        inputSchema: {
          type: 'object',
          properties: {
            contact: { type: 'string', description: 'Nombre de contacto para leer su historial específico (opcional).' },
            unread_only: { type: 'boolean', description: 'true: solo lee mensajes sin leer de todos los chats.' },
            unanswered_only: { type: 'boolean', description: 'true: solo lee chats pendientes de respuesta.' },
          },
        },
        execute: async (orgId, taskId, args) => {
          const contact = String(args.contact ?? '').trim();
          const unreadOnly = !!args.unread_only;
          const unansweredOnly = !!args.unanswered_only;

          const session = await this.whatsapp.startSession(orgId, taskId);
          if (session.state === 'qr_required') {
            return 'ERROR: WhatsApp Web requiere vinculación QR. Escanea el QR desde el dashboard.';
          }

          const result = unansweredOnly
            ? await this.whatsapp.fetchUnansweredMessages(orgId, taskId)
            : contact
              ? await this.whatsapp.fetchContactMessages(orgId, contact, taskId)
              : unreadOnly
                ? await this.whatsapp.fetchUnreadMessages(orgId, taskId)
                : await this.whatsapp.fetchLatestMessage(orgId, taskId);

          let replyText = result.text;
          if (result.session.screenshot?.image_base64 && (contact || !unansweredOnly)) {
            try {
              const visionPrompt = `
Aquí tienes la lista de mensajes extraídos por DOM:
${('messages' in result && result.messages) ? result.messages.join('\n') : '(Ninguno extraído por DOM)'}

Analiza la captura de pantalla de WhatsApp Web provista para complementar la lista de mensajes si falta alguno, y responder con precisión a lo que se ve en la captura.
`;
              const visionRes = await this.modelRouter.generate(visionPrompt, {
                orgId,
                taskId,
                imageBase64: result.session.screenshot.image_base64,
                imageMimeType: result.session.screenshot.mime_type || 'image/png',
                systemPrompt: 'Eres EVA, una asistente capaz de analizar capturas de pantalla de WhatsApp Web.',
              });
              if (visionRes?.text) {
                replyText = visionRes.text;
              }
            } catch (err) {
              this.logger.warn(`Failed to analyze screenshot in loop tool: ${(err as Error).message}`);
            }
          }
          return replyText;
        }
      },
      {
        name: 'uber_quote',
        usage: 'uber_quote{"origin","destination"}: obtiene una cotización/tarifa estimada de Uber para una ruta.',
        inputSchema: {
          type: 'object',
          properties: {
            origin: { type: 'string', description: 'Dirección o lugar de salida.' },
            destination: { type: 'string', description: 'Dirección o lugar de destino.' },
          },
          required: ['origin', 'destination'],
        },
        execute: async (orgId, taskId, args) => {
          const origin = String(args.origin ?? '').trim();
          const destination = String(args.destination ?? '').trim();
          if (!origin || !destination) return 'ERROR: uber_quote requiere origin y destination.';

          const result = await this.uber.estimateRide(orgId, {
            origin,
            destination,
            taskId,
          });
          return result.text;
        }
      },
      {
        name: 'uber_login',
        usage: 'uber_login{"email","password"?}: inicia el flujo de login por correo en Uber. Enviará un OTP al correo del usuario y después tendrás que pedirle al usuario el código usando ask_user.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Correo electrónico del usuario.' },
            password: { type: 'string', description: 'Contraseña (opcional).' },
          },
          required: ['email'],
        },
        execute: async (orgId, taskId, args) => {
          const email = String(args.email ?? '').trim();
          const password = String(args.password ?? '').trim() || undefined;
          if (!email) return 'ERROR: email requerido.';
          const result = await this.uber.startEmailLogin(orgId, email, password, taskId);
          return result.text;
        }
      },
      {
        name: 'rappi_login',
        usage: 'rappi_login{"email"}: inicia el flujo de login por correo en Rappi. Enviará un OTP y tendrás que pedirle al usuario el código usando ask_user.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Correo electrónico del usuario.' },
          },
          required: ['email'],
        },
        execute: async (orgId, taskId, args) => {
          const email = String(args.email ?? '').trim();
          if (!email) return 'ERROR: email requerido.';
          const result = await this.rappi.startEmailLogin(orgId, email, taskId);
          return result.text;
        }
      },
      {
        name: 'gmail_write',
        usage: 'gmail_write{"action":"send|reply|trash|archive|mark_read|mark_unread","to"?,"subject"?,"body"?,"message_id"?}: realiza operaciones de escritura en Gmail. to, subject, body son requeridos para "send". body, message_id son requeridos para "reply". message_id es requerido para "trash|archive|mark_read|mark_unread". Todo cambio requiere aprobación humana.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['send', 'reply', 'trash', 'archive', 'mark_read', 'mark_unread'], description: 'Acción a realizar.' },
            to: { type: 'string', description: 'Destinatario (para send).' },
            subject: { type: 'string', description: 'Asunto (para send).' },
            body: { type: 'string', description: 'Cuerpo del mensaje (para send/reply).' },
            message_id: { type: 'string', description: 'ID del correo a responder, borrar, archivar o marcar.' },
          },
          required: ['action'],
        },
        execute: async (orgId, taskId, args) => {
          if (!this.approvals) return 'ERROR: ApprovalsService no disponible.';
          const action = String(args.action ?? '');
          const to = String(args.to ?? '').trim();
          const subject = String(args.subject ?? '').trim();
          const body = String(args.body ?? '').trim();
          const messageId = String(args.message_id ?? '').trim();

          const { data: task } = await this.db.admin
            .from('tasks')
            .select('created_by')
            .eq('id', taskId)
            .eq('org_id', orgId)
            .maybeSingle();
          const userId = task?.created_by ?? 'system';

          let summary = '';
          let payload: Record<string, unknown> = {};

          if (action === 'send') {
            if (!to || !body) return 'ERROR: to y body requeridos para send.';
            summary = `Enviar correo a ${to}: ${subject || '(sin asunto)'}`;
            payload = { to, subject, body };
          } else if (action === 'reply') {
            if (!messageId || !body) return 'ERROR: message_id y body requeridos para reply.';
            summary = `Responder correo ID ${messageId}: ${body.slice(0, 100)}`;
            payload = { message_id: messageId, body };
          } else if (action === 'trash') {
            if (!messageId) return 'ERROR: message_id requerido para trash.';
            summary = `Mover correo ID ${messageId} a la papelera`;
            payload = { message_id: messageId };
          } else if (action === 'archive') {
            if (!messageId) return 'ERROR: message_id requerido para archive.';
            summary = `Archivar correo ID ${messageId}`;
            payload = { message_id: messageId };
          } else if (action === 'mark_read') {
            if (!messageId) return 'ERROR: message_id requerido para mark_read.';
            summary = `Marcar correo ID ${messageId} como leído`;
            payload = { message_id: messageId };
          } else if (action === 'mark_unread') {
            if (!messageId) return 'ERROR: message_id requerido para mark_unread.';
            summary = `Marcar correo ID ${messageId} como no leído`;
            payload = { message_id: messageId };
          }

          const approval = await this.approvals.requestForPreparedAction({
            orgId,
            userId,
            taskId,
            actionType: `gmail.${action}`,
            source: 'system',
            payload,
            summary,
          });

          return `Operación gmail.${action} preparada. Estado: PENDIENTE DE APROBACIÓN (Hash: ${approval.action_hash})`;
        }
      },
      {
        name: 'calendar_write',
        usage: 'calendar_write{"action":"create|delete","summary"?,"start_time"?,"end_time"?,"description"?,"event_id"?}: realiza operaciones de escritura en Google Calendar. requiere aprobación humana.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'delete'], description: 'Acción a realizar.' },
            summary: { type: 'string', description: 'Título del evento.' },
            start_time: { type: 'string', description: 'Fecha y hora de inicio (ISO 8601, ej. 2026-06-12T15:00:00Z).' },
            end_time: { type: 'string', description: 'Fecha y hora de fin (ISO 8601, ej. 2026-06-12T16:00:00Z).' },
            description: { type: 'string', description: 'Descripción o notas del evento.' },
            event_id: { type: 'string', description: 'ID del evento a modificar o eliminar.' },
          },
          required: ['action'],
        },
        execute: async (orgId, taskId, args) => {
          if (!this.approvals) return 'ERROR: ApprovalsService no disponible.';
          const action = String(args.action ?? '');
          const summaryParam = String(args.summary ?? '').trim();
          const startTime = String(args.start_time ?? '').trim();
          const endTime = String(args.end_time ?? '').trim();
          const description = String(args.description ?? '').trim();
          const eventId = String(args.event_id ?? '').trim();

          const { data: task } = await this.db.admin
            .from('tasks')
            .select('created_by')
            .eq('id', taskId)
            .eq('org_id', orgId)
            .maybeSingle();
          const userId = task?.created_by ?? 'system';

          let summary = '';
          let payload: Record<string, unknown> = {};

          if (action === 'create') {
            if (!summaryParam || !startTime || !endTime) return 'ERROR: summary, start_time y end_time requeridos para create.';
            summary = `Crear evento "${summaryParam}" en Google Calendar (${startTime})`;
            payload = { summary: summaryParam, start_time: startTime, end_time: endTime, description };
          } else if (action === 'delete') {
            if (!eventId) return 'ERROR: event_id requerido para delete.';
            summary = `Eliminar evento ID ${eventId} de Google Calendar`;
            payload = { event_id: eventId };
          }

          const approval = await this.approvals.requestForPreparedAction({
            orgId,
            userId,
            taskId,
            actionType: `calendar.${action}`,
            source: 'system',
            payload,
            summary,
          });

          return `Operación calendar.${action} preparada. Estado: PENDIENTE DE APROBACIÓN (Hash: ${approval.action_hash})`;
        }
      },
      {
        name: 'schedule_job_manage',
        usage: 'schedule_job_manage{"action":"create|list|pause|resume|delete","title"?,"cron_expression"?,"description"?,"job_id"?}: programa o gestiona tareas recurrentes o recordatorios en background.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'delete'] },
            title: { type: 'string', description: 'Título del job recurrente.' },
            cron_expression: { type: 'string', description: 'Expresión cron estándar (ej. "0 9 * * *" para diario a las 9am).' },
            description: { type: 'string', description: 'Qué debe hacer el job (instrucciones para el agente).' },
            job_id: { type: 'string', description: 'ID del job a pausar/reanudar/borrar.' },
          },
          required: ['action'],
        },
        execute: async (orgId, taskId, args) => {
          const action = String(args.action ?? '');
          const title = String(args.title ?? '').trim();
          const cron = String(args.cron_expression ?? '').trim();
          const description = String(args.description ?? '').trim();
          const jobId = String(args.job_id ?? '').trim();

          const { data: task } = await this.db.admin
            .from('tasks')
            .select('created_by')
            .eq('id', taskId)
            .eq('org_id', orgId)
            .maybeSingle();
          const userId = task?.created_by ?? 'system';

          if (action === 'create') {
            if (!title || !cron || !description) return 'ERROR: title, cron_expression y description requeridos para crear.';
            const job = await this.scheduledJobs.create(
              {
                name: title,
                schedule_type: 'cron',
                cron_expr: cron,
                task_input: description,
                job_type: 'custom',
              },
              orgId,
              userId,
            );
            return `✅ Job recurrente creado exitosamente con ID ${job.id} y cron "${job.cron_expr}"`;
          } else if (action === 'list') {
            const list = await this.scheduledJobs.list(orgId);
            if (list.length === 0) return 'No tienes tareas programadas activas.';
            return list.map((j: any) => `[ID: ${j.id}] "${j.name}" — cron "${j.cron_expr}" (estado: ${j.status})`).join('\n');
          } else if (action === 'pause') {
            if (!jobId) return 'ERROR: job_id requerido.';
            await this.scheduledJobs.pause(jobId, orgId);
            return `✅ Job ${jobId} pausado.`;
          } else if (action === 'resume') {
            if (!jobId) return 'ERROR: job_id requerido.';
            await this.scheduledJobs.resume(jobId, orgId);
            return `✅ Job ${jobId} reanudado.`;
          } else if (action === 'delete') {
            if (!jobId) return 'ERROR: job_id requerido.';
            await this.scheduledJobs.delete(jobId, orgId);
            return `✅ Job ${jobId} eliminado de forma permanente.`;
          }
          return 'ERROR: acción desconocida.';
        }
      },
    ];
  }

  private attachZodSchemas() {
    const schemas: Record<string, z.ZodSchema> = {
      web_search: z.object({ query: z.string().min(1, 'El query no puede estar vacío') }),
      gmail_read: z.object({ query: z.string().optional() }),
      calendar_read: z.object({ days: z.number().min(1).max(30).optional() }),
      drive_read: z.object({ query: z.string().min(1, 'El query no puede estar vacío') }),
      memory_recall: z.object({ query: z.string().min(1, 'El query no puede estar vacío') }),
      ask_user: z.object({
        question: z.string().min(1, 'La pregunta no puede estar vacía'),
        options: z.array(z.string()).optional(),
      }),
      code_execute: z.object({
        language: z.enum(['python', 'node', 'bash']).optional(),
        code: z.string().min(1, 'El código no puede estar vacío'),
        network: z.boolean().optional(),
      }),
      terminal_run: z.object({
        cmd: z.string().min(1, 'El comando no puede estar vacío'),
        background: z.boolean().optional(),
      }),
      terminal_output: z.object({}),
      skill_run: z.object({ slug: z.string().min(1, 'El slug no puede estar vacío') }),
      skill_save: z.object({
        name: z.string().min(1, 'El nombre no puede estar vacío'),
        description: z.string().min(1, 'La descripción no puede estar vacía'),
        language: z.enum(['python', 'node', 'bash']).optional(),
        code: z.string().min(1, 'El código no puede estar vacío'),
      }),
      script_forge: z.object({ spec: z.string().min(1, 'El spec no puede estar vacío') }),
      delegate: z.object({
        goal: z.string().min(1, 'El objetivo no puede estar vacío'),
        role: z.string().optional(),
      }),
      image_analyze: z.object({
        path: z.string().min(1, 'La ruta de la imagen no puede estar vacía'),
        prompt: z.string().optional(),
      }),
      sandbox_ls: z.object({ path: z.string().optional() }),
      telegram_send_file: z.object({
        file: z.string().min(1, 'El archivo no puede estar vacío'),
        caption: z.string().optional(),
        chat_id: z.string().optional(),
      }),
      whatsapp_send: z.object({
        contact: z.string().min(1, 'El contacto no puede estar vacío'),
        text: z.string().min(1, 'El texto no puede estar vacío'),
      }),
      whatsapp_read: z.object({
        contact: z.string().optional(),
        unread_only: z.boolean().optional(),
        unanswered_only: z.boolean().optional(),
      }),
      uber_quote: z.object({
        origin: z.string().min(1, 'El origen no puede estar vacío'),
        destination: z.string().min(1, 'El destino no puede estar vacío'),
      }),
      uber_login: z.object({
        email: z.string().email('Debe ser un correo válido'),
        password: z.string().optional(),
      }),
      rappi_login: z.object({
        email: z.string().email('Debe ser un correo válido'),
      }),
      gmail_write: z.object({
        action: z.enum(['send', 'reply', 'trash', 'archive', 'mark_read', 'mark_unread']),
        to: z.string().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        message_id: z.string().optional(),
      }),
      calendar_write: z.object({
        action: z.enum(['create', 'delete']),
        summary: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        description: z.string().optional(),
        event_id: z.string().optional(),
      }),
      schedule_job_manage: z.object({
        action: z.enum(['create', 'list', 'pause', 'resume', 'delete']),
        title: z.string().optional(),
        cron_expression: z.string().optional(),
        description: z.string().optional(),
        job_id: z.string().optional(),
      }),
    };
    for (const tool of this.tools) {
      if (schemas[tool.name]) {
        tool.zodSchema = schemas[tool.name];
      }
    }
  }

  private validateToolArgs(spec: ToolSpec, args: Record<string, unknown>): string | null {
    if (!spec.zodSchema) return null;
    const parseResult = spec.zodSchema.safeParse(args);
    if (!parseResult.success) {
      const errMsg = parseResult.error.issues.map((e) => `${e.path.join('.') || 'args'}: ${e.message}`).join(', ');
      return `ERROR: Argumentos inválidos. Detalles: ${errMsg}`;
    }
    return null;
  }

  /** code_execute con manejo de red: sin red ejecuta directo; con red crea approval. */
  private async runCodeExecute(
    orgId: string,
    taskId: string,
    args: Record<string, unknown>,
    opts: AgentLoopOptions,
  ): Promise<string> {
    const code = String(args.code ?? '').trim();
    if (!code) return 'ERROR: code_execute requiere args.code';
    const rawLang = String(args.language ?? 'python');
    const language: SandboxLanguage = rawLang === 'node' || rawLang === 'bash' ? rawLang : 'python';

    if (args.network === true) {
      if (this.intelligence) {
        const denied = await this.intelligence.validateNetworkAllowlist(orgId, code).catch(() => null);
        if (denied) return `ERROR: ${denied}`;
      }
      if (process.env.EVA_SANDBOX_ALLOW_NETWORK === 'true') {
        const result = await this.sandbox.execInSession(taskId, { kind: language, code, orgId, network: true });
        return this.formatSandboxResult(result);
      }
      if (!this.approvals || !opts.userId) {
        return 'ERROR: la ejecución con red requiere aprobación humana y no está disponible en este contexto. Reintenta sin "network" o explica en final_answer qué quedó pendiente.';
      }
      const approval = await this.approvals.requestForPreparedAction({
        orgId,
        userId: opts.userId,
        taskId,
        actionType: 'sandbox.network_exec',
        payload: { language, code },
        summary: `Ejecutar ${language} con acceso a red: ${code.slice(0, 120)}`,
      });
      return `PENDIENTE DE APROBACIÓN: la ejecución con red quedó en Approvals (hash ${approval.action_hash.slice(0, 12)}…). Se ejecutará al aprobarse. Continúa sin red o cierra con final_answer explicando que quedó pendiente.`;
    }

    const result = await this.sandbox.execInSession(taskId, { kind: language, code, orgId });
    return this.formatSandboxResult(result);
  }

  private async runDelegate(
    orgId: string,
    taskId: string,
    args: Record<string, unknown>,
    depth: number,
    opts: AgentLoopOptions,
    log: (message: string, scope: string) => Promise<unknown>,
    parentSteps: AgentLoopStep[] = [],
  ): Promise<string> {
    const subGoal = String(args.goal ?? '').trim();
    if (!subGoal) return 'ERROR: delegate requiere args.goal';
    if (depth >= MAX_DEPTH) return 'ERROR: profundidad máxima de delegación alcanzada';
    let role = String(args.role ?? '').trim() || undefined;
    if (!role) {
      const [suggested] = await this.skillLibrary.findRelevant(orgId, subGoal, 1).catch(() => []);
      role = suggested?.agentRole;
    }
    const findings = parentSteps.filter((s) => !s.observation.startsWith('ERROR:')).slice(-3);
    const context = findings.length > 0
      ? `HALLAZGOS PREVIOS DEL AGENTE PRINCIPAL:\n${findings.map((s) => `[${s.tool}] ${this.truncate(s.observation, 240)}`).join('\n')}`
      : undefined;
    const sub = await this.run(orgId, taskId, subGoal, {
      depth: depth + 1,
      role,
      context,
      userId: opts.userId,
      log,
      blackboard: opts.blackboard,
    });
    if (sub.ok) {
      if (opts.blackboard) {
        const key = role ? `${role}: ${subGoal}` : subGoal;
        opts.blackboard[key] = sub.text;
      }
      return sub.text;
    }
    const lastError = [...sub.steps].reverse().find((s) => s.observation.startsWith('ERROR:'));
    return `ERROR: el sub-agente (${role ?? 'generalista'}) no resolvió "${subGoal.slice(0, 80)}".${lastError ? ` Último error: ${this.truncate(lastError.observation, 160)}.` : ''} Prueba otro rol, divide distinto el objetivo o resuélvelo tú con otra herramienta.`;
  }

  private async synthesizeRecoveryOptions(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[]): Promise<GenerateResult> {
    const attempts = steps
      .map((s) => `[${s.tool}] ${this.truncate(s.observation, 220)}`)
      .join('\n');
    return this.modelRouter.generate(
      `OBJETIVO DEL USUARIO: ${goal}\n\nINTENTOS REALIZADOS (ninguno produjo el resultado esperado):\n${attempts}\n\nRedacta en español una respuesta honesta y útil para el usuario: una línea con qué se intentó y por qué no salió, seguida de 2 o 3 opciones concretas y accionables para lograrlo (qué integración conectar, qué dato falta, qué reintentar de otra forma). Nada de disculpas largas ni un "no se pudo" a secas. No inventes resultados.`,
      { orgId, taskId, requestType: 'response', budget: 'cheap', maxTokens: 400, temperature: 0.2 },
    );
  }

  // ── extras (skills + secrets, solo raíz) ──────────────────────────────────

  private async resolveExtras(orgId: string, goal: string): Promise<LoopExtras> {
    const [skills, secretAliases] = await Promise.all([
      this.skillLibrary.findRelevant(orgId, goal).catch(() => []),
      this.listSecretAliases(orgId),
    ]);
    return {
      skills: skills.map((s) => ({
        slug: s.slug,
        display_name: s.display_name,
        description: s.description.slice(0, 140),
        source: s.source ?? 'generated',
        category: s.category,
        agentRole: s.agentRole,
        score: s.score,
        reason: s.reason,
        useMode: s.useMode ?? 'run',
        maxConcurrency: s.maxConcurrency,
        isProvisional: s.isProvisional,
      })),
      secretAliases,
    };
  }

  private recordSkillOutcome(
    orgId: string,
    taskId: string,
    goal: string,
    selected: LoopExtras['skills'],
    steps: AgentLoopStep[],
    success: boolean,
    finalText: string,
  ): void {
    if (selected.length === 0) return;
    const usedSlugs = steps
      .filter((step) => step.tool === 'skill_run' && !step.observation.startsWith('ERROR:'))
      .map((step) => String(step.args.slug ?? ''))
      .filter(Boolean);
    void this.skillLibrary.recordOutcome(orgId, {
      taskId,
      goal,
      selected,
      usedSlugs,
      toolsUsed: this.toolsUsed(steps),
      success,
      finalText,
    }).catch((err) => this.logger.debug(`skill outcome skipped: ${(err as Error).message}`));
  }

  private async listSecretAliases(orgId: string): Promise<string[]> {
    if (!this.integrations) return [];
    try {
      const credentials = await this.integrations.list(orgId, 'credential');
      return credentials
        .filter((c) => c.has_secret && c.status === 'active')
        .slice(0, 8)
        .map((c) => `§§secret(${c.provider})`);
    } catch {
      return [];
    }
  }

  private async latestInputAnswerContext(orgId: string, taskId: string): Promise<string | null> {
    const { data } = await this.db.admin
      .from('agent_input_requests')
      .select('question, answer')
      .eq('org_id', orgId)
      .eq('task_id', taskId)
      .eq('status', 'answered')
      .order('answered_at', { ascending: false })
      .limit(1);
    const row = (data ?? [])[0] as { question?: string; answer?: string } | undefined;
    if (!row?.answer) return null;
    return `RESPUESTA DEL USUARIO A ACLARACIÓN:\nPregunta: ${row.question ?? ''}\nRespuesta: ${row.answer}`;
  }

  // ── sedimentación ─────────────────────────────────────────────────────────

  /**
   * C — Skill quarantine: las skills auto-sedimentadas se registran como
   * 'provisional' y no se ofrecen al mismo nivel que las 'active'. Solo se
   * promueven a 'active' cuando acumulan ≥2 usos exitosos vía recordOutcome.
   */
  private maybeAutoSaveSkill(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[]): void {
    const alreadySaved = steps.some(
      (s) => (s.tool === 'skill_save' || s.tool === 'script_forge') && !s.observation.startsWith('ERROR:'),
    );
    if (alreadySaved) return;

    const lastCodeStep = [...steps].reverse().find(
      (s) => s.tool === 'code_execute' && !s.observation.startsWith('ERROR:'),
    );
    const code = String(lastCodeStep?.args?.code ?? '').trim();
    if (!lastCodeStep || code.length < MIN_SKILL_CODE_LENGTH) return;

    const rawLang = String(lastCodeStep.args?.language ?? 'python');
    const language: SandboxLanguage = rawLang === 'node' || rawLang === 'bash' ? rawLang : 'python';
    const description = `Resuelve: ${goal.slice(0, 220)} (sedimentada automáticamente del agent-loop)`;

    void this.skillLibrary
      .register(orgId, {
        slug: `loop-${goal}`,
        displayName: goal.slice(0, 80),
        description,
        language,
        code,
        origin: 'agent-loop-auto',
        taskId,
        // C — quarantine: inicia como provisional, se promueve con ≥2 éxitos.
        status: 'provisional',
      })
      .then(async (result) => {
        if (!result.ok) {
          this.logger.debug(`auto-skill skipped: ${result.reason}`);
          return;
        }
        this.logger.log(`auto-skill provisional "${result.slug}" v${result.version} sedimentada de la tarea ${taskId}`);
        await this.saveArtifact(orgId, taskId, `${result.slug}.${language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh'}`, code, {
          language, skill_slug: result.slug, origin: 'agent-loop-auto', status: 'provisional',
        });
      })
      .catch((err) => this.logger.debug(`auto-skill failed: ${(err as Error).message}`));
  }

  private async saveArtifact(orgId: string, taskId: string, title: string, content: string, metadata: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.admin.from('artifacts').insert({
      org_id: orgId, task_id: taskId, kind: 'code', title, content, metadata,
    });
    if (error) this.logger.warn(`artifact save failed: ${error.message}`);
  }

  private maybeMemorizeSolution(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[], depth: number): void {
    try {
      if (depth !== 0) return;
      this.maybeAutoSaveSkill(orgId, taskId, goal, steps);
      const codeSteps = steps.filter((s) => CODE_TOOLS.has(s.tool) && !s.observation.startsWith('ERROR:'));
      if (codeSteps.length === 0) return;

      const tools = [...new Set(codeSteps.map((s) => s.tool))].join(', ');
      const digest = codeSteps
        .map((s) => `${s.tool}: ${this.truncate(s.observation, 300)}`)
        .join('\n');
      void this.memoryAgent
        .ingest(
          {
            content: `Objetivo: ${goal}\n\nPasos que funcionaron:\n${digest}`,
            summary: `Solución técnica que funcionó para: ${goal.slice(0, 140)} (herramientas: ${tools})`,
            memory_type: 'procedural',
            agent_id: 'eva',
            task_id: taskId,
            metadata: { solution: true, tools: [...new Set(codeSteps.map((s) => s.tool))] },
          },
          orgId,
        )
        .catch((err) => this.logger.debug(`solution memory skipped: ${(err as Error).message}`));
    } catch {
      // La memoria de soluciones jamás debe romper un loop exitoso.
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private formatSandboxResult(result: { ok: boolean; output: string; timedOut?: boolean; error?: string }): string {
    if (result.ok) return result.output || '(sin salida — añade prints/console.log para verificar)';
    const head = result.timedOut ? 'ERROR: timeout de ejecución' : `ERROR: ${result.error ?? 'ejecución falló'}`;
    return result.output ? `${head}\n${result.output}` : head;
  }

  private async say(orgId: string, taskId: string, text: string): Promise<void> {
    if (this.events) {
      await this.events.publish({
        type: 'task.say',
        orgId,
        taskId,
        payload: { text },
      });
    }
  }

  private async announceAction(
    orgId: string,
    taskId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let message = '';
    switch (toolName) {
      case 'web_search':
        message = `Dame un momento, voy a buscar en internet 🔎`;
        break;
      case 'gmail_read':
        message = `Voy a revisar tus correos para encontrar la información... 📬`;
        break;
      case 'gmail_send':
      case 'gmail_reply':
        message = `Redactando y enviando correo... ✉️`;
        break;
      case 'calendar_read':
        message = `Voy a revisar tu calendario para ver tu agenda... 🗓️`;
        break;
      case 'calendar_create':
      case 'calendar_update':
        message = `Actualizando tu calendario... 🗓️`;
        break;
      case 'drive_read':
        message = `Buscando en tus archivos de Google Drive... 📂`;
        break;
      case 'whatsapp_send':
        message = `Enviando el mensaje por WhatsApp... 💬`;
        break;
      case 'whatsapp_screenshot':
        message = `Abriendo WhatsApp Web para capturar pantalla... 📸`;
        break;
      case 'uber_estimate':
      case 'uber-web':
        message = `Abriendo Uber para cotizar tu viaje... 🚗`;
        break;
      case 'rappi-web':
        message = `Revisando Rappi... 🍔`;
        break;
      case 'code_execute':
        message = `Ejecutando código en el sandbox seguro... ⚙️`;
        break;
      case 'telegram_send_file':
        message = `Enviando archivo a Telegram... 📤`;
        break;
      case 'sandbox_ls':
        message = `Revisando archivos en el workspace del sandbox... 📂`;
        break;
      case 'delegate':
        message = `Delegando parte de la tarea a un sub-agente especializado... 🤖`;
        break;
    }

    if (message) {
      await this.say(orgId, taskId, message);
    }
  }

  private async refineAndValidateResponse(
    orgId: string,
    taskId: string,
    goal: string,
    proposedText: string,
  ): Promise<string> {
    try {
      const prompt = `Eres la capa de pensamiento y coherencia crítica de EVA. Tu objetivo es evaluar, limpiar y refinar la respuesta final que se le enviará al usuario.

Objetivo original del usuario: "${goal}"
Respuesta propuesta: "${proposedText}"

CRITERIOS DE CALIDAD QUE DEBES HACER CUMPLIR DE FORMA ESTRICTA:
1. Coherencia temporal: Asegúrate de que la respuesta tenga sentido hoy (año 2026). Si la información recuperada de internet está desactualizada, no tiene sentido o es contradictoria, corrígela o explica la situación de forma directa y honesta en lugar de presentar datos absurdos.
2. Formato conversacional / Voz: La respuesta debe ser natural, concisa y fluida para que se escuche bien si una voz de IA la lee en voz alta. Evita listas largas, viñetas complejas y formatos rígidos.
3. NUNCA incluyas URLs, enlaces de fuentes, o referencias como "Fuentes:" o "[1] https://..." a menos que el usuario haya solicitado explícitamente enlaces o fuentes en su pregunta.
4. Responde directamente al grano sin rodeos innecesarios o metadatos de depuración.
5. Nunca entregues un "no se pudo" o un rechazo a secas: si la respuesta propuesta reporta un bloqueo, consérvalo honesto pero asegúrate de que incluya lo que SÍ se logró y 2-3 opciones concretas de siguiente paso para el usuario.

Genera la respuesta final corregida y pulida en español. No incluyas ninguna explicación, justificación ni introducciones tuyas. Devuelve ÚNICAMENTE el texto final para el usuario.`;

      const refined = await this.modelRouter.generate(prompt, {
        orgId,
        taskId,
        requestType: 'response',
        budget: 'cheap',
        temperature: 0.1,
        maxTokens: 500,
      });

      return refined.text.trim();
    } catch (error) {
      this.logger.warn(`Response refinement failed, using raw response: ${(error as Error).message}`);
      return proposedText;
    }
  }

  private toolsUsed(steps: AgentLoopStep[]): string[] {
    return [...new Set(steps.map((s) => s.tool))];
  }

  private recordTrajectory(
    orgId: string,
    taskId: string,
    goal: string,
    steps: AgentLoopStep[],
    outcome: 'running' | 'ok' | 'failed' | 'degraded' | 'cancelled',
    tokensUsed: number,
    depth: number,
    startedAt: number,
    stallCount: number,
    dodRejections: number,
    modelBudgetPerStep: ModelBudgetStep[],
  ): void {
    if (!this.trajectories || depth > 0) return;
    const snapshot = {
      orgId,
      taskId,
      goal,
      steps: steps.map((s) => ({ ...s, args: { ...s.args } })),
      outcome,
      tokensUsed,
      toolsUsed: this.toolsUsed(steps),
      depth,
      durationMs: Date.now() - startedAt,
      stallCount,
      dodRejections,
      modelBudgetPerStep: modelBudgetPerStep.map((s) => ({ ...s })),
    };
    const op = outcome === 'running'
      ? this.trajectories.checkpoint(snapshot)
      : this.trajectories.complete(snapshot);
    void op.catch((err) => this.logger.debug(`trajectory record skipped: ${(err as Error).message}`));
  }

  private escalateBudget(current: ModelBudget, reason: string): { currentBudget: ModelBudget; budgetReason: string } {
    if (current === 'cheap') return { currentBudget: 'balanced', budgetReason: reason };
    if (reason === 'persistent_stall' && current === 'balanced') return { currentBudget: 'powerful', budgetReason: reason };
    return { currentBudget: current, budgetReason: reason };
  }

  private truncate(text: string, limit: number): string {
    const clean = text.trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}… [truncado]`;
  }
}
