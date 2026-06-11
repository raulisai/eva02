import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDriveService } from './google-drive.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { MissingInformationError, ResearchToolsService } from './research-tools.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';

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

const MAX_DEPTH = 1;
const OBSERVATION_LIMIT = 1200;
const DEFAULT_ROOT_STEPS = 6;
const DEFAULT_SUB_STEPS = 3;
/** Two consecutive unparseable decisions → the model/key isn't up to it, bail out. */
const MAX_PARSE_FAILURES = 2;

/**
 * AgentLoopService — bucle agéntico genérico (estilo agent-zero):
 * el modelo ve el objetivo + catálogo de herramientas, decide UNA acción por
 * ciclo, observa el resultado y repite hasta dar `final_answer` o agotar pasos.
 *
 * Diseño acotado en costo: decide con presupuesto `cheap` + JSON estricto,
 * observaciones truncadas, pasos limitados, y `delegate` permite UN nivel de
 * sub-agente con menos pasos. Todas las herramientas expuestas son de solo
 * lectura o sandboxeadas (script_forge corre en Docker sin red); las acciones
 * de escritura siguen pasando por los fast-paths con Approval Engine.
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
  ) {
    this.tools = this.buildToolCatalog();
  }

  async run(orgId: string, taskId: string, goal: string, opts: AgentLoopOptions = {}): Promise<AgentLoopOutcome> {
    const depth = Math.min(Math.max(opts.depth ?? 0, 0), MAX_DEPTH);
    const maxSteps = Math.min(Math.max(opts.maxSteps ?? (depth === 0 ? DEFAULT_ROOT_STEPS : DEFAULT_SUB_STEPS), 1), 10);
    const log = opts.log ?? (async () => undefined);
    const available = this.tools.filter((t) => !t.rootOnly || depth === 0);

    const steps: AgentLoopStep[] = [];
    let tokensUsed = 0;
    let parseFailures = 0;

    await log(`agent-loop${depth > 0 ? ` (sub-agente d${depth})` : ''}: objetivo "${goal.slice(0, 120)}" — máx ${maxSteps} pasos`, 'loop');

    for (let i = 0; i < maxSteps; i += 1) {
      let decision: { thought: string; tool: string; args: Record<string, unknown> } | null = null;
      try {
        const res = await this.modelRouter.generate(this.buildLoopPrompt(goal, opts.context, steps, available, maxSteps - i), {
          orgId,
          budget: 'cheap',
          responseFormat: 'json',
          temperature: 0,
          maxTokens: 280,
        });
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
          observation = await this.runDelegate(orgId, taskId, decision.args, depth, log);
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
        { orgId, budget: 'cheap', maxTokens: 600, temperature: 0.2 },
      );
      tokensUsed += synthesis.usage.totalTokens;
      await log(`agent-loop: pasos agotados — sintetizando respuesta con ${gathered.length} hallazgos (${tokensUsed} tokens)`, 'loop');
      return { ok: true, text: synthesis.text, steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    } catch (error) {
      await log(`agent-loop: síntesis falló — ${(error as Error).message}`, 'loop');
      return { ok: false, text: '', steps, tokensUsed, toolsUsed: this.toolsUsed(steps) };
    }
  }

  // ── prompt ────────────────────────────────────────────────────────────────

  private buildLoopPrompt(goal: string, context: string | undefined, steps: AgentLoopStep[], tools: ToolSpec[], stepsLeft: number): string {
    const blocks: string[] = [
      'Eres EVA en modo agente autónomo. Resuelve el OBJETIVO eligiendo UNA acción por turno.',
      '',
      `OBJETIVO: ${goal}`,
    ];
    if (context) blocks.push('', `CONTEXTO:\n${context}`);
    blocks.push(
      '',
      'HERRAMIENTAS:',
      ...tools.map((t) => `- ${t.usage}`),
      '- final_answer{"text"}: entrega la respuesta final al usuario (español, directa).',
    );
    if (steps.length > 0) {
      blocks.push('', 'PASOS PREVIOS:');
      for (const s of steps) {
        blocks.push(`→ ${s.tool}(${JSON.stringify(s.args)}) ⇒ ${s.observation}`);
      }
    }
    blocks.push(
      '',
      `Te quedan ${stepsLeft} acciones. Las herramientas son de solo lectura/sandbox: si el objetivo exige enviar o modificar algo, junta la información y explica en final_answer qué quedaría pendiente de aprobación.`,
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
        usage: 'memory_recall{"query"}: recuerda conversaciones/datos pasados del usuario.',
        execute: async (orgId, _taskId, args) => {
          const query = String(args.query ?? '').trim();
          if (!query) return 'ERROR: memory_recall requiere args.query';
          const memories = await this.memoryAgent.recall(query, orgId, 5, 0.6);
          if (memories.length === 0) return 'Sin memorias relevantes.';
          return memories.map((m) => `[${m.created_at.slice(0, 10)}] ${m.summary}`).join('\n');
        },
      },
      {
        name: 'script_forge',
        usage: 'script_forge{"spec"}: escribe Y ejecuta un script propio en sandbox Docker sin red (cálculos, parsing, generación de archivos).',
        execute: async (orgId, taskId, args) => {
          const spec = String(args.spec ?? '').trim();
          if (!spec) return 'ERROR: script_forge requiere args.spec';
          const outcome = await this.forge.forge(orgId, taskId, spec, async () => undefined);
          return outcome.executed
            ? `Script ${outcome.filename} (${outcome.language}) ejecutado. Salida:\n${outcome.output || '(sin salida)'}`
            : `Script ${outcome.filename} generado pero no ejecutado: ${outcome.note ?? 'sandbox no disponible'}`;
        },
      },
      {
        name: 'delegate',
        usage: 'delegate{"goal"}: delega un sub-objetivo acotado a un sub-agente con sus propias herramientas (divide tareas grandes).',
        rootOnly: true,
        // Real execution lives in runDelegate() — needs depth/log from the caller.
        execute: async () => 'ERROR: delegate no disponible',
      },
    ];
  }

  private async runDelegate(
    orgId: string,
    taskId: string,
    args: Record<string, unknown>,
    depth: number,
    log: (message: string, scope: string) => Promise<unknown>,
  ): Promise<string> {
    const subGoal = String(args.goal ?? '').trim();
    if (!subGoal) return 'ERROR: delegate requiere args.goal';
    if (depth >= MAX_DEPTH) return 'ERROR: profundidad máxima de delegación alcanzada';
    const sub = await this.run(orgId, taskId, subGoal, { depth: depth + 1, maxSteps: DEFAULT_SUB_STEPS, log });
    return sub.ok ? sub.text : `ERROR: el sub-agente no pudo resolver "${subGoal.slice(0, 80)}"`;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private toolsUsed(steps: AgentLoopStep[]): string[] {
    return [...new Set(steps.map((s) => s.tool))];
  }

  private truncate(text: string, limit: number): string {
    const clean = text.trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit)}… [truncado]`;
  }
}
