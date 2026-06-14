import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as pathLib from 'node:path';
import { ApprovalsService } from '../approvals/approvals.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { GenerateResult, ToolDefinition } from '../model-router/model-router.types';
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
import { wantsEvidence } from './evidence';
import { AgentTrajectoryService, ModelBudgetStep } from './agent-trajectory.service';
import { AgentIntelligenceService, AgentPlanItem } from './agent-intelligence.service';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';
import { UberWebService } from '../integrations/uber-web.service';
import { RappiWebService } from '../integrations/rappi-web.service';
import { ScheduledJobsService } from '../jobs/scheduled-jobs.service';
import { SkillDocsService } from './skill-docs.service';
import { BackgroundReviewService } from './background-review.service';
import { MemoryRecallService } from './memory-recall.service';
import { tryParseDirty } from './json-repair';
import {
  BudgetState,
  applyPhaseFloor,
  deescalateOnSuccess,
  escalateOnEvent,
  inferPhase,
  initialBudget,
} from './budget-policy';
import { Tier } from './tier';
import { z } from 'zod';
import { buildAlternativesHint } from './tool-alternatives';
import {
  DeliveryRequirement,
  deriveDeliveryRequirements,
  missingDeliveryRequirements,
} from './delivery-requirements';
import { buildToolCatalog, buildZodSchemas, ToolSpec } from './tool-catalog';


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
  /** R1.2: Previous failure context injected when user says "reintenta". */
  retryContext?: import('./agent-intelligence.service').RetryContext;
  /** R2.1: Pre-built capability model block (PUEDO/NO TENGO). */
  capabilityModel?: string;
  /** R4.2: Current ladder level for gap registration (3=collab, 4=manual, 5=deferred). */
  ladderLevel?: 3 | 4 | 5;
  /** Task tier from the runner triage — drives the initial model budget. */
  tier?: Tier;
}

type ToolExecutor = (orgId: string, taskId: string, args: Record<string, unknown>) => Promise<string>;
type AgentDecision = { thought: string; tool: string; args: Record<string, unknown> };

/** Result of the definition-of-done gate for a final_answer candidate. */
type FinalEvaluation =
  | { accept: true; text: string }
  | { accept: false; event: 'dod_rejection' | 'security_review'; observation: string; logDetail?: string };
// DeliveryRequirement is now defined in ./delivery-requirements (P3 refactor).
// ToolSpec is now defined in ./tool-catalog (extracted catalog).

/** Extras de prompt que se resuelven una vez por run() (solo raíz). */
interface LoopExtras {
  skills: SkillSummary[];
  secretAliases: string[];
  /** Índice estable de skills (mandatory tier) — siempre presente en el system prompt raíz. */
  skillsIndexBlock: string;
}

const MAX_DEPTH = 1;
const OBSERVATION_LIMIT = 1200;
/** Herramientas de investigación cuya observación se comprime más agresivamente en historia vieja. */
const RESEARCH_TOOLS = new Set(['web_search', 'gmail_read', 'drive_read', 'calendar_read', 'memory_recall']);
/** Args mostrados en PASOS PREVIOS — el código propio debe verse para poder corregirlo. */
const ARGS_HISTORY_LIMIT = 800;
/** Cuántos pasos recientes se muestran a fidelidad completa; los previos se comprimen. */
const RECENT_FULL_STEPS = 2;
const DEFAULT_ROOT_STEPS = 6;
const DEFAULT_SUB_STEPS = 3;
/** Two consecutive unparseable decisions → the model/key isn't up to it, bail out. */
const MAX_PARSE_FAILURES = 2;
/** El decide puede traer código literal en args — el cap debe dejarlo respirar. */
const DECIDE_MAX_TOKENS = 2000;
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
    private readonly skillDocs: SkillDocsService,
    private readonly whatsapp: WhatsAppWebService,
    private readonly uber: UberWebService,
    private readonly rappi: RappiWebService,
    private readonly scheduledJobs: ScheduledJobsService,
    @Optional() private readonly backgroundReview?: BackgroundReviewService,
    @Optional() private readonly approvals?: ApprovalsService,
    @Optional() private readonly integrations?: IntegrationsService,
    @Optional() private readonly events?: EventBusService,
    @Optional() private readonly telegram?: TelegramAdapter,
    @Optional() private readonly trajectories?: AgentTrajectoryService,
    @Optional() private readonly intelligence?: AgentIntelligenceService,
    @Optional() private readonly memoryRecall?: MemoryRecallService,
  ) {
    this.tools = buildToolCatalog({
      db: this.db,
      modelRouter: this.modelRouter,
      research: this.research,
      gmail: this.gmail,
      calendar: this.calendar,
      schedule: this.schedule,
      drive: this.drive,
      memoryAgent: this.memoryAgent,
      forge: this.forge,
      sandbox: this.sandbox,
      skillLibrary: this.skillLibrary,
      skillDocs: this.skillDocs,
      whatsapp: this.whatsapp,
      uber: this.uber,
      rappi: this.rappi,
      scheduledJobs: this.scheduledJobs,
      intelligence: this.intelligence,
      approvals: this.approvals,
      integrations: this.integrations,
      telegram: this.telegram,
      formatSandboxResult: this.formatSandboxResult.bind(this),
      isBrittleRawPdfSkill: this.isBrittleRawPdfSkill.bind(this),
      validateOutgoingArtifact: this.validateOutgoingArtifact.bind(this),
      expandSkillInlineShell: this.expandSkillInlineShell.bind(this),
      saveArtifact: this.saveArtifact.bind(this),
    });
    this.attachZodSchemas();
  }

  async run(orgId: string, taskId: string, goal: string, opts: AgentLoopOptions = {}): Promise<AgentLoopOutcome> {
    if (!opts.blackboard) {
      opts.blackboard = {};
    }
    const depth = Math.min(Math.max(opts.depth ?? 0, 0), MAX_DEPTH);
    const deliveryRequirements = depth === 0 ? this.deriveDeliveryRequirements(goal) : [];
    const profile = depth > 0 ? resolveAgentProfile(opts.role) : null;
    const defaultSteps = depth === 0 ? DEFAULT_ROOT_STEPS : profile?.maxSteps ?? DEFAULT_SUB_STEPS;
    const requestedMaxSteps = opts.maxSteps ?? defaultSteps;
    const minDeliverySteps = deliveryRequirements.length > 0 ? 12 : 1;
    const maxSteps = Math.min(Math.max(requestedMaxSteps, minDeliverySteps), 20);
    const log = opts.log ?? (async () => undefined);
    const available = this.tools.filter((t) => {
      if (t.rootOnly && depth > 0) return false;
      if (profile?.tools && !profile.tools.includes(t.name)) return false;
      return true;
    });
    const extras = depth === 0 ? await this.resolveExtras(orgId, goal) : { skills: [], secretAliases: [], skillsIndexBlock: '' };
    // Goal signals extracted once — drive adaptive tool loading per step.
    // (System prompt built after planning so executionBrief can be injected)
    const goalSignals = depth === 0 ? this.extractGoalSignals(goal) : new Set<string>();
    const startedAt = Date.now();

    const steps: AgentLoopStep[] = [];
    let tokensUsed = 0;
    let parseFailures = 0;
    let formatHint: string | undefined;
    let dodRejections = 0;
    let stallCount = 0;
    // Budget policy: complex tasks (long/medium or with mandatory deliverables)
    // open at `balanced` so the trajectory-setting first decisions are sound.
    let budgetState: BudgetState = depth === 0
      ? initialBudget(opts.tier, deliveryRequirements.length > 0)
      : { budget: 'cheap', reason: 'sub-agent', hardEvents: 0, cleanSuccesses: 0 };
    const modelBudgetPerStep: ModelBudgetStep[] = [];
    let plan: AgentPlanItem[] = [];
    const replayContext = depth === 0 && this.intelligence ? await this.intelligence.replayExample(orgId, goal).catch(() => null) : null;
    // R4.5: inject failure anti-patterns so the agent avoids routes that already failed
    const failureAntiPattern = depth === 0 && this.intelligence ? await this.intelligence.replayFailureExample(orgId, goal).catch(() => null) : null;
    const inputContext = depth === 0 ? await this.latestInputAnswerContext(orgId, taskId).catch(() => null) : null;
    // Proactive memory: for long/medium tasks inject relevant user context via
    // embedding similarity — one cheap embed() call, no LLM, never blocks startup.
    // Skipped for sub-agents (depth>0) and trivial tiers (chat/quick without deliverables).
    const isComplexTask = depth === 0 && (
      opts.tier === 'long' || opts.tier === 'medium' || deliveryRequirements.length > 0
    );
    const proactiveMemory = isComplexTask && this.memoryRecall
      ? await this.memoryRecall.proactiveContext(goal, orgId).catch(() => null)
      : null;
    const dynamicContext = [opts.context, proactiveMemory, replayContext, failureAntiPattern, inputContext].filter(Boolean).join('\n\n') || undefined;
    // ── Pre-execution: Plan → Verify → Execute (long tasks only) ─────────────
    // For tasks with ≥10 steps: use powerful model to build a detailed multi-phase
    // plan, verify which tools/skills are actually available, then inject the
    // verified plan into the system prompt so the agent executes methodically.
    let executionBrief: string | null = null;
    const isLongTask = depth === 0 && maxSteps >= 10 && this.intelligence;
    if (isLongTask) {
      const availableToolNames = available.map((t) => t.name);
      const availableSkillSlugs = extras.skills.map((s) => s.slug);
      await log('agent-loop: planificando con modelo poderoso…', 'loop');
      const planCheck = await this.intelligence!.prepareExecution(
        orgId, taskId, goal, availableToolNames, availableSkillSlugs,
      ).catch(() => null);

      if (planCheck) {
        executionBrief = planCheck.executionBrief;
        // Convert phases to AgentPlanItems for the user-prompt rendering
        plan = planCheck.plan.phases.map((phase, idx) => ({
          id: phase.id,
          text: `[${phase.name}] ${phase.description} → scratchpad["${phase.scratchpadKey}"]`,
          status: idx === 0 ? 'active' : 'pending',
        } as import('./agent-intelligence.service').AgentPlanItem));

        await log(
          `agent-loop: plan en ${planCheck.plan.phases.length} fases` +
          (planCheck.missingTools.length > 0
            ? ` | gaps: ${planCheck.missingTools.join(', ')}`
            : ' | todas las herramientas disponibles'),
          'loop',
        );
        if (!planCheck.canProceed) {
          await log(`agent-loop: ⚠️ herramientas críticas no disponibles: ${planCheck.missingTools.join(', ')}`, 'loop');
        }
      } else {
        // Fallback to simple plan
        plan = await this.intelligence!.createInitialPlan(orgId, taskId, goal, opts.capabilityModel);
      }
    } else if (depth === 0 && maxSteps >= DEFAULT_ROOT_STEPS && this.intelligence) {
      // R2.2: probe-before-promise — plan is built with capability model so it only uses available tools
      plan = await this.intelligence.createInitialPlan(orgId, taskId, goal, opts.capabilityModel);

      // P4: gated deliberation for medium tasks.
      // Long tasks already went through prepareExecution (powerful model + phased plan).
      // Medium tasks now get a lightweight 2-3 approach comparison so the opening
      // decision is well-grounded. One `balanced` call; skipped on quick/chat tiers.
      if (opts.tier === 'medium' && !isLongTask) {
        const availableToolNamesForDeliberation = available.map((t) => t.name);
        const strategyBrief = await this.intelligence.deliberateMediumTask(
          orgId, taskId, goal, availableToolNamesForDeliberation,
        ).catch(() => null);
        if (strategyBrief) {
          executionBrief = strategyBrief;
          await log('agent-loop: estrategia elegida de deliberación medium', 'loop');
        }
      }
    }

    // System prompt built after planning so executionBrief can be injected
    const systemPrompt = this.buildSystemPrompt(opts, available, extras, profile, deliveryRequirements, executionBrief ?? undefined);

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
          dodCriteria = [...dodCriteria, ...parsed.criteria.map((c: any) => String(c))];
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

      // Mid-loop steer — drain live user redirections injected via POST /tasks/:id/steer.
      const steered = await this.applyPendingSteer(orgId, taskId, depth, steps, log);
      if (steered) {
        budgetState = escalateOnEvent(budgetState, 'user_steer');
        this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
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
      // Per-step adaptive tool loading: only send tools relevant to current phase.
      const stepTools = this.selectToolsForPhase(available, steps, maxSteps, goalSignals, depth);
      const toolDefinitions = this.buildToolDefinitions(stepTools);
      // Phase-aware floor: planning/synthesis steps deserve ≥ balanced reasoning,
      // even if the ladder/de-escalation left us at cheap.
      const lastTool = steps.length > 0 ? steps[steps.length - 1].tool : undefined;
      const phase = depth === 0
        ? inferPhase(i, maxSteps, lastTool, this.missingDeliveryRequirements(steps, deliveryRequirements).length > 0)
        : 'research';
      const { budget: stepBudget, floored } = applyPhaseFloor(budgetState.budget, phase);
      const stepReason = floored ? `${budgetState.reason}+floor:${phase}` : budgetState.reason;
      try {
        res = await this.modelRouter.generate(
          this.buildUserPrompt(goal, dynamicContext, steps, maxSteps - i, formatHint, plan, opts.blackboard, deliveryRequirements),
          {
            orgId,
            taskId,
            requestType: 'reasoning',
            budget: stepBudget,
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
        modelBudgetPerStep.push({ step: i + 1, budget: stepBudget, reason: stepReason });

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
        budgetState = escalateOnEvent(budgetState, 'parse_failure');
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

        const evaluation = await this.evaluateFinalCandidate(
          orgId, taskId, goal, text, steps, dodCriteria, deliveryRequirements, depth, dodRejections,
        );

        if (!evaluation.accept) {
          if (evaluation.event === 'dod_rejection') {
            dodRejections += 1;
            await log(`agent-loop: DoD rechazó final_answer (${dodRejections}/${MAX_DOD_REJECTIONS}): ${(evaluation.logDetail ?? '').slice(0, 80)}`, 'loop');
          }
          budgetState = escalateOnEvent(budgetState, evaluation.event);
          steps.push({
            tool: decision.tool, args: decision.args, thought: decision.thought,
            observation: evaluation.observation,
          });
          this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          continue;
        }

        const securityCheckedText = evaluation.text;
        await log(`agent-loop: final_answer en paso ${i + 1} (${tokensUsed} tokens de razonamiento)`, 'loop');
        const refinedText = depth === 0 ? await this.refineAndValidateResponse(orgId, taskId, goal, securityCheckedText) : securityCheckedText;
        this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, true, refinedText);
        this.maybeMemorizeSolution(orgId, taskId, goal, steps, depth);
        this.recordTrajectory(orgId, taskId, goal, steps, 'ok', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
        // Background learning loop — fires async, never blocks the response
        if (depth === 0) {
          const nudge = steps.some((s) => s.tool === 'user_steer');
          this.backgroundReview?.scheduleReview({ orgId, taskId, goal, steps, finalText: refinedText, nudge });
        }
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
        budgetState = escalateOnEvent(budgetState, 'unknown_tool');
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
        budgetState = escalateOnEvent(budgetState, 'repeated_action');
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
        budgetState = escalateOnEvent(budgetState, stallCount >= 2 ? 'persistent_stall' : 'stall');
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
            if (this.events) {
              await this.events.publish({
                type: 'task.step',
                orgId,
                taskId,
                payload: { thought: d.thought, tool: tool.name, args: d.args },
              });
            }
            try {
              const guardError = await this.toolGuards(orgId, tool, d.args, steps, depth, deliveryRequirements);
              if (guardError) return { tool, decision: d, observation: guardError };

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
          const availableToolNamesParallel = new Set(stepTools.map((t) => t.name));
          for (const result of results) {
            // P2: append alternatives hint on parallel errors too.
            let obs = result.observation;
            if (obs.startsWith('ERROR:')) {
              const altHint = buildAlternativesHint(result.tool.name, availableToolNamesParallel);
              if (altHint) obs = this.truncate(obs, 400) + altHint;
            }
            steps.push({
              tool: result.tool.name,
              args: result.decision.args,
              thought: result.decision.thought,
              observation: this.truncate(obs, OBSERVATION_LIMIT),
            });
            if (depth === 0 && this.intelligence) {
              plan = this.intelligence.updatePlanFromObservation(plan, result.observation);
            }
          }
          if (results.some((r) => r.observation.startsWith('ERROR:'))) {
            budgetState = escalateOnEvent(budgetState, 'tool_error');
          }
          this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          continue;
        }
      }

      await log(`agent-loop paso ${i + 1}/${maxSteps}: ${spec.name}(${JSON.stringify(decision.args).slice(0, 160)}) — ${decision.thought.slice(0, 120)}`, 'loop');
      await this.announceAction(orgId, taskId, spec.name, decision.args);
      if (this.events) {
        await this.events.publish({
          type: 'task.step',
          orgId,
          taskId,
          payload: { thought: decision.thought, tool: spec.name, args: decision.args },
        });
      }

      let observation: string;
      try {
        const guardError = await this.toolGuards(orgId, spec, decision.args, steps, depth, deliveryRequirements);
        if (guardError) {
          observation = guardError;
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

      // P2: on ERROR, append concrete alternative routes so the model pivots
      // immediately instead of retrying the same tool.
      if (observation.startsWith('ERROR:')) {
        const availableToolNames = new Set(stepTools.map((t) => t.name));
        const altHint = buildAlternativesHint(spec.name, availableToolNames);
        if (altHint) observation = this.truncate(observation, 400) + altHint;
      }

      steps.push({
        tool: spec.name,
        args: decision.args,
        thought: decision.thought,
        observation: this.truncate(observation, OBSERVATION_LIMIT),
      });
      if (observation.startsWith('ERROR:')) {
        budgetState = escalateOnEvent(budgetState, 'tool_error');
      } else {
        // Clean step — de-escalate so the easy tail of the run stops paying for
        // the strong model. Mechanical/delivery steps count double.
        budgetState = deescalateOnSuccess(budgetState, { phase });
        if (depth === 0 && this.intelligence) {
          plan = this.intelligence.updatePlanFromObservation(plan, observation);
        }
      }
      this.recordTrajectory(orgId, taskId, goal, steps, 'running', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
    }

    // Out of steps — synthesise an answer from what was gathered instead of failing dry.
    const gathered = steps.filter((s) => !s.observation.startsWith('ERROR:'));
    const missingRequirements = this.missingDeliveryRequirements(steps, deliveryRequirements);
    if (missingRequirements.length > 0) {
      const pendingText = this.deliveryBlockedText(goal, steps, missingRequirements);
      await log(`agent-loop: pasos agotados con entregables pendientes: ${missingRequirements.map((r) => r.label).join(', ')}`, 'loop');
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, pendingText);
      this.recordTrajectory(orgId, taskId, goal, steps, 'degraded', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
      return { ok: false, degraded: true, text: pendingText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
    if (gathered.length === 0) {
      if (depth === 0 && steps.length >= 2) {
        try {
          // R3.2: if this is already a retry (retry_count >= 2), use manual guide (L4) instead of options
          const retryCount = opts.retryContext?.retry_count ?? 0;
          let recoveryText: string;
          let ladderLevel: 3 | 4 | 5 = 3;
          if (retryCount >= 2) {
            ladderLevel = 4;
            recoveryText = await this.generateManualGuide(orgId, taskId, goal, steps);
            await log(`agent-loop: todos los pasos fallaron (retry ${retryCount}) — guía manual L4 generada`, 'loop');
          } else {
            const recovery = await this.synthesizeRecoveryOptions(orgId, taskId, goal, steps);
            tokensUsed += recovery.usage.totalTokens;
            recoveryText = recovery.text.trim();
            await log(`agent-loop: todos los pasos fallaron — respuesta de recuperación con opciones L3 (${tokensUsed} tokens)`, 'loop');
          }
          // R4.2: register capability gap
          if (this.intelligence) {
            await this.intelligence.registerCapabilityGap(orgId, taskId, 'agent_exhausted_steps', goal, ladderLevel).catch(() => undefined);
          }
          this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, recoveryText);
          this.recordTrajectory(orgId, taskId, goal, steps, 'degraded', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
          return { ok: true, degraded: true, text: recoveryText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
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
      if (depth === 0) {
        const nudge = steps.some((s) => s.tool === 'user_steer');
        this.backgroundReview?.scheduleReview({ orgId, taskId, goal, steps, finalText: refinedText, nudge });
      }
      return { ok: true, text: refinedText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    } catch (error) {
      await log(`agent-loop: síntesis falló — ${(error as Error).message}`, 'loop');
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
      this.recordTrajectory(orgId, taskId, goal, steps, 'failed', tokensUsed, depth, startedAt, stallCount, dodRejections, modelBudgetPerStep);
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
  }

  // ── prompt ────────────────────────────────────────────────────────────────

  private buildSystemPrompt(
    opts: AgentLoopOptions,
    tools: ToolSpec[],
    extras: LoopExtras,
    profile?: AgentProfile | null,
    deliveryRequirements: DeliveryRequirement[] = [],
    executionBrief?: string,
  ): string {
    const blocks: string[] = [
      `Eres EVA en modo agente autónomo${opts.role ? `, actuando como ${opts.role}` : ''}. Resuelve el OBJETIVO eligiendo UNA acción por turno.`,
      ...(profile ? [profile.mission] : []),
    ];

    // ── Execution Brief: verified multi-phase plan from powerful model ──
    // Injected only for long tasks where prepareExecution() succeeded.
    // Contains phase-by-phase instructions, required tools/skills, and gap warnings.
    if (executionBrief) {
      blocks.push('', executionBrief);
    }

    // ── Stable tier: Skills index (mandatory — mirrors Hermes prompt_builder.py) ──
    // This block is always present so the model sees ALL available procedural knowledge
    // before deciding anything. Skills encode HOW to do task classes; memory encodes WHO
    // the user is. Never remove or gate this block — it is the procedural memory anchor.
    if (extras.skillsIndexBlock) {
      blocks.push('', extras.skillsIndexBlock);
    }

    blocks.push(
      '',
      'HERRAMIENTAS:',
      ...tools.map((t) => `- ${t.usage}`),
      '- final_answer{"text"}: entrega la respuesta final al usuario (español, directa).',
    );

    // ── Contextual tier: relevant executable skills (code-based, ranked by outcome) ──
    if (extras.skills.length > 0) {
      blocks.push('', 'CATÁLOGO INTELIGENTE DE SKILLS (relevantes para este objetivo):');
      const executableSkills = extras.skills.filter((s) => s.useMode === 'run');
      const guideSkills = extras.skills.filter((s) => s.useMode !== 'run');

      if (executableSkills.length > 0) {
        blocks.push(
          '',
          'SKILLS EJECUTABLES (código ya verificado — relevantes para este objetivo):',
          ...executableSkills.map((s) => {
            const prov = s.isProvisional ? ' [provisional]' : '';
            const reason = s.reason ? `; ${s.reason}` : '';
            return `- ${s.slug}${prov}${reason}: ${s.description}`;
          }),
          'Usa skill_run{"slug":"..."} para ejecutarlas directamente.',
        );
      }
      if (guideSkills.length > 0) {
        blocks.push(
          '',
          'SKILLS GUÍA (carga con skill_view para ver instrucciones completas):',
          ...guideSkills.map((s) => {
            const role = s.agentRole ? `; sub-agente: ${s.agentRole}` : '';
            return `- ${s.slug}${role}: ${s.description}`;
          }),
        );
        const roles = guideSkills
          .filter((s) => s.agentRole)
          .slice(0, 3)
          .map((s) => `${s.slug}→${s.agentRole}`)
          .join(', ');
        if (roles) blocks.push(`DISTRIBUCIÓN SUGERIDA: si delegas, divide por especialidad (${roles}).`);
      }
    }
    if (extras.secretAliases.length > 0) {
      blocks.push(
        '',
        `SECRETS DISPONIBLES (escribe el alias literal en tu código; EVA sustituye el valor al ejecutar y tú NUNCA lo ves): ${extras.secretAliases.join(', ')}`,
      );
    }
    // R2.1: inject capability self-model so the agent knows what's available BEFORE failing
    if (opts.capabilityModel) {
      blocks.push('', opts.capabilityModel);
    }

    if (deliveryRequirements.length > 0) {
      blocks.push(
        '',
        'ENTREGABLES OBLIGATORIOS DETECTADOS:',
        ...deliveryRequirements.map((req, idx) => `${idx + 1}. ${req.label}: ${req.guidance}`),
        'No uses final_answer hasta que todos los entregables obligatorios tengan una observación exitosa de herramienta. Un resumen en texto NO sustituye un archivo ni un envío.',
      );
    }

    // R1.2: inject retry context to avoid repeating failed routes
    if (opts.retryContext) {
      const rc = opts.retryContext;
      blocks.push(
        '',
        'INTENTO PREVIO (esta tarea ya falló antes — usa este contexto):',
        `OBJETIVO ORIGINAL: ${rc.goal}`,
        `CAUSA RAÍZ: ${rc.diagnosis}`,
        `RUTAS YA FALLIDAS (PROHIBIDO repetirlas):\n${rc.trajectory_summary}`,
        `ESTRATEGIA ELEGIDA ESTA VEZ: ${rc.suggested_strategy}`,
        `REINTENTOS ENCADENADOS: ${rc.retry_count} (máx 2; al tercer fallo usa final_answer con guía manual paso a paso)`,
      );
    }

    const has = (name: string) => tools.some((t) => t.name === name);
    blocks.push(
      '',
      'REGLAS:',
      'HORIZONTE Y ESTADOS:',
      '- Clasifica mentalmente cada objetivo antes de actuar: conversacion inmediata, trabajo de minutos, trabajo largo de fondo, tarea programada, espera externa, o accion sensible con approval.',
      '- Si el objetivo debe repetirse, monitorear algo o despertar despues, usa schedule_job_manage en vez de simular una espera dentro del loop.',
      '- Para tareas de acumulación larga (tracking de precios/acciones, estados de archivos, métricas diarias): usa data_log{"action":"write"} al final de cada ejecución del job para guardar el punto de datos del día; un job separado mensual usa data_log{"action":"read","since":"YYYY-MM-01"} para agregar el historial. NO uses memory_recall para datos cuantitativos con timestamps — usa data_log.',
      '- INVESTIGACIÓN / ALTO CONTEXTO: usa dos fases separadas. FASE 1 (recolección): tras cada web_search, análisis o bloque de datos, guarda el hallazgo en scratchpad con key descriptiva (ej. "research:nvidia", "data:precios", "draft:intro"). Mantén la observación del step a 1 línea de resumen. FASE 2 (síntesis): cuando tengas todos los hallazgos, lee scratchpad (sin key para leer todo o por key específica) y genera el entregable final. Esta separación evita que el contexto de trabajo crezca con contenido voluminoso repetido en cada decisión.',
      '- Si falta una decision/dato o la tarea depende de que el usuario o un tercero responda, usa ask_user y deja la tarea pausada; no cierres como completado ni inventes que seguiras mirando.',
      '- Si una accion toca dinero, produccion, datos sensibles, mensajes/envios o cambios de cuenta, prepara la accion y deja que el Approval Engine la autorice.',
      'MEMORIA PROCEDIMENTAL RAIZ:',
      '- Las skills son tu memoria procedimental: HOW hacer clases de tareas. Tratalas como parte de tu operacion base, no como un extra opcional.',
      '- scratchpad = tu bloc de notas para esta tarea. Úsalo para guardar hallazgos largos y evitar cargar el contexto. data_log = series temporales entre jobs. memory_recall = memoria a largo plazo del usuario. Son tres cosas distintas.',
      ...(has('skill_view')
        ? ['- Antes de resolver desde cero, revisa el indice de skills del prompt (## Skills). Si alguna aplica, cargala con skill_view{"slug":"..."} y sigue sus instrucciones.']
        : []),
      ...(has('code_execute') || has('terminal_run')
        ? ['- Usa code_execute/terminal_run para explorarte y corregirte: escribir, ejecutar, observar errores, ajustar y verificar es la ruta normal para mejorar tus propias soluciones.']
        : []),
      ...(has('skill_save') || has('skill_manage')
        ? ['- Tras una tarea compleja, codigo reutilizable o un fix dificil, guarda o parchea el aprendizaje con skill_save/skill_manage antes del final_answer cuando tengas evidencia de que funciona.']
        : []),
      ...(has('delegate')
        ? ['- Objetivos complejos (varias partes, código + datos externos): delega primero a "planeador" para descomponer, ejecuta las subpartes con "investigador"/"programador", y si generaste código sensible o acciones con riesgo, valida con "seguridad" antes del final_answer. Cada sub-agente recibe tus hallazgos previos.']
        : []),
      ...(has('uber_quote')
        ? ['- Tarifas de Uber: usa uber_quote como fuente de verdad. NO uses web_search para estimar viajes de Uber; si uber_quote no muestra tarifa, reporta exactamente su estado/screenshot y pide el dato o login faltante.']
        : []),
      '- Para código: aunque se sugiere dividir en pasos lógicos (inspeccionar→preparar→ejecutar→verificar), sé eficiente para no agotar tus pasos límite. Puedes escribir scripts completos que realicen múltiples acciones (como buscar, crear directorios y descargar) en una sola ejecución de code_execute. Los archivos en /work persisten entre pasos de esta tarea.',
      ...(has('code_execute') && has('telegram_send_file')
        ? ['- Para descargar medios/videos (YouTube, etc.): el sandbox tiene listo yt-dlp y ffmpeg. Escribe un script en code_execute (con "network": true) que use yt-dlp directamente. IMPORTANTE: yt-dlp puede buscar videos por ti sin que busques el enlace antes (ej: usar `yt-dlp --max-downloads 1 --format mp4 "ytsearch1:one piece quinto emperador"` busca y descarga el primer video de esa búsqueda). No malgastes pasos en web_search intentando encontrar enlaces exactos; ¡usa la búsqueda integrada de yt-dlp! Una vez descargado el archivo en /work, usa telegram_send_file para enviarlo de inmediato.']
        : []),
      ...(has('code_execute')
        ? [
            '- SANDBOX libs disponibles (sin pip install): pandas, numpy, requests, pillow, beautifulsoup4, openpyxl, python-dateutil, yt-dlp, reportlab, fpdf2, yfinance, lxml, markdown. PDF: usa `from fpdf import FPDF` (fpdf2) o `from reportlab.platypus import SimpleDocTemplate`. Si falla el import, cambia a la otra — NUNCA pip install más de una vez.',
            ...(has('telegram_send_file')
              ? ['- Reportes/archivos: crea en /work → verifica `os.path.getsize("/work/archivo.pdf") > 0` → envía con telegram_send_file. No uses bytes PDF con offsets hardcodeados.']
              : []),
          ]
        : []),
      '- Si una herramienta devuelve ERROR, NO repitas lo mismo ni te rindas: corrige los args, prueba otra herramienta o un enfoque distinto (ej. web_search si falla una API, code_execute si falla una búsqueda).',
      '- PROHIBIDO pip/npm install en loop: si un `pip install X` falla, NO lo repitas. En su lugar usa una librería ya disponible del sandbox (ver lista arriba). Gastar más de 1 paso en pip install es un ciclo de estancamiento.',
      '- Nunca declares éxito con salida parcial, timeout o un proceso aún corriendo: verifica con una ejecución/lectura antes de final_answer.',
      '- NUNCA inventes salida que ninguna herramienta produjo (datos, contenidos de archivo, respuestas de API). Reportar un bloqueo honesto siempre vale más que un resultado fabricado.',
      ...(has('skill_save')
        ? ['- Cuando un código funcione y resuelva algo no trivial (un fix, un método, un flujo), guárdalo con skill_save ANTES de final_answer. Si una skill que ejecutaste salió mal o desactualizada, corrígela y vuelve a guardarla con el mismo name.']
        : []),
      '- Las herramientas de escritura y envío (como las de enviar archivos, enviar mensajes de WhatsApp, escribir emails, programar tareas recurrentes o agendar calendario) están diseñadas para ejecutar acciones reales. Si el usuario te pide enviar o modificar algo y tienes la herramienta disponible, utilízala directamente sin asumir que tienes prohibido actuar o que debes pedir aprobación manualmente.',
      '- Tienes acceso legítimo y autorizado por el usuario para interactuar con sus cuentas y aplicaciones locales/externas (WhatsApp, Gmail, Calendar, Drive, Uber, Rappi) a través de tus herramientas. NUNCA respondas diciendo que no tienes acceso a información personal, privada o externa. Si tienes la herramienta, úsala y reporta el resultado de forma directa.',
      '- Sé resolutivo y ten iniciativa (alta agencia): si el usuario te pide una tarea (descargar videos, crear carpetas, automatizar flujos, enviar archivos, etc.), ejecútala tú mismo usando code_execute o terminal_run en el sandbox o las herramientas disponibles. Está PROHIBIDO responder dándole instrucciones al usuario para que lo haga manualmente si tienes la capacidad de programar o ejecutar la solución en el sandbox.',
      '- Evita ciclos infinitos de búsqueda (web_search loops): no realices múltiples búsquedas web (web_search) manuales y consecutivas para recopilar información de diferentes entidades o temas. Si el objetivo requiere investigar varios elementos, datos detallados de bolsa, proyectos de múltiples empresas, o cualquier dato en lote, realiza como máximo 2 búsquedas de internet y luego usa code_execute para programar un script de Python que consulte las APIs necesarias o use scraping, o consolide y procese los datos de forma automatizada en un solo paso. Optimiza tus pasos resolviendo mediante scripts.',
      '- PROHIBIDO cerrar con "no se pudo" a secas: si algo queda fuera de tu alcance, tu final_answer DEBE traer lo que SÍ conseguiste + 2-3 opciones concretas numeradas con verbos de acción (ej. "1. Conecta X en Integraciones. 2. Dime los datos Y. 3. Reintenta con Z."). Una lista de opciones o una pregunta directa son obligatorias.',
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
    deliveryRequirements: DeliveryRequirement[] = [],
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
    const missingRequirements = this.missingDeliveryRequirements(steps, deliveryRequirements);
    if (missingRequirements.length > 0) {
      blocks.push(
        '',
        'ENTREGABLES PENDIENTES:',
        ...missingRequirements.map((req, idx) => `${idx + 1}. ${req.label} — usa ${req.tool}.`),
      );
      if (stepsLeft <= Math.max(3, missingRequirements.length + 1)) {
        blocks.push(
          'MODO ENTREGA FINAL: deja de investigar. Usa los hallazgos disponibles, crea los archivos faltantes y envialos. Si el PDF falla por librerias externas, genera un PDF minimo sin dependencias externas o usa herramientas del sistema ya instaladas; NO intentes pip/npm install.',
        );
      }
    }
    if (formatHint) blocks.push('', `ATENCIÓN: ${formatHint}`);

    // Scratchpad reminder: if there are unsaved research findings, nudge the agent.
    const unsavedResearch = steps.filter(
      (s) => RESEARCH_TOOLS.has(s.tool) && !s.observation.startsWith('ERROR:'),
    ).length;
    const hasScratchpadSave = steps.some(
      (s) => s.tool === 'scratchpad' && String(s.args.action ?? '') === 'write',
    );
    if (unsavedResearch >= 1 && !hasScratchpadSave) {
      blocks.push(
        '',
        `⚠️ SCRATCHPAD: tienes ${unsavedResearch} hallazgo(s) de investigación sin guardar. ` +
        'Antes de continuar investigando o generar el entregable, guarda con ' +
        'scratchpad{"action":"write","key":"research:<tema>","content":"<resumen>"}.',
      );
    }

    blocks.push('', `Te quedan ${stepsLeft} acciones. Elige la siguiente acción y responde SOLO con el JSON.`);
    return blocks.join('\n');
  }

  private renderPlan(plan: AgentPlanItem[]): string {
    return plan.map((item) => {
      const marker = item.status === 'done' ? '[✓]' : item.status === 'active' ? '[→]' : '[ ]';
      const ownerTag = item.owner === 'user' ? ' [USUARIO]' : '';
      return `${marker}${ownerTag} ${item.text}`;
    }).join('\n');
  }

  private renderHistory(steps: AgentLoopStep[]): string[] {
    return steps.map((s, idx) => {
      const recent = idx >= steps.length - RECENT_FULL_STEPS;
      if (recent) {
        const args = this.truncate(JSON.stringify(s.args), ARGS_HISTORY_LIMIT);
        // For scratchpad reads in recent steps, still show the content (it's needed for synthesis).
        return `→ ${s.tool}(${args}) ⇒ ${s.observation}`;
      }

      // ── Old steps: aggressive compression ────────────────────────────────
      const argsSummary = this.truncate(JSON.stringify(s.args), 60);

      // scratchpad:read in old steps — don't repeat the content, just the reference.
      if (s.tool === 'scratchpad' && String(s.args.action ?? '') === 'read') {
        const key = String(s.args.key ?? '(all)');
        const chars = s.observation.length;
        return `→ scratchpad(read,"${key}") ⇒ [${chars}c disponibles — usa scratchpad:read si necesitas releer]`;
      }

      // scratchpad:write — show confirmation summary only.
      if (s.tool === 'scratchpad' && String(s.args.action ?? '') === 'write') {
        return `→ scratchpad(write,"${s.args.key ?? ''}") ⇒ ${this.truncate(s.observation, 60)}`;
      }

      // Research tools (web_search, gmail_read, drive_read…): content is expected to be in scratchpad;
      // show only the first meaningful line so the agent knows what was searched/found.
      if (RESEARCH_TOOLS.has(s.tool) && !s.observation.startsWith('ERROR:')) {
        const firstLine = s.observation.split('\n').find((l) => l.trim()) ?? s.observation;
        return `→ [resumido] ${s.tool}(${argsSummary}) ⇒ ${this.truncate(firstLine, 120)} [guarda en scratchpad si no lo hiciste]`;
      }

      let obsSummary = s.observation;
      if (s.observation.startsWith('ERROR:') || s.observation.startsWith('VERIFICACIÓN')) {
        obsSummary = s.observation.trim();
      } else {
        const lines = s.observation.split('\n').map((l) => l.trim()).filter(Boolean);
        obsSummary = lines.length > 2
          ? `${lines[0]} ... ${lines[lines.length - 1]} (${lines.length} líneas)`
          : lines.join('; ');
        obsSummary = this.truncate(obsSummary, 160);
      }
      return `→ [resumido] ${s.tool}(${argsSummary}) ⇒ ${obsSummary}`;
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
    // Tolerant parse: handles ```json fences, trailing commas, prose around the
    // object and truncated/unclosed braces (Agent Zero DirtyJson parity).
    const obj = tryParseDirty(raw);
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

    // pip/npm install loop: ≥2 intentos de instalar algo en los últimos 4 pasos.
    const PIP_RE = /\bpip\s+install\b|\bnpm\s+install\b|\bapt(-get)?\s+install\b/i;
    const recentInstallAttempts = steps.slice(-4).filter(
      (s) => PIP_RE.test(JSON.stringify(s.args)),
    );
    if (recentInstallAttempts.length >= 2) {
      return 'CICLO pip install detectado: intentaste instalar paquetes ≥2 veces. Las librerías necesarias ya están pre-instaladas en el sandbox (reportlab, fpdf2, pandas, pillow…). Usa una de ellas directamente sin pip install.';
    }

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
  /** Returns true when text contains ≥2 numbered/bulleted actionable options OR a direct question. R1.3 */
  private hasActionablePath(text: string): boolean {
    const lines = text.split('\n');
    const actionableRe = /^(\d+[\.\)]\s+|[-•]\s+)[A-ZÁÉÍÓÚ]/;
    const actionCount = lines.filter((l) => actionableRe.test(l.trim())).length;
    if (actionCount >= 2) return true;
    return /\?/.test(text);
  }

  // deriveDeliveryRequirements and missingDeliveryRequirements are thin wrappers
  // so call-sites in this file don't need to change — they delegate to the pure
  // helpers in ./delivery-requirements (P3 refactor).
  private deriveDeliveryRequirements(goal: string): DeliveryRequirement[] {
    return deriveDeliveryRequirements(goal);
  }

  private missingDeliveryRequirements(steps: AgentLoopStep[], requirements: DeliveryRequirement[]): DeliveryRequirement[] {
    return missingDeliveryRequirements(steps, requirements);
  }

  private deliveryBlockedText(goal: string, steps: AgentLoopStep[], missing: DeliveryRequirement[]): string {
    const usefulFindings = steps
      .filter((step) => !step.observation.startsWith('ERROR:') && step.tool !== 'final_answer')
      .slice(-3)
      .map((step) => `- ${step.tool}: ${this.compactObservation(step.observation)}`)
      .join('\n');
    const pending = missing.map((req, idx) => `${idx + 1}. ${req.label}: ${req.guidance}`).join('\n');

    return [
      'No puedo marcar esta tarea como terminada todavía: faltan entregables que el usuario pidió explícitamente.',
      '',
      `Objetivo: ${goal}`,
      usefulFindings ? `\nLo que sí avancé:\n${usefulFindings}` : '',
      `\nPendiente para completarla bien:\n${pending}`,
      '',
      'Reintenta la tarea y priorizaré esos pasos antes de volver a investigar.',
    ].filter(Boolean).join('\n');
  }

  private async validateFinalAnswer(
    text: string,
    steps: AgentLoopStep[],
    criteria: string[],
    orgId: string,
    taskId: string,
    deliveryRequirements: DeliveryRequirement[] = [],
  ): Promise<string | null> {
    // Honest failure reports bypass DoD — they are valid step-level outputs.
    // R1.3 path-enforcement runs at the synthesis/delivery level (synthesizeRecoveryOptions),
    // not here, to avoid a validation loop where the agent can't exit honestly mid-run.
    if (HONEST_FAILURE_RE.test(text)) return null;

    // Si el último paso de código propio falló, no declarar éxito.
    const lastCodeStep = [...steps]
      .reverse()
      .find((s) => s.tool === 'code_execute' || s.tool === 'terminal_run');

    if (lastCodeStep && lastCodeStep.observation.startsWith('ERROR:')) {
      return `El último código falló: "${lastCodeStep.observation.slice(7, 120)}". Verifica y corrige antes de declarar éxito, o reporta el estado real en tu respuesta.`;
    }

    const missingRequirements = this.missingDeliveryRequirements(steps, deliveryRequirements);
    if (missingRequirements.length > 0) {
      return `Faltan entregables obligatorios: ${missingRequirements.map((req) => req.label).join(', ')}. Debes ejecutar ${missingRequirements.map((req) => req.tool).join(' y ')} antes de final_answer.`;
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

  private validateRuntimePolicy(
    toolName: string,
    steps: AgentLoopStep[],
    deliveryRequirements: DeliveryRequirement[] = [],
  ): string | null {
    // ── Web-search budget para tareas con entregables ─────────────────────────
    if (toolName !== 'web_search' || deliveryRequirements.length === 0) return null;
    const webSearches = steps.filter((step) => step.tool === 'web_search' && !step.observation.startsWith('ERROR:')).length;
    if (webSearches < 2) return null;
    return [
      'ERROR: presupuesto de investigación web agotado para esta tarea con entregables.',
      'Ya hiciste 2 búsquedas. Deja de buscar, consolida los hallazgos existentes y usa code_execute para crear/verificar el archivo pendiente; después usa la herramienta de entrega solicitada.',
    ].join(' ');
  }

  /**
   * Pre-execution guards shared by the sequential and parallel dispatch paths:
   * rate-limit → runtime policy → arg validation. Returns the error observation
   * to short-circuit with, or null when the tool is cleared to run. Keeping this
   * in one place avoids the two call sites drifting apart.
   */
  private async toolGuards(
    orgId: string,
    spec: ToolSpec,
    args: Record<string, unknown>,
    steps: AgentLoopStep[],
    depth: number,
    deliveryRequirements: DeliveryRequirement[],
  ): Promise<string | null> {
    const rateLimit = depth === 0 && this.intelligence
      ? await this.intelligence.enforceToolRateLimit(orgId, spec.name)
      : null;
    if (rateLimit) return `ERROR: ${rateLimit}`;
    const policyError = this.validateRuntimePolicy(spec.name, steps, deliveryRequirements);
    if (policyError) return policyError;
    return this.validateToolArgs(spec, args);
  }

  /**
   * Definition-of-done gate for a non-empty `final_answer` candidate: DoD
   * verification first, then security review. Pure validation — no trajectory
   * I/O or budget mutation (the caller applies those), so it is unit-testable in
   * isolation. `text` may be transformed by the security review on accept.
   */
  private async evaluateFinalCandidate(
    orgId: string,
    taskId: string,
    goal: string,
    text: string,
    steps: AgentLoopStep[],
    dodCriteria: string[],
    deliveryRequirements: DeliveryRequirement[],
    depth: number,
    dodRejections: number,
  ): Promise<FinalEvaluation> {
    const dodViolation = dodRejections < MAX_DOD_REJECTIONS && depth === 0
      ? await this.validateFinalAnswer(text, steps, dodCriteria, orgId, taskId, deliveryRequirements)
      : null;
    if (dodViolation) {
      return {
        accept: false,
        event: 'dod_rejection',
        observation: `VERIFICACIÓN FALLIDA: ${dodViolation} Corrige el problema antes de declarar éxito.`,
        logDetail: dodViolation,
      };
    }
    if (depth === 0 && this.intelligence) {
      const review = await this.intelligence.securityReview(orgId, taskId, goal, steps, text).catch(() => ({ ok: true, text }));
      if (!review.ok) {
        return {
          accept: false,
          event: 'security_review',
          observation: `VERIFICACIÓN DE SEGURIDAD FALLIDA: ${review.text}`,
        };
      }
      return { accept: true, text: review.text };
    }
    return { accept: true, text };
  }

  private isBrittleRawPdfSkill(code: string): boolean {
    const normalized = code.toLowerCase();
    const writesPdfLiteral = normalized.includes('%pdf-') && normalized.includes('startxref') && normalized.includes('xref');
    const hardcodedOffsets = /startxref\s*\\?n?\s*\d{2,}/i.test(code)
      || /000000\d{4,}\s+00000\s+n/.test(code);
    const byteStringPdf = /pdf_content\s*=\s*b?["'`]{3}[\s\S]*%PDF-/i.test(code)
      || /open\([^)]*\.pdf[^)]*['"]wb['"][\s\S]*write\(\s*pdf_content/i.test(code);
    return writesPdfLiteral && hardcodedOffsets && byteStringPdf;
  }

  // ── A: adaptive tool loading ──────────────────────────────────────────────

  /**
   * Extracts coarse signals from the goal text to guide phase-based tool selection.
   * Each signal maps to a group of tools that should be included when that signal is present.
   */
  private extractGoalSignals(goal: string): Set<string> {
    const signals = new Set<string>();
    if (/telegram|send.*file|enviar.*archivo/i.test(goal)) signals.add('telegram');
    if (/pdf|documento|informe|reporte|resumen ejecutivo/i.test(goal)) signals.add('file');
    if (/investiga|busca|analiza|research|encuentra|top\s+\d|mejores/i.test(goal)) signals.add('research');
    if (/correo|email|gmail|inbox|bandeja/i.test(goal)) signals.add('email');
    if (/calendario|calendar|agenda|cita|horario/i.test(goal)) signals.add('calendar');
    if (/drive|documento|sheets|slides/i.test(goal)) signals.add('drive');
    if (/código|code|programa|script|python|javascript|typescript/i.test(goal)) signals.add('code');
    if (/recurrente|programar\s+tarea|job|cron|cada\s+d[ií]a|mensual/i.test(goal)) signals.add('schedule');
    if (/whatsapp/i.test(goal)) signals.add('whatsapp');
    if (/uber|rappi|pedido|delivery|comida|casa|trabajo|ubicacion|ubicación|lugar|dirección|direccion/i.test(goal)) signals.add('services');
    if (/bolsa|acciones|stock|precio|finanz/i.test(goal)) signals.add('finance');
    return signals;
  }

  /**
   * Returns the subset of tools to expose to the model for this specific step.
   * Reduces token cost per decide call by ~40-60% without removing any capability
   * — tools re-appear as the task progresses into phases that need them.
   */
  private selectToolsForPhase(
    allTools: ToolSpec[],
    steps: AgentLoopStep[],
    maxSteps: number,
    goalSignals: Set<string>,
    depth: number,
  ): ToolSpec[] {
    // Sub-agents and shallow loops: no filtering, they already have minimal tool sets.
    if (depth > 0 || maxSteps <= 4) return allTools;

    // P5: fail-open — when no domain signals matched AND the task is complex,
    // expose all tools so a missing keyword never silently caps capability.
    // The cost is a slightly larger tool list in the first steps; the benefit is
    // the model never reaches for a tool that isn't there.
    const NO_DOMAIN_SIGNALS = goalSignals.size === 0;
    if (NO_DOMAIN_SIGNALS && maxSteps >= DEFAULT_ROOT_STEPS) return allTools;

    const ratio = steps.length / maxSteps;
    const inResearchPhase = ratio < 0.55;
    const inSynthesisPhase = ratio >= 0.40;

    // Tools used in previous steps are always kept so the agent can course-correct.
    const usedTools = new Set(steps.map((s) => s.tool));

    // Tool groups
    const CORE = new Set([
      'scratchpad', 'code_execute', 'terminal_run', 'terminal_input', 'terminal_output',
      'sandbox_ls', 'ask_user', 'image_analyze', 'memory_recall', 'skill_run', 'skill_view',
      'delegate', 'data_log',
    ]);
    const RESEARCH_GROUP = new Set(['web_search']);
    const DELIVERY_TELEGRAM = new Set(['telegram_send_file']);
    const EMAIL_GROUP = new Set(['gmail_read', 'gmail_write']);
    const CALENDAR_GROUP = new Set(['calendar_read', 'calendar_write']);
    const DRIVE_GROUP = new Set(['drive_read']);
    const SKILLS_ADVANCED = new Set(['skill_save', 'skill_manage', 'script_forge']);
    const SCHEDULE_GROUP = new Set(['schedule_job_manage']);
    const WHATSAPP_GROUP = new Set(['whatsapp_send', 'whatsapp_read']);
    const SERVICES_GROUP = new Set(['uber_quote', 'uber_login', 'rappi_login', 'uber_request_ride', 'known_places_manage']);

    return allTools.filter((t) => {
      if (usedTools.has(t.name)) return true;
      if (CORE.has(t.name)) return true;
      if (RESEARCH_GROUP.has(t.name)) return inResearchPhase || goalSignals.has('research');
      if (DELIVERY_TELEGRAM.has(t.name)) return goalSignals.has('telegram') || goalSignals.has('file') || inSynthesisPhase;
      if (EMAIL_GROUP.has(t.name)) return goalSignals.has('email');
      if (CALENDAR_GROUP.has(t.name)) return goalSignals.has('calendar');
      if (DRIVE_GROUP.has(t.name)) return goalSignals.has('drive');
      if (SKILLS_ADVANCED.has(t.name)) return inSynthesisPhase;
      if (SCHEDULE_GROUP.has(t.name)) return goalSignals.has('schedule') || inSynthesisPhase;
      if (WHATSAPP_GROUP.has(t.name)) return goalSignals.has('whatsapp');
      if (SERVICES_GROUP.has(t.name)) return goalSignals.has('services');
      return true;
    });
  }

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
  // buildToolCatalog() lives in ./tool-catalog.ts — called once in constructor.

  private attachZodSchemas() {
    const schemas = buildZodSchemas();
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

  private validateOutgoingArtifact(filename: string, buffer: Buffer): string | null {
    if (!filename.toLowerCase().endsWith('.pdf')) return null;
    return this.validatePdfArtifact(buffer);
  }

  private validatePdfArtifact(buffer: Buffer): string | null {
    const fail = (reason: string) =>
      `ERROR: el PDF no pasó validación de calidad (${reason}). Regenera el PDF antes de enviarlo: debe abrir con contenido visible, tener texto renderizable y una tabla xref/startxref coherente. No lo envíes todavía.`;

    if (buffer.length < 500) return fail(`archivo demasiado pequeño: ${buffer.length} bytes`);

    const text = buffer.toString('latin1');
    if (!text.slice(0, 1024).includes('%PDF-')) return fail('no tiene cabecera %PDF');
    if (!text.includes('%%EOF')) return fail('falta %%EOF');
    if (!/\/Type\s*\/Page\b/.test(text) && !/\/Pages\b/.test(text)) return fail('no declara páginas PDF');

    const startXrefMatch = /startxref\s+(\d+)/.exec(text);
    if (startXrefMatch) {
      const offset = Number(startXrefMatch[1]);
      const nearOffset = Number.isFinite(offset) && offset >= 0 && offset < buffer.length
        ? text.slice(offset, Math.min(offset + 80, text.length))
        : '';
      if (!nearOffset.startsWith('xref') && !nearOffset.includes('/XRef')) {
        return fail(`startxref apunta a ${offset}, pero ahí no hay tabla xref válida`);
      }
    } else if (!text.includes('/XRef')) {
      return fail('falta startxref/xref');
    }

    const visibleText = this.extractPdfLiteralText(text);
    const hasCompressedContent = /\/Filter\s*\//.test(text) && /\/Contents\b/.test(text) && buffer.length > 2500;
    if (visibleText.length < 60 && !hasCompressedContent) {
      return fail(`muy poco texto visible detectado (${visibleText.length} caracteres)`);
    }

    return null;
  }

  private extractPdfLiteralText(pdfText: string): string {
    const streamBlocks = [...pdfText.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((match) => match[1])
      .join('\n');
    const source = streamBlocks || pdfText;
    const literalStrings = [...source.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)]
      .map((match) => match[0].slice(1, -1).replace(/\\([()\\])/g, '$1'))
      .join(' ');
    return literalStrings.replace(/[^\x20-\x7eáéíóúÁÉÍÓÚñÑüÜ]/g, ' ').replace(/\s+/g, ' ').trim();
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
    const session = typeof args.session === 'number' ? args.session : 0;

    if (args.network === true) {
      if (this.intelligence) {
        const denied = await this.intelligence.validateNetworkAllowlist(orgId, code).catch(() => null);
        if (denied) {
          await this.recordNetworkExec(orgId, taskId, { language, code, allowlistPassed: false, outcome: 'blocked', blockedReason: denied });
          return `ERROR: ${denied}`;
        }
      }
      if (process.env.EVA_SANDBOX_ALLOW_NETWORK === 'true') {
        await this.recordNetworkExec(orgId, taskId, { language, code, allowlistPassed: true, outcome: 'ran_direct' });
        const result = await this.sandbox.execInSession(taskId, { kind: language, code, orgId, network: true, session });
        return this.formatSandboxResult(result);
      }
      if (!this.approvals || !opts.userId) {
        await this.recordNetworkExec(orgId, taskId, { language, code, allowlistPassed: true, outcome: 'blocked', blockedReason: 'no_approval_context' });
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
      await this.recordNetworkExec(orgId, taskId, { language, code, allowlistPassed: true, outcome: 'approval_requested' });
      return `PENDIENTE DE APROBACIÓN: la ejecución con red quedó en Approvals (hash ${approval.action_hash.slice(0, 12)}…). Se ejecutará al aprobarse. Continúa sin red o cierra con final_answer explicando que quedó pendiente.`;
    }

    const result = await this.sandbox.execInSession(taskId, { kind: language, code, orgId, session });
    return this.formatSandboxResult(result);
  }

  /**
   * Telemetría de cumplimiento de red: persiste en task_events cada vez que el
   * modelo pidió ejecutar con red, si pasó el allowlist y el desenlace
   * (ran_direct / approval_requested / blocked). Auditoría de uso de red.
   */
  private async recordNetworkExec(
    orgId: string,
    taskId: string,
    info: { language: string; code: string; allowlistPassed: boolean; outcome: 'ran_direct' | 'approval_requested' | 'blocked'; blockedReason?: string },
  ): Promise<void> {
    try {
      await this.db.admin.from('task_events').insert({
        org_id: orgId,
        task_id: taskId,
        event_type: 'sandbox.network_exec',
        payload: {
          requested: true,
          language: info.language,
          code_preview: info.code.slice(0, 200),
          allowlist_passed: info.allowlistPassed,
          outcome: info.outcome,
          blocked_reason: info.blockedReason ?? null,
        },
      });
    } catch (err) {
      this.logger.debug(`network-exec telemetry skipped: ${(err as Error).message}`);
    }
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
      `OBJETIVO DEL USUARIO: ${goal}\n\nINTENTOS REALIZADOS (ninguno produjo el resultado esperado):\n${attempts}\n\nRedacta en español una respuesta honesta y útil para el usuario: una línea con qué se intentó y por qué no salió, seguida de 2 o 3 opciones concretas y accionables para lograrlo (qué integración conectar, qué dato falta, qué reintentar de otra forma). Formatea las opciones como lista numerada (1. ... 2. ... 3. ...). Nada de disculpas largas ni un "no se pudo" a secas. Las opciones concretas y accionables son OBLIGATORIAS. No inventes resultados.`,
      { orgId, taskId, requestType: 'response', budget: 'cheap', maxTokens: 500, temperature: 0.2 },
    );
  }

  /** R3.2: L4 fallback — step-by-step manual guide leveraging what the trajectory already found. */
  private async generateManualGuide(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[]): Promise<string> {
    const findings = steps
      .filter((s) => !s.observation.startsWith('ERROR:') && s.observation.trim().length > 10)
      .slice(-6)
      .map((s) => `${s.tool}: ${s.observation.slice(0, 300)}`)
      .join('\n');
    const errors = steps
      .filter((s) => s.observation.startsWith('ERROR:'))
      .slice(-3)
      .map((s) => `${s.tool}: ${s.observation.slice(7, 200)}`)
      .join('\n');

    try {
      const res = await this.modelRouter.generate(
        `OBJETIVO: ${goal}\n\nLO QUE EL AGENTE DESCUBRIÓ:\n${findings || '(nada útil recuperado)'}\n\nBLOQUEOS EXACTOS:\n${errors || '(ninguno)'}\n\nGenera una guía manual paso a paso para que el USUARIO lo haga él mismo:\n- Pasos numerados con instrucciones exactas (dónde entrar, qué clic, qué copiar)\n- Qué resultado o dato traer de vuelta\n- Cierra con: "Cuando lo tengas, mándame el resultado o una captura y lo verifico"\n- NUNCA pidas contraseñas ni tokens — pide que el usuario ACTÚE, no que comparta credenciales\n- Español, directo, sin introducción larga`,
        { orgId, taskId, requestType: 'response', budget: 'cheap', maxTokens: 600, temperature: 0.1 },
      );
      return res.text;
    } catch {
      return `No pude ejecutar esto automáticamente. Aquí está el camino manual:\n\n1. Ve al servicio o aplicación que necesitas usar directamente.\n2. Realiza la acción que pediste: ${goal.slice(0, 200)}\n3. Cuando lo tengas, mándame el resultado o una captura y lo verifico.`;
    }
  }

  // ── extras (skills + secrets, solo raíz) ──────────────────────────────────

  private async resolveExtras(orgId: string, goal: string): Promise<LoopExtras> {
    const [skills, secretAliases, skillsIndexBlock] = await Promise.all([
      this.skillLibrary.findRelevant(orgId, goal).catch(() => []),
      this.listSecretAliases(orgId),
      this.skillDocs.getSkillIndexBlock(orgId, { goal }).catch(() => ''),
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
      skillsIndexBlock,
    };
  }

  /**
   * Expand inline-shell snippets (`!\`cmd\``) inside a SKILL.md by running each
   * through the per-task sandbox (Hermes skill_preprocessing.expand_inline_shell,
   * adapted to EVA's container). Execution is gated by the sandbox — rootfs
   * read-only, no network, per-task — so a skill can embed dynamic context
   * (`!\`date\``, `!\`ls /work\``) without arbitrary host access. Bounded to
   * MAX_INLINE_SHELL snippets and MAX_INLINE_SHELL_OUTPUT chars each.
   */
  private async expandSkillInlineShell(content: string, orgId: string, taskId: string): Promise<string> {
    if (!content || !content.includes('!`')) return content;
    const MAX_INLINE_SHELL = 8;
    const MAX_INLINE_SHELL_OUTPUT = 4000;
    const re = /!`([^`\n]+)`/g;
    const matches = [...content.matchAll(re)].slice(0, MAX_INLINE_SHELL);
    if (matches.length === 0) return content;

    let out = content;
    for (const m of matches) {
      const cmd = m[1].trim();
      if (!cmd) { out = out.replace(m[0], ''); continue; }
      let rendered: string;
      try {
        const res = await this.sandbox.execInSession(taskId, { kind: 'terminal', code: cmd, orgId, background: false });
        rendered = res.ok ? (res.output ?? '') : `[inline-shell error: ${(res.output ?? 'falló').slice(0, 200)}]`;
      } catch (err) {
        rendered = `[inline-shell error: ${(err as Error).message.slice(0, 200)}]`;
      }
      if (rendered.length > MAX_INLINE_SHELL_OUTPUT) {
        rendered = rendered.slice(0, MAX_INLINE_SHELL_OUTPUT) + '...[truncado]';
      }
      out = out.replace(m[0], rendered.trimEnd());
    }
    return out;
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

  /**
   * Mid-loop steer — drains any live user messages pushed to a running task and
   * injects each as a synthetic `user_steer` step so the next decide() sees it in
   * history (no restart). Returns true if any were applied, so the caller can bump
   * the model budget one rung (a live redirection deserves a stronger reasoning step).
   * Root-only (depth 0); no-op without the event bus.
   */
  private async applyPendingSteer(
    orgId: string,
    taskId: string,
    depth: number,
    steps: AgentLoopStep[],
    log: (m: string, s: string) => Promise<unknown>,
  ): Promise<boolean> {
    if (depth > 0 || !this.events) return false;
    const messages = await this.events.drainSteer(taskId).catch(() => [] as string[]);
    if (messages.length === 0) return false;
    for (const message of messages) {
      steps.push({
        tool: 'user_steer',
        args: { message },
        thought: 'intervención del usuario',
        observation: `MENSAJE DEL USUARIO (en vivo): ${message}\nAjusta el plan si corresponde; no reinicies lo ya hecho.`,
      });
      await log(`agent-loop: steer del usuario aplicado — "${message.slice(0, 120)}"`, 'loop');
    }
    await this.events.publish({
      type: 'task.steer_applied',
      orgId,
      taskId,
      payload: { taskId, count: messages.length, messages },
    }).catch(() => undefined);
    return true;
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
6. NUNCA generes disculpas de privacidad o de capacidad ("no tengo acceso a aplicaciones externas", "no puedo leer tus mensajes de WhatsApp", etc.). El agente tiene acceso legítimo autorizado por el usuario a través de herramientas y ya las ejecutó. Si la respuesta propuesta contiene información recuperada, preséntala directamente. Si reporta un error real de ejecución, repórtalo, pero nunca niegues tu capacidad general de interactuar con estas aplicaciones.

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
    const isTerminal = outcome === 'ok' || outcome === 'failed' || outcome === 'degraded';
    const op = outcome === 'running'
      ? this.trajectories.checkpoint(snapshot)
      : this.trajectories.complete(snapshot);
    void op
      .then(() => {
        // P1: embed the goal text after the trajectory row is committed so future
        // runs can retrieve similar successes/failures via cosine search.
        // Fire-and-forget — never blocks the response path.
        if (isTerminal) this.embedTrajectoryGoal(orgId, taskId, goal);
      })
      .catch((err) => this.logger.debug(`trajectory record skipped: ${(err as Error).message}`));
  }

  /**
   * P1 — Writes goal_embedding for semantic replay.
   * Fire-and-forget; silently skipped if migration 037 is not yet applied.
   */
  private embedTrajectoryGoal(orgId: string, taskId: string, goal: string): void {
    void this.modelRouter.embed(goal)
      .then(({ embedding }) =>
        this.db.admin
          .from('agent_trajectories')
          .update({ goal_embedding: `[${embedding.join(',')}]` })
          .eq('org_id', orgId)
          .eq('task_id', taskId),
      )
      .catch((err) => this.logger.debug(`trajectory embed skipped: ${(err as Error).message}`));
  }

  private truncate(text: string, limit: number): string {
    const clean = text.trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}… [truncado]`;
  }
}
