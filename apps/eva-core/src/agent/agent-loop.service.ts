import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as pathLib from 'node:path';
import { ApprovalsService } from '../approvals/approvals.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
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
}

type ToolExecutor = (orgId: string, taskId: string, args: Record<string, unknown>) => Promise<string>;

interface ToolSpec {
  name: string;
  /** One line shown to the model — keep it short, every char repeats per step. */
  usage: string;
  execute: ToolExecutor;
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

/**
 * AgentLoopService — bucle agéntico genérico (estilo agent-zero):
 * el modelo ve el objetivo + catálogo de herramientas, decide UNA acción por
 * ciclo, observa el resultado y repite hasta dar `final_answer` o agotar pasos.
 *
 * Ejecución de código de primera clase: con `code_execute` el MISMO modelo del
 * loop escribe código literal y lo corre en el sandbox persistente de la tarea
 * (archivos en /work sobreviven entre pasos → escribir→error→corregir real).
 * `terminal_run`/`terminal_output` dan shell incremental y procesos en
 * background; `skill_run` re-ejecuta skills guardadas sin regenerar código.
 *
 * Costo acotado: decide con presupuesto `cheap` + JSON estricto, observaciones
 * truncadas, pasos limitados, y `delegate` permite UN nivel de sub-agente con
 * rol propio. Los writes externos siguen pasando por Approval Engine; la
 * ejecución con red crea una approval en vez de ejecutarse sola.
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
    @Optional() private readonly approvals?: ApprovalsService,
    @Optional() private readonly integrations?: IntegrationsService,
    @Optional() private readonly events?: EventBusService,
  ) {
    this.tools = this.buildToolCatalog();
  }

  async run(orgId: string, taskId: string, goal: string, opts: AgentLoopOptions = {}): Promise<AgentLoopOutcome> {
    const depth = Math.min(Math.max(opts.depth ?? 0, 0), MAX_DEPTH);
    const maxSteps = Math.min(Math.max(opts.maxSteps ?? (depth === 0 ? DEFAULT_ROOT_STEPS : DEFAULT_SUB_STEPS), 1), 10);
    const log = opts.log ?? (async () => undefined);
    const available = this.tools.filter((t) => !t.rootOnly || depth === 0);
    const extras = depth === 0 ? await this.resolveExtras(orgId, goal) : { skills: [], secretAliases: [] };
    // El system (rol + herramientas + skills + secrets + reglas) es idéntico en
    // todos los pasos del run: se calcula UNA vez y se manda como prefijo
    // cacheable. Así no se re-cobran ~600 tokens estáticos por paso.
    const systemPrompt = this.buildSystemPrompt(opts, available, extras);

    const steps: AgentLoopStep[] = [];
    let tokensUsed = 0;
    let parseFailures = 0;

    await log(`agent-loop${depth > 0 ? ` (sub-agente d${depth})` : ''}: objetivo "${goal.slice(0, 120)}" — máx ${maxSteps} pasos`, 'loop');
    if (extras.skills.length > 0) {
      await log(`agent-loop: ${extras.skills.length} skills relevantes disponibles [${extras.skills.map((s) => s.slug).join(', ')}]`, 'loop');
      if (depth === 0) {
        await this.skillLibrary.beginSelection(orgId, { goal, selected: extras.skills }).catch((err) => {
          this.logger.debug(`skill beginSelection skipped: ${(err as Error).message}`);
        });
      }
    }

    for (let i = 0; i < maxSteps; i += 1) {
      // Check if the task was cancelled by the user in the database
      const { data: currentTask } = await this.db.admin
        .from('tasks')
        .select('status')
        .eq('id', taskId)
        .eq('org_id', orgId)
        .maybeSingle();

      if (currentTask?.status === 'cancelled') {
        throw new TaskCancelledError();
      }

      let decision: { thought: string; tool: string; args: Record<string, unknown> } | null = null;
      try {
        const res = await this.modelRouter.generate(
          this.buildUserPrompt(goal, opts.context, steps, maxSteps - i),
          {
            orgId,
            taskId,
            requestType: 'reasoning',
            budget: 'cheap',
            responseFormat: 'json',
            temperature: 0,
            maxTokens: DECIDE_MAX_TOKENS,
            systemPrompt,
            cacheSystem: true,
          },
        );
        tokensUsed += res.usage.totalTokens;
        decision = this.parseDecision(res.text);
      } catch (error) {
        await log(`agent-loop: decide falló — ${(error as Error).message}`, 'loop');
      }

      if (!decision) {
        parseFailures += 1;
        if (parseFailures >= MAX_PARSE_FAILURES) {
          await log('agent-loop: el modelo no produjo decisiones válidas — abortando bucle', 'loop');
          this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
          return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
        }
        continue;
      }
      parseFailures = 0;

      if (decision.tool === 'final_answer') {
        const text = String(decision.args.text ?? '').trim();
        if (text) {
          await log(`agent-loop: final_answer en paso ${i + 1} (${tokensUsed} tokens de razonamiento)`, 'loop');
          const refinedText = depth === 0 ? await this.refineAndValidateResponse(orgId, taskId, goal, text) : text;
          this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, true, refinedText);
          this.maybeMemorizeSolution(orgId, taskId, goal, steps, depth);
          return { ok: true, text: refinedText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
        }
        steps.push({ tool: decision.tool, args: decision.args, thought: decision.thought, observation: 'ERROR: final_answer sin texto. Incluye args.text.' });
        continue;
      }

      const spec = available.find((t) => t.name === decision!.tool);
      if (!spec) {
        steps.push({
          tool: decision.tool, args: decision.args, thought: decision.thought,
          observation: `ERROR: herramienta desconocida "${decision.tool}". Usa una de: ${available.map((t) => t.name).join(', ')}, final_answer.`,
        });
        continue;
      }

      // Loop guard — same tool + same args as the previous step is a stall.
      const prev = steps[steps.length - 1];
      if (prev && prev.tool === spec.name && JSON.stringify(prev.args) === JSON.stringify(decision.args)) {
        steps.push({
          tool: spec.name, args: decision.args, thought: decision.thought,
          observation: 'ERROR: acción repetida idéntica al paso anterior. Cambia de herramienta/args o entrega final_answer con lo que ya tienes.',
        });
        continue;
      }

      await log(`agent-loop paso ${i + 1}/${maxSteps}: ${spec.name}(${JSON.stringify(decision.args).slice(0, 160)}) — ${decision.thought.slice(0, 120)}`, 'loop');
      await this.announceAction(orgId, taskId, spec.name, decision.args);

      let observation: string;
      try {
        if (spec.name === 'delegate') {
          observation = await this.runDelegate(orgId, taskId, decision.args, depth, opts, log);
        } else if (spec.name === 'code_execute') {
          observation = await this.runCodeExecute(orgId, taskId, decision.args, opts);
        } else {
          observation = await spec.execute(orgId, taskId, decision.args);
        }
      } catch (error) {
        // Forms for missing info must bubble up to agent-runner untouched.
        if (error instanceof MissingInformationError) throw error;
        observation = `ERROR: ${(error as Error).message.slice(0, 300)}`;
      }

      steps.push({
        tool: spec.name,
        args: decision.args,
        thought: decision.thought,
        observation: this.truncate(observation, OBSERVATION_LIMIT),
      });
    }

    // Out of steps — synthesise an answer from what was gathered instead of failing dry.
    const gathered = steps.filter((s) => !s.observation.startsWith('ERROR:'));
    if (gathered.length === 0) {
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
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
      return { ok: true, text: refinedText, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    } catch (error) {
      await log(`agent-loop: síntesis falló — ${(error as Error).message}`, 'loop');
      this.recordSkillOutcome(orgId, taskId, goal, extras.skills, steps, false, '');
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
  }

  // ── prompt ────────────────────────────────────────────────────────────────

  /**
   * Bloque ESTÁTICO del run: rol + catálogo de herramientas + skills + secrets
   * + reglas. Idéntico en todos los pasos → se manda como systemPrompt cacheable
   * para no re-cobrar tokens de entrada en cada decisión.
   */
  private buildSystemPrompt(opts: AgentLoopOptions, tools: ToolSpec[], extras: LoopExtras): string {
    const blocks: string[] = [
      `Eres EVA en modo agente autónomo${opts.role ? `, actuando como ${opts.role}` : ''}. Resuelve el OBJETIVO eligiendo UNA acción por turno.`,
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
          return `- ${s.slug} [${s.source ?? 'unknown'}, ${mode}${role}${reason}]: ${s.description}`;
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
    blocks.push(
      '',
      'REGLAS:',
      '- Antes de resolver desde cero, revisa memory_recall y el CATÁLOGO INTELIGENTE DE SKILLS.',
      '- Para código: divide en pasos pequeños (inspeccionar→preparar→ejecutar→verificar). Los archivos en /work persisten entre pasos de esta tarea.',
      '- Si una herramienta devuelve ERROR, NO repitas lo mismo ni te rindas: corrige los args, prueba otra herramienta o un enfoque distinto (ej. web_search si falla una API, code_execute si falla una búsqueda).',
      '- Nunca declares éxito con salida parcial, timeout o un proceso aún corriendo: verifica con una ejecución/lectura antes de final_answer.',
      '- NUNCA inventes salida que ninguna herramienta produjo (datos, contenidos de archivo, respuestas de API). Reportar un bloqueo honesto siempre vale más que un resultado fabricado.',
      '- Cuando un código funcione y resuelva algo no trivial (un fix, un método, un flujo), guárdalo con skill_save ANTES de final_answer. Si una skill que ejecutaste salió mal o desactualizada, corrígela y vuelve a guardarla con el mismo name.',
      '- Las herramientas son de solo lectura/sandbox: si el objetivo exige enviar o modificar algo externo, junta la información y explica en final_answer qué quedaría pendiente de aprobación.',
      '- PROHIBIDO cerrar con "no se pudo" a secas: si algo queda fuera de tu alcance, tu final_answer debe traer lo que SÍ conseguiste + 2-3 opciones concretas de solución (qué reintentar, qué conectar, qué harías tú en el siguiente paso).',
      'Responde SOLO con JSON: {"thought":"breve","tool":"<nombre>","args":{...}}',
    );
    return blocks.join('\n');
  }

  /**
   * Parte DINÁMICA: objetivo + contexto + historial de pasos + acciones
   * restantes. Es lo único que cambia entre pasos, así que es lo único que
   * paga tokens nuevos. Las observaciones viejas van compactadas.
   */
  private buildUserPrompt(goal: string, context: string | undefined, steps: AgentLoopStep[], stepsLeft: number): string {
    const blocks: string[] = [`OBJETIVO: ${goal}`];
    if (context) blocks.push('', `CONTEXTO:\n${context}`);
    if (steps.length > 0) {
      blocks.push('', 'PASOS PREVIOS:', ...this.renderHistory(steps));
    }
    blocks.push('', `Te quedan ${stepsLeft} acciones. Elige la siguiente acción y responde SOLO con el JSON.`);
    return blocks.join('\n');
  }

  /**
   * Historial con fidelidad decreciente: las últimas RECENT_FULL acciones se
   * muestran completas (el modelo aún razona sobre ellas); las anteriores se
   * comprimen a una línea. Evita el crecimiento O(n²) del prompt por paso.
   */
  private renderHistory(steps: AgentLoopStep[]): string[] {
    return steps.map((s, idx) => {
      const recent = idx >= steps.length - RECENT_FULL_STEPS;
      const args = this.truncate(JSON.stringify(s.args), recent ? ARGS_HISTORY_LIMIT : 100);
      const obs = recent ? s.observation : this.compactObservation(s.observation);
      return `→ ${s.tool}(${args}) ⇒ ${obs}`;
    });
  }

  private compactObservation(obs: string): string {
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

  // ── tools ─────────────────────────────────────────────────────────────────

  private buildToolCatalog(): ToolSpec[] {
    return [
      {
        name: 'web_search',
        usage: 'web_search{"query"}: busca en internet/APIs públicas (clima, noticias, precios, lugares, datos actuales).',
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
        execute: async (orgId, _taskId, args) => {
          const query = String(args.query ?? '').trim();
          if (!query) return 'ERROR: memory_recall requiere args.query';
          const memories = await this.memoryAgent.recall(query, orgId, 5, 0.6);
          if (memories.length === 0) return 'Sin memorias relevantes.';
          return memories.map((m) => `[${m.created_at.slice(0, 10)}] ${m.summary}`).join('\n');
        },
      },
      {
        name: 'code_execute',
        usage: 'code_execute{"language":"python|node|bash","code"}: ejecuta TU código literal en el sandbox de la tarea. /work persiste entre pasos; imprime resultados por stdout. Sin red (args opcional "network":true requiere aprobación humana). Python incluye requests/pandas/numpy si la imagen eva-sandbox está instalada.',
        // Real execution lives in runCodeExecute() — needs userId from opts for approvals.
        execute: async () => 'ERROR: code_execute no disponible',
      },
      {
        name: 'terminal_run',
        usage: 'terminal_run{"cmd","background"?}: comando de shell en el sandbox de la tarea (cwd /work). background:true para procesos largos; léelos con terminal_output.',
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
        execute: async (_orgId, taskId) => {
          const result = await this.sandbox.readBackgroundOutput(taskId);
          return this.formatSandboxResult(result);
        },
      },
      {
        name: 'skill_run',
        usage: 'skill_run{"slug"}: re-ejecuta una skill guardada (código ya probado) en el sandbox, sin regenerarla.',
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
        usage: 'delegate{"goal","role"?}: delega un sub-objetivo acotado a un sub-agente con rol propio (ej. "investigador", "programador"). Divide tareas grandes; no delegues el objetivo completo.',
        rootOnly: true,
        // Real execution lives in runDelegate() — needs depth/log from the caller.
        execute: async () => 'ERROR: delegate no disponible',
      },
      {
        name: 'image_analyze',
        usage: 'image_analyze{"path","prompt"?}: analiza una imagen (captura de pantalla, foto, etc.) guardada en el sandbox (ruta relativa o absoluta) o desde una URL pública, usando un modelo de visión para extraer texto, leer códigos o resolver dudas contextuales.',
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
    ];
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
      if (process.env.EVA_SANDBOX_ALLOW_NETWORK === 'true') {
        const result = await this.sandbox.runOneShot({ language, code, orgId, network: true });
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
  ): Promise<string> {
    const subGoal = String(args.goal ?? '').trim();
    if (!subGoal) return 'ERROR: delegate requiere args.goal';
    if (depth >= MAX_DEPTH) return 'ERROR: profundidad máxima de delegación alcanzada';
    let role = String(args.role ?? '').trim() || undefined;
    if (!role) {
      const [suggested] = await this.skillLibrary.findRelevant(orgId, subGoal, 1).catch(() => []);
      role = suggested?.agentRole;
    }
    const sub = await this.run(orgId, taskId, subGoal, {
      depth: depth + 1, maxSteps: DEFAULT_SUB_STEPS, role, userId: opts.userId, log,
    });
    return sub.ok ? sub.text : `ERROR: el sub-agente no pudo resolver "${subGoal.slice(0, 80)}"`;
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

  // ── sedimentación (estilo hermes: cada run exitoso deja conocimiento) ────

  /**
   * Auto-sedimentación de skills: si el run resolvió con código y el modelo
   * NO guardó nada explícitamente (skill_save/script_forge), el último
   * code_execute exitoso se registra solo como skill + artifact. Es el
   * "a pass that does nothing is a missed learning opportunity" del
   * background review de hermes, sin un segundo agente: el trabajo probado
   * nunca se pierde. SkillGuard sigue siendo el gate.
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
      })
      .then(async (result) => {
        if (!result.ok) {
          this.logger.debug(`auto-skill skipped: ${result.reason}`);
          return;
        }
        this.logger.log(`auto-skill "${result.slug}" v${result.version} sedimentada de la tarea ${taskId}`);
        await this.saveArtifact(orgId, taskId, `${result.slug}.${language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh'}`, code, {
          language, skill_slug: result.slug, origin: 'agent-loop-auto',
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

  private truncate(text: string, limit: number): string {
    const clean = text.trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}… [truncado]`;
  }
}
