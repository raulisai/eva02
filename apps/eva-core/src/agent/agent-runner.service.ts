import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { ToolRouterService } from '../tool-router/tool-router.service';
import { TasksService } from '../tasks/tasks.service';
import { Task } from '../tasks/task.types';

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

const SYSTEM_PROMPT = `Eres EVA, un agente operativo. Responde SIEMPRE en español,
de forma directa y concisa (máximo ~120 palabras salvo que pidan detalle).
Si la orden requiere acciones externas que no puedes ejecutar todavía, explica
exactamente qué harías paso a paso.`;

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly events: EventBusService,
    private readonly tasks: TasksService,
    private readonly intentRouter: IntentRouterService,
    private readonly modelRouter: ModelRouterService,
    private readonly toolRouter: ToolRouterService,
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

    // 1. Instant acknowledgment (<100ms — no model involved)
    const ack = this.pickAck(input);
    await this.say(orgId, taskId, ack.say);
    await this.log(orgId, taskId, `ack emitted (${ack.hint}) in ${Date.now() - startedAt}ms`, 'pipeline');

    try {
      // 2. Intent classification
      await this.tasks.transition(taskId, orgId, 'planning');
      await this.log(orgId, taskId, 'classifying intent…', 'intent');
      const intent = await this.intentRouter.classify(input, orgId, { taskId });
      await this.log(
        orgId, taskId,
        `intent=${intent.intent} (${intent.classifier}, confidence ${intent.confidence.toFixed(2)}) — ${intent.reasons.join('; ') || 'no signals'}`,
        'intent',
      );

      await this.tasks.transition(taskId, orgId, 'running');

      // 3. Sensitive orders stop at the approval gate — never auto-executed.
      if (intent.intent === 'core_path_approval') {
        await this.tasks.transition(taskId, orgId, 'waiting_for_approval');
        await this.say(orgId, taskId, 'Necesito tu aprobación para continuar — revisa la bandeja de Approvals 🛡️');
        await this.log(orgId, taskId, 'parked at approval gate (L2 action)', 'approval');
        return;
      }

      // 4. Tool routing (transparent dry-run of what executes this)
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
        await this.log(orgId, taskId, 'buscando en internet… (web-search tool)', 'web');
      }

      // 5. Model call — fast path uses the cheap tier for speed
      const budget = intent.intent === 'fast_path' ? 'cheap' : 'balanced';
      await this.log(orgId, taskId, `calling model (budget=${budget}, org keys first, env fallback)…`, 'model');
      const t0 = Date.now();
      const result = await this.modelRouter.generate(input, {
        orgId,
        budget,
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: 700,
      });
      const elapsed = Date.now() - t0;
      await this.log(
        orgId, taskId,
        `model ${result.model} (${result.backend}) answered in ${elapsed}ms — ${result.usage.totalTokens} tokens`,
        'model',
      );

      // 6. Deliver result + complete
      await this.events.publish({
        type: 'task.result',
        orgId,
        taskId,
        payload: { text: result.text, model: result.model, latency_ms: elapsed },
      });
      await this.tasks.transition(taskId, orgId, 'completed', {
        result: { text: result.text, model: result.model, latency_ms: elapsed },
      });
      await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Agent run failed for task ${taskId}: ${message}`);
      await this.log(orgId, taskId, `ERROR: ${message}`, 'pipeline');
      await this.failSafely(orgId, taskId, message);
    }
  }

  private say(orgId: string, taskId: string, text: string) {
    return this.events.publish({ type: 'task.say', orgId, taskId, payload: { text } });
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
