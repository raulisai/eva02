import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { ToolRouterService } from '../tool-router/tool-router.service';
import { TasksService } from '../tasks/tasks.service';
import { Task } from '../tasks/task.types';
import { MediaService } from './media.service';
import { MissingInformationError, ResearchToolsService } from './research-tools.service';
import { ScriptForgeService } from './script-forge.service';
import { classifyTier } from './tier';

/**
 * Immediate spoken acknowledgments — EVA answers in <100ms with one of these
 * while the real work happens, so the user always knows she heard them.
 */
const ACK_RULES: Array<{ pattern: RegExp; say: string; hint: string }> = [
  {
    pattern: /\b(busca|buscar|búsqueda|search|internet|noticias|news|precio|clima|weather|cotiza|tipo de cambio)\b/i,
    say: 'Dame un momento, voy a buscar en internet 🔎',
    hint: 'search',
  },
  {
    pattern: /\b(revisa|revisar|correo|email|mail|mensajes|notificaciones|bandeja|inbox)\b/i,
    say: 'Déjame revisar, te aviso en un momento 📬',
    hint: 'review',
  },
  {
    pattern: /\b(analiza|analizar|piensa|plan|planea|estrategia|compara|evalúa|diseña|resume|resumen)\b/i,
    say: 'Déjame pensar en esto un momento 🤔',
    hint: 'think',
  },
  {
    pattern: /\b(compra|comprar|paga|pagar|transfiere|deploy|producción|borra|elimina|delete)\b/i,
    say: 'Esto toca dinero/producción — lo preparo y te pido aprobación 🛡️',
    hint: 'sensitive',
  },
];

const DEFAULT_ACK = { say: 'Enseguida, ya estoy en ello ⚙️', hint: 'default' };

const LONG_TASK_ACK =
  'Esto va a tomar un rato — lo estoy atendiendo en segundo plano 🛠️. '
  + 'Puedes seguir hablándome mientras tanto; te aviso cuando termine.';

const SYSTEM_PROMPT = `Eres EVA, un agente operativo. Responde SIEMPRE en español,
de forma directa y concisa (máximo ~120 palabras salvo que pidan detalle).
Si la orden requiere acciones externas que no puedes ejecutar todavía, explica
exactamente qué harías paso a paso.`;

const CHAT_PROMPT = `Eres EVA, asistente personal. Conversación casual: responde en español,
cálida y breve (1-3 frases). Sin listas ni formalidades.`;

const RESEARCH_PLANNER_PROMPT = `Eres el planificador de busqueda de EVA.
Convierte la peticion del usuario en la busqueda mas eficiente para internet o APIs publicas.
Debes distinguir contexto, tema, ubicacion, fecha/ventana temporal, entidad principal e idioma.
No respondas la pregunta final. Solo decide como buscar.

Responde JSON estricto:
{
  "query": "consulta optimizada, concreta y sin relleno",
  "intent": "weather|news|price|lookup|research|api",
  "source_hint": "chromium|public_api|both",
  "reason": "una frase breve"
}`;

const USELESS_ANSWER_PATTERNS = [
  /\bno (tengo|cuento con) acceso\b/i,
  /\bno puedo (acceder|consultar|buscar|navegar|verificar)\b/i,
  /\bcomo (modelo|ia|inteligencia artificial)\b/i,
  /\bconsulta (una app|un sitio|una aplicaci[oó]n|fuentes externas)\b/i,
  /\binformaci[oó]n en tiempo real\b/i,
  /\bno dispongo de informaci[oó]n actualizada\b/i,
];

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly events: EventBusService,
    private readonly tasks: TasksService,
    private readonly intentRouter: IntentRouterService,
    private readonly modelRouter: ModelRouterService,
    private readonly toolRouter: ToolRouterService,
    private readonly media: MediaService,
    private readonly research: ResearchToolsService,
    private readonly forge: ScriptForgeService,
  ) {}

  onApplicationBootstrap() {
    if (typeof this.events.on !== 'function') return; // test stub without consumer
    // Decoupled trigger: any task.created on the bus gets processed here.
    this.events.on('task.created', async (event) => {
      if (!event.taskId) return;
      await this.run(event.orgId, event.taskId);
    });
    this.logger.log('Agent runner subscribed to task.created');
  }

  /** Picks the instant acknowledgment phrase for an order. */
  pickAck(text: string): { say: string; hint: string } {
    return ACK_RULES.find(({ pattern }) => pattern.test(text)) ?? DEFAULT_ACK;
  }

  async run(orgId: string, taskId: string): Promise<void> {
    let task: Task;
    try {
      task = await this.tasks.getTask(taskId, orgId);
    } catch {
      return; // task vanished — nothing to do
    }
    if (task.status !== 'pending') return;

    const input = task.description ?? task.title;
    const startedAt = Date.now();
    const tier = classifyTier(input);

    try {
      // ── Tier: chat — straight to the model, no pipeline overhead ──
      if (tier.tier === 'chat') {
        await this.tasks.transition(taskId, orgId, 'planning');
        await this.tasks.transition(taskId, orgId, 'running');
        await this.log(orgId, taskId, `tier=chat (${tier.reason}) — direct model, cheap tier`, 'pipeline');
        const t0 = Date.now();
        const reply = await this.modelRouter.generate(input, {
          orgId, budget: 'cheap', maxTokens: 300, systemPrompt: CHAT_PROMPT,
        });
        await this.deliver(orgId, taskId, reply.text, reply.model, Date.now() - t0);
        await this.log(orgId, taskId, `chat answered in ${Date.now() - startedAt}ms`, 'pipeline');
        return;
      }

      // ── Tier: quick (<1 min) — short "espera" + do it ──
      // ── Tier: long (>1 min) — background notice, chat stays free ──
      const ack = tier.tier === 'long'
        ? { say: LONG_TASK_ACK, hint: 'background' }
        : this.pickAck(input);
      await this.say(orgId, taskId, ack.say);
      await this.log(
        orgId, taskId,
        `tier=${tier.tier} est ~${tier.estimateSec}s (${tier.reason}) — ack "${ack.hint}" in ${Date.now() - startedAt}ms`,
        'pipeline',
      );

      await this.tasks.transition(taskId, orgId, 'planning');
      const intent = await this.intentRouter.classify(input, orgId, { taskId });
      await this.log(
        orgId, taskId,
        `intent=${intent.intent} (${intent.classifier}, confidence ${intent.confidence.toFixed(2)}) — ${intent.reasons.join('; ') || 'no signals'}`,
        'intent',
      );

      await this.tasks.transition(taskId, orgId, 'running');

      // Sensitive orders stop at the approval gate — never auto-executed.
      if (intent.intent === 'core_path_approval') {
        await this.tasks.transition(taskId, orgId, 'waiting_for_approval');
        await this.say(orgId, taskId, 'Necesito tu aprobación para continuar — revisa la bandeja de Approvals 🛡️');
        await this.log(orgId, taskId, 'parked at approval gate (L2 action)', 'approval');
        return;
      }

      // Long + code/automation → EVA writes and sandboxes her own script
      if (tier.tier === 'long' && this.forge.isScriptTask(input)) {
        const outcome = await this.forge.forge(orgId, taskId, input, (message, scope) => this.log(orgId, taskId, message, scope));
        const summary = [
          `Generé el script **${outcome.filename}** (${outcome.language}): ${outcome.description}`,
          outcome.skillSlug ? `Quedó registrado como skill \`${outcome.skillSlug}\` y como artifact.` : 'Quedó guardado como artifact.',
          outcome.executed
            ? `Lo ejecuté en un sandbox Docker (sin red) y esta fue la salida:\n\n${outcome.output || '(sin salida)'}`
            : outcome.note ?? '',
        ].filter(Boolean).join('\n\n');
        await this.deliver(orgId, taskId, summary, 'script-forge', Date.now() - startedAt);
        await this.maybeAttachMedia(orgId, taskId, input, summary);
        await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
        return;
      }

      // Tool routing (transparent dry-run of what executes this)
      const capability = ack.hint === 'search' ? 'search' : 'generate';
      try {
        const route = this.toolRouter.route(capability);
        await this.log(
          orgId, taskId,
          `tool-router: capability "${capability}" → ${route.tool.name} (score ${route.score.toFixed(3)}, ~${route.tool.avgLatencyMs}ms)`,
          'tools',
        );
      } catch {
        await this.log(orgId, taskId, `tool-router: no tool for "${capability}", going straight to the model`, 'tools');
      }

      if (ack.hint === 'search') {
        await this.log(orgId, taskId, 'buscando en internet con Chromium… (web-search tool)', 'web');
        const researchInput = await this.planResearchInput(orgId, taskId, input);
        const t0 = Date.now();
        const answer = await this.research.answer(researchInput, orgId);
        const elapsed = Date.now() - t0;
        await this.log(orgId, taskId, `tool ${answer.tool} answered in ${elapsed}ms`, 'tools');
        await this.deliver(orgId, taskId, answer.text, answer.tool, elapsed);
        await this.maybeAttachMedia(orgId, taskId, input, answer.text);
        await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
        return;
      }

      // Model call — quick rides the cheap tier for speed
      const budget = tier.tier === 'quick' ? 'cheap' : 'balanced';
      await this.log(orgId, taskId, `calling model (budget=${budget}, org keys first, env fallback)…`, 'model');
      const t0 = Date.now();
      const result = await this.modelRouter.generate(input, {
        orgId,
        budget,
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: tier.tier === 'long' ? 1200 : 700,
      });
      const elapsed = Date.now() - t0;
      await this.log(
        orgId, taskId,
        `model ${result.model} (${result.backend}) answered in ${elapsed}ms — ${result.usage.totalTokens} tokens`,
        'model',
      );

      if (this.isUselessAnswer(result.text)) {
        await this.log(orgId, taskId, 'model answer rejected as non-actionable; trying project tools', 'model');
        const recovered = await this.recoverWithTools(orgId, taskId, input, startedAt);
        if (recovered) return;
      }

      await this.deliver(orgId, taskId, result.text, result.model, elapsed);
      await this.maybeAttachMedia(orgId, taskId, input, result.text);
      await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
    } catch (error) {
      if (error instanceof MissingInformationError) {
        await this.requestMissingInformation(orgId, taskId, error);
        return;
      }
      const message = (error as Error).message;
      this.logger.error(`Agent run failed for task ${taskId}: ${message}`);
      await this.log(orgId, taskId, `ERROR: ${message}`, 'pipeline');
      await this.failSafely(orgId, taskId, message);
    }
  }

  /** Final answer event + completed transition with the result persisted. */
  private async deliver(orgId: string, taskId: string, text: string, model: string, latencyMs: number) {
    await this.events.publish({
      type: 'task.result',
      orgId,
      taskId,
      payload: { text, model, latency_ms: latencyMs },
    });
    await this.tasks.transition(taskId, orgId, 'completed', {
      result: { text, model, latency_ms: latencyMs },
    });
  }

  /** Image/audio attachments when the order asks for them (bucket + task.media). */
  private async maybeAttachMedia(orgId: string, taskId: string, input: string, answer: string) {
    if (this.media.wantsImage(input)) {
      await this.log(orgId, taskId, 'generando imagen (SVG) y subiendo al bucket eva-media…', 'media');
      const url = await this.media.sendImage(orgId, taskId, input);
      await this.log(orgId, taskId, url ? `imagen lista: ${url}` : 'no se pudo generar la imagen', 'media');
    }
    if (this.media.wantsAudio(input)) {
      await this.log(orgId, taskId, 'generando audio (TTS) y subiendo al bucket eva-media…', 'media');
      const url = await this.media.sendAudio(orgId, taskId, answer);
      await this.log(orgId, taskId, url ? `audio listo: ${url}` : 'audio no disponible (falta key de OpenAI)', 'media');
    }
  }

  private isUselessAnswer(text: string): boolean {
    return USELESS_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
  }

  private async recoverWithTools(orgId: string, taskId: string, input: string, startedAt: number): Promise<boolean> {
    const errors: string[] = [];

    if (this.forge.isScriptTask(input)) {
      try {
        await this.log(orgId, taskId, 'recovery: intentando script-forge en sandbox', 'tools');
        const outcome = await this.forge.forge(orgId, taskId, input, (message, scope) => this.log(orgId, taskId, message, scope));
        const summary = [
          `Generé el script **${outcome.filename}** (${outcome.language}): ${outcome.description}`,
          outcome.skillSlug ? `Quedó registrado como skill \`${outcome.skillSlug}\` y como artifact.` : 'Quedó guardado como artifact.',
          outcome.executed
            ? `Lo ejecuté en un sandbox Docker (sin red) y esta fue la salida:\n\n${outcome.output || '(sin salida)'}`
            : outcome.note ?? '',
        ].filter(Boolean).join('\n\n');
        await this.deliver(orgId, taskId, summary, 'script-forge', Date.now() - startedAt);
        return true;
      } catch (error) {
        errors.push(`script-forge: ${(error as Error).message}`);
      }
    }

    if (this.research.canAnswer(input)) {
      try {
        await this.log(orgId, taskId, 'recovery: buscando con Chromium / APIs publicas', 'tools');
        const researchInput = await this.planResearchInput(orgId, taskId, input);
        const t0 = Date.now();
        const answer = await this.research.answer(researchInput, orgId);
        const elapsed = Date.now() - t0;
        await this.log(orgId, taskId, `recovery tool ${answer.tool} answered in ${elapsed}ms`, 'tools');
        await this.deliver(orgId, taskId, answer.text, answer.tool, elapsed);
        await this.maybeAttachMedia(orgId, taskId, input, answer.text);
        await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
        return true;
      } catch (error) {
        if (error instanceof MissingInformationError) {
          await this.requestMissingInformation(orgId, taskId, error);
          return true;
        }
        errors.push(`research: ${(error as Error).message}`);
      }
    }

    await this.log(
      orgId,
      taskId,
      `all recovery tools failed: ${errors.join(' | ') || 'no tool accepted the request'}`,
      'tools',
    );
    const text = [
      'No voy a cerrar esta tarea con una respuesta genérica del modelo.',
      'Intenté resolverla con las herramientas disponibles del proyecto, pero todas fallaron.',
      errors.length > 0 ? `Errores: ${errors.join(' | ')}` : 'No hubo una herramienta aplicable.',
      'Siguiente acción: agrega una integración/API en Credentials o define una ruta de herramienta específica para esta capacidad, y la tarea se puede reintentar.',
    ].join('\n');
    await this.deliver(orgId, taskId, text, 'tool-recovery', Date.now() - startedAt);
    return true;
  }

  private async planResearchInput(orgId: string, taskId: string, input: string): Promise<string> {
    try {
      const result = await this.modelRouter.generate(input, {
        orgId,
        budget: 'cheap',
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 220,
        systemPrompt: RESEARCH_PLANNER_PROMPT,
      });
      const parsed = JSON.parse(result.text) as {
        query?: unknown;
        intent?: unknown;
        source_hint?: unknown;
        reason?: unknown;
      };
      const query = typeof parsed.query === 'string' && parsed.query.trim().length > 0
        ? parsed.query.trim()
        : input;
      await this.log(
        orgId,
        taskId,
        `research-plan: query="${query}" intent=${String(parsed.intent ?? 'unknown')} source=${String(parsed.source_hint ?? 'unknown')} — ${String(parsed.reason ?? 'no reason')}`,
        'tools',
      );
      return query;
    } catch (error) {
      await this.log(orgId, taskId, `research-plan failed; using original input — ${(error as Error).message}`, 'tools');
      return input;
    }
  }

  private say(orgId: string, taskId: string, text: string) {
    return this.events.publish({ type: 'task.say', orgId, taskId, payload: { text } });
  }

  private async requestMissingInformation(orgId: string, taskId: string, error: MissingInformationError) {
    await this.log(orgId, taskId, `missing information: ${error.message}`, 'forms');
    await this.events.publish({
      type: 'task.form_request',
      orgId,
      taskId,
      payload: {
        message: error.message,
        form: error.form,
      },
    });
    await this.say(orgId, taskId, error.message);
    await this.tasks.transition(taskId, orgId, 'waiting_for_approval');
  }

  private log(orgId: string, taskId: string, message: string, scope: string) {
    return this.events.publish({ type: 'task.log', orgId, taskId, payload: { message, scope } });
  }

  private async failSafely(orgId: string, taskId: string, message: string) {
    try {
      const current = await this.tasks.getTask(taskId, orgId);
      if (current.status === 'pending') await this.tasks.transition(taskId, orgId, 'planning');
      const refreshed = await this.tasks.getTask(taskId, orgId);
      // planning, running and waiting_for_approval can all fail directly
      if (!['completed', 'failed', 'cancelled'].includes(refreshed.status)) {
        await this.tasks.transition(taskId, orgId, 'failed', { error: message });
      }
    } catch (transitionError) {
      this.logger.error(`Could not mark task ${taskId} as failed`, transitionError as Error);
    }
  }
}
