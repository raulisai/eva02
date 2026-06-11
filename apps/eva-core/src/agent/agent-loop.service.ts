import { Injectable, Logger, Optional } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDriveService } from './google-drive.service';
import { MissingInformationError, ResearchToolsService } from './research-tools.service';
import { SandboxLanguage, SandboxService } from './sandbox.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { SkillLibraryService } from './skill-library.service';

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
  skills: Array<{ slug: string; description: string }>;
  secretAliases: string[];
}

const MAX_DEPTH = 1;
const OBSERVATION_LIMIT = 1200;
/** Args mostrados en PASOS PREVIOS — el código propio debe verse para poder corregirlo. */
const ARGS_HISTORY_LIMIT = 800;
const DEFAULT_ROOT_STEPS = 6;
const DEFAULT_SUB_STEPS = 3;
/** Two consecutive unparseable decisions → the model/key isn't up to it, bail out. */
const MAX_PARSE_FAILURES = 2;
/** El decide puede traer código literal en args — el cap debe dejarlo respirar. */
const DECIDE_MAX_TOKENS = 1400;
/** Herramientas cuyo uso exitoso amerita memorizar la solución (tipo procedural). */
const CODE_TOOLS = new Set(['code_execute', 'terminal_run', 'script_forge', 'skill_run']);

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
  ) {
    this.tools = this.buildToolCatalog();
  }

  async run(orgId: string, taskId: string, goal: string, opts: AgentLoopOptions = {}): Promise<AgentLoopOutcome> {
    const depth = Math.min(Math.max(opts.depth ?? 0, 0), MAX_DEPTH);
    const maxSteps = Math.min(Math.max(opts.maxSteps ?? (depth === 0 ? DEFAULT_ROOT_STEPS : DEFAULT_SUB_STEPS), 1), 10);
    const log = opts.log ?? (async () => undefined);
    const available = this.tools.filter((t) => !t.rootOnly || depth === 0);
    const extras = depth === 0 ? await this.resolveExtras(orgId, goal) : { skills: [], secretAliases: [] };

    const steps: AgentLoopStep[] = [];
    let tokensUsed = 0;
    let parseFailures = 0;

    await log(`agent-loop${depth > 0 ? ` (sub-agente d${depth})` : ''}: objetivo "${goal.slice(0, 120)}" — máx ${maxSteps} pasos`, 'loop');
    if (extras.skills.length > 0) {
      await log(`agent-loop: ${extras.skills.length} skills relevantes disponibles [${extras.skills.map((s) => s.slug).join(', ')}]`, 'loop');
    }

    for (let i = 0; i < maxSteps; i += 1) {
      let decision: { thought: string; tool: string; args: Record<string, unknown> } | null = null;
      try {
        const res = await this.modelRouter.generate(
          this.buildLoopPrompt(goal, opts, steps, available, maxSteps - i, extras),
          {
            orgId,
            taskId,
            requestType: 'reasoning',
            budget: 'cheap',
            responseFormat: 'json',
            temperature: 0,
            maxTokens: DECIDE_MAX_TOKENS,
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
          return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
        }
        continue;
      }
      parseFailures = 0;

      if (decision.tool === 'final_answer') {
        const text = String(decision.args.text ?? '').trim();
        if (text) {
          await log(`agent-loop: final_answer en paso ${i + 1} (${tokensUsed} tokens de razonamiento)`, 'loop');
          this.maybeMemorizeSolution(orgId, taskId, goal, steps, depth);
          return { ok: true, text, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
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
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
    try {
      const synthesis = await this.modelRouter.generate(
        `OBJETIVO: ${goal}\n\nHALLAZGOS:\n${gathered.map((s) => `[${s.tool}] ${s.observation}`).join('\n\n')}\n\nRedacta la mejor respuesta posible al objetivo usando SOLO los hallazgos. Español, directo.`,
        { orgId, taskId, requestType: 'response', budget: 'cheap', maxTokens: 600, temperature: 0.2 },
      );
      tokensUsed += synthesis.usage.totalTokens;
      await log(`agent-loop: pasos agotados — sintetizando respuesta con ${gathered.length} hallazgos (${tokensUsed} tokens)`, 'loop');
      this.maybeMemorizeSolution(orgId, taskId, goal, steps, depth);
      return { ok: true, text: synthesis.text, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    } catch (error) {
      await log(`agent-loop: síntesis falló — ${(error as Error).message}`, 'loop');
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
  }

  // ── prompt ────────────────────────────────────────────────────────────────

  private buildLoopPrompt(
    goal: string,
    opts: AgentLoopOptions,
    steps: AgentLoopStep[],
    tools: ToolSpec[],
    stepsLeft: number,
    extras: LoopExtras,
  ): string {
    const blocks: string[] = [
      `Eres EVA en modo agente autónomo${opts.role ? `, actuando como ${opts.role}` : ''}. Resuelve el OBJETIVO eligiendo UNA acción por turno.`,
      '',
      `OBJETIVO: ${goal}`,
    ];
    if (opts.context) blocks.push('', `CONTEXTO:\n${opts.context}`);
    blocks.push(
      '',
      'HERRAMIENTAS:',
      ...tools.map((t) => `- ${t.usage}`),
      '- final_answer{"text"}: entrega la respuesta final al usuario (español, directa).',
    );
    if (extras.skills.length > 0) {
      blocks.push(
        '',
        'SKILLS GUARDADAS (reutilízalas con skill_run en vez de reescribir código):',
        ...extras.skills.map((s) => `- ${s.slug}: ${s.description}`),
      );
    }
    if (extras.secretAliases.length > 0) {
      blocks.push(
        '',
        `SECRETS DISPONIBLES (escribe el alias literal en tu código; EVA sustituye el valor al ejecutar y tú NUNCA lo ves): ${extras.secretAliases.join(', ')}`,
      );
    }
    if (steps.length > 0) {
      blocks.push('', 'PASOS PREVIOS:');
      for (const s of steps) {
        blocks.push(`→ ${s.tool}(${this.truncate(JSON.stringify(s.args), ARGS_HISTORY_LIMIT)}) ⇒ ${s.observation}`);
      }
    }
    blocks.push(
      '',
      'REGLAS:',
      '- Antes de resolver desde cero, revisa memory_recall y las SKILLS GUARDADAS.',
      '- Para código: divide en pasos pequeños (inspeccionar→preparar→ejecutar→verificar). Los archivos en /work persisten entre pasos de esta tarea.',
      '- Nunca declares éxito con salida parcial, timeout o un proceso aún corriendo: verifica con una ejecución/lectura antes de final_answer.',
      `- Te quedan ${stepsLeft} acciones. Las herramientas son de solo lectura/sandbox: si el objetivo exige enviar o modificar algo externo, junta la información y explica en final_answer qué quedaría pendiente de aprobación.`,
      'Responde SOLO con JSON: {"thought":"breve","tool":"<nombre>","args":{...}}',
    );
    return blocks.join('\n');
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
    const role = String(args.role ?? '').trim() || undefined;
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
      skills: skills.map((s) => ({ slug: s.slug, description: s.description.slice(0, 90) })),
      secretAliases,
    };
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

  // ── memoria de soluciones (estilo a0: memoriza el "cómo", no el chat) ─────

  private maybeMemorizeSolution(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[], depth: number): void {
    try {
      if (depth !== 0) return;
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

  private toolsUsed(steps: AgentLoopStep[]): string[] {
    return [...new Set(steps.map((s) => s.tool))];
  }

  private truncate(text: string, limit: number): string {
    const clean = text.trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}… [truncado]`;
  }
}
