import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BehaviorPatternService } from './behavior-pattern.service';
import { CapabilityGateService } from '../capability-gate/capability-gate.service';
import { SetupRequiredPayload } from '../capability-gate/capability-gate.types';
import { EventBusService } from '../events/event-bus.service';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { ToolRouterService } from '../tool-router/tool-router.service';
import { TasksService } from '../tasks/tasks.service';
import { Task } from '../tasks/task.types';
import { ConversationDigesterService } from './conversation-digester.service';
import { DriveFetchResult, GoogleDriveService } from './google-drive.service';
import { GmailFetchResult, GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { MediaService } from './media.service';
import { MemoryRecallService } from './memory-recall.service';
import { MissingInformationError, ResearchToolsService } from './research-tools.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { AgentSoulContext, Goal, PersonalProfile, SoulContextService } from './soul-context.service';
import { TierDecision, classifyTier } from './tier';

/**
 * Immediate spoken acknowledgments — EVA answers in <100ms with one of these
 * while the real work happens, so the user always knows she heard them.
 */
const ACK_RULES: Array<{ pattern: RegExp; say: string; hint: string }> = [
  // Personal-data requests: email, calendar — handled by their own APIs, not web
  {
    pattern: /\b(correo|email|mail|mensajes|notificaciones|bandeja|inbox|gmail|outlook)\b/i,
    say: 'Déjame revisar tu bandeja, un momento 📬',
    hint: 'email',
  },
  {
    pattern: /\b(calendario|agenda|mis citas|mis eventos|google calendar|pr[oó]ximas? citas?)\b/i,
    say: 'Revisando tu agenda 📅',
    hint: 'calendar',
  },
  {
    pattern: /\b(drive|google drive|mis archivos|mis documentos|mis carpetas|mis docs|mis sheets|archivos? (grandes?|pesados?))\b/i,
    say: 'Revisando tu Drive 📂',
    hint: 'drive',
  },
  // Web-search triggers — words that clearly need current internet data
  {
    pattern: /\b(busca|buscar|búsqueda|search|internet|noticias|news|precio|clima|weather|cotiza|tipo de cambio|reciente|actual|hoy|ma[nñ]ana|ayer|mundial|munidal|world cup|fifa|partidos?|jugar[aá]|fixture|cap[ií]tulo|episodio|anime|manga|estreno|presidente|presidenta|gobernador|gobernadora|alcalde|alcaldesa|ceo|director|directora|titular|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomienda|recomendaci[oó]n)\b/i,
    say: 'Dame un momento, voy a buscar en internet 🔎',
    hint: 'search',
  },
  {
    pattern: /\b(revisa|revisar|mensajes)\b/i,
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
No confies en memoria deportiva, calendarios, eventos actuales o datos que cambian: optimiza para verificar fuentes actuales.
Cuando el usuario diga "este año", "ahorita", "primero" o no indique año, asume que necesita la edicion vigente o proxima segun la fecha actual incluida en este prompt.
Para Mundial/FIFA/World Cup + Mexico sin año explicito, busca la Copa Mundial FIFA 2026 y fuentes oficiales; no uses Qatar 2022 salvo que el usuario lo pida.
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

const RESEARCH_REQUIRED_SIGNALS = /\b(busca|buscar|b[uú]squeda|search|internet|noticias|news|precio|cotiza|tipo de cambio|clima|weather|pron[oó]stico|reciente|actual|ahora|hoy|ma[nñ]ana|ayer|en vivo|mundial|munidal|world cup|fifa|partidos?|jugar[aá]|fixture|cap[ií]tulo|episodio|anime|manga|temporada|estreno|release|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomienda|recomendaci[oó]n)\b/i;

// Personal-data requests: these must NEVER go to web search — they use their own APIs
const EMAIL_SIGNALS = /\b(correo|email|mail|mensajes|bandeja|inbox|gmail|outlook|mis mails|mis correos)\b/i;
const CALENDAR_SIGNALS_PERSONAL = /\b(mi(s)? (citas?|eventos?|agenda|calendario)|qu[eé] tengo|tengo algo|tengo una cita)\b/i;
const DRIVE_SIGNALS = /\b(drive|google drive|mis archivos|mis documentos|mis carpetas|mis docs|mis hojas|mis sheets|archivos? (grandes?|pesados?|de google)|carpeta(s)? (de google|en drive)|qu[eé] (archivos?|carpetas?|docs?) tengo)\b/i;

const FRESHNESS_REQUIRED_SIGNALS = [
  /\b(qui[eé]n\s+es|quien\s+es)\s+(el|la)?\s*(presidente|presidenta|gobernador|gobernadora|alcalde|alcaldesa|ceo|director|directora|titular|jefe|jefa)\b/i,
  /\b(presidente|presidenta|gobernador|gobernadora|alcalde|alcaldesa|ceo|director|directora|titular|ministro|ministra|secretario|secretaria)\s+(actual|de ahora)?\b/i,
  /\b(calendario|agenda|fixture|programaci[oó]n|horario|partidos?|juegos?|ronda|grupo|tabla|standing|posiciones)\b/i,
  /\b(precio|cotiza|cotizaci[oó]n|tipo de cambio|d[oó]lar|bitcoin|btc|acciones?|stock|bolsa|inflaci[oó]n|tasa)\b/i,
  /\b(clima|weather|pron[oó]stico|temperatura|lluvia)\b/i,
  /\b([uú]ltim[ao]s?|reciente|actual|ahora|hoy|ma[nñ]ana|ayer|en vivo|vigente|pr[oó]xim[ao]|este a[nñ]o|esta temporada)\b/i,
  /\b(mundial|munidal|world cup|fifa|olimpiadas|ol[ií]mpicos|liga|torneo|final|semifinal|temporada)\b/i,
  /\b(estreno|lanzamiento|release|versi[oó]n|cap[ií]tulo|episodio|anime|manga|serie|pel[ií]cula)\b/i,
  /\b(direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|abierto|cerrado|restaurante|tienda|sucursal)\b/i,
  /\b(202[5-9]|20[3-9]\d)\b/,
];

const STALE_ANSWER_SIGNALS = [
  /\b(202[0-4]|201\d)\b/,
  /\bQatar\s+2022\b/i,
  /\bRusia\s+2018\b/i,
  /\bhasta mi (fecha|corte) de conocimiento\b/i,
  /\bseg[uú]n mi (informaci[oó]n|conocimiento)\b/i,
];

interface ConversationContextTurn {
  role: 'user' | 'assistant';
  text: string;
}

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
    private readonly soul: SoulContextService,
    private readonly capabilityGate: CapabilityGateService,
    private readonly calendar: GoogleCalendarService,
    private readonly schedule: ScheduleService,
    private readonly patterns: BehaviorPatternService,
    private readonly memoryRecall: MemoryRecallService,
    private readonly digester: ConversationDigesterService,
    private readonly gmail: GmailService,
    private readonly drive: GoogleDriveService,
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
    const conversationContext = this.getConversationContext(task);

    // Fetch soul, schedule, patterns, and memory recall in parallel — none blocks response
    const [soulContext, localScheduleBlock, gcalBlock, patternBlock, proactiveTriggers, recallResult] = await Promise.all([
      this.soul.getAgentContext(orgId).catch(() => ({
        personal_profile: {}, cowork_context: {}, goals: [], persona_context: {},
      })),
      // Local schedule is always primary (from watch, voice, manual)
      this.schedule.formatUpcomingForSoul(orgId, 7).catch(() => null),
      // Google Calendar enrichment — optional, null when not connected
      this.calendar.formatUpcomingForSoul(orgId, 7).catch(() => null),
      // Behavior patterns for proactive suggestions
      this.patterns.formatPatternsForSoul(orgId).catch(() => null),
      // Patterns that should trigger right now (e.g. Uber suggestion at 8:30am)
      this.patterns.getTriggersNow(orgId).catch(() => []),
      // Memory recall — only relevant when user asks to remember
      this.memoryRecall.check(input, orgId).catch(() => ({ isRecall: false, context: null, memories: [] })),
    ]);

    // Merge schedule sources: local first, then fill gaps with Google Calendar
    const calendarBlock = this.mergeScheduleBlocks(localScheduleBlock, gcalBlock);

    const routingInput = this.withConversationContextForRouting(input, conversationContext);
    const contextualInput = this.buildContextualInput(
      input, conversationContext, soulContext, calendarBlock, patternBlock,
      proactiveTriggers.map(t => t.message), recallResult.context,
    );
    const startedAt = Date.now();
    // Always classify tier and freshness from raw input — routingInput includes
    // conversation history which can make short drive/email requests appear as
    // tier='long' (length > 280) and produce wrong ACKs/routing.
    const freshness = this.needsFreshness(input);
    const tier = this.applyFreshnessToTier(classifyTier(input), freshness);
    const wantsImage = this.media.wantsImage(input);
    const pureImageRequest = wantsImage && this.isPureImageRequest(input);

    try {
      if (pureImageRequest) {
        await this.tasks.transition(taskId, orgId, 'planning');
        await this.tasks.transition(taskId, orgId, 'running');
        await this.log(orgId, taskId, `tier=quick (${tier.reason}; media request) — image generation`, 'pipeline');
        const url = await this.generateImageReply(orgId, taskId, input, startedAt);
        if (url) {
          await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
          return;
        }
        throw new Error('No pude generar la imagen con los proveedores configurados. Revisa las credenciales/modelos de imagen o intenta de nuevo si el proveedor esta saturado.');
      }

      // ── Tier: chat — straight to the model, no pipeline overhead ──
      if (tier.tier === 'chat') {
        await this.tasks.transition(taskId, orgId, 'planning');
        await this.tasks.transition(taskId, orgId, 'running');
        await this.log(orgId, taskId, `tier=chat (${tier.reason}) — direct model, cheap tier`, 'pipeline');
        if (this.isPersonalProfileQuestion(input)) {
          const handled = await this.answerPersonalProfileQuestion(orgId, taskId, input, startedAt);
          if (handled) return;
        }
        const t0 = Date.now();
        const reply = await this.modelRouter.generate(contextualInput, {
          orgId, budget: 'cheap', maxTokens: 300, systemPrompt: CHAT_PROMPT,
        });
        await this.deliver(orgId, taskId, reply.text, reply.model, Date.now() - t0);
        await this.log(orgId, taskId, `chat answered in ${Date.now() - startedAt}ms`, 'pipeline');
        return;
      }

      // ── Capability gate — must run before the ACK so we never promise ──
      // ── something EVA can't actually do yet. ──────────────────────────
      const missingReq = await this.capabilityGate.firstMissingRequirement(input, orgId);
      if (missingReq) {
        await this.tasks.transition(taskId, orgId, 'planning');
        await this.tasks.transition(taskId, orgId, 'running');
        await this.log(
          orgId, taskId,
          `capability gate blocked: "${missingReq.capability}" not configured — setup required`,
          'gate',
        );
        const setupPayload: SetupRequiredPayload = {
          capability: missingReq.capability,
          setup_type: missingReq.setup_type,
          setup_label: missingReq.setup_label,
          message: missingReq.user_message,
          integrations: missingReq.integrations,
          setup_meta: missingReq.setup_meta,
        };
        await this.events.publish({
          type: 'task.setup_required',
          orgId,
          taskId,
          payload: setupPayload,
        });
        await this.say(orgId, taskId, missingReq.ack_message);
        await this.tasks.transition(taskId, orgId, 'waiting_for_approval', {
          result: { text: missingReq.user_message, model: 'capability-gate' },
        });
        return;
      }

      // ── Tier: quick (<1 min) — short "espera" + do it ──
      // ── Tier: long (>1 min) — background notice, chat stays free ──
      // Always pick ack from raw input — routingInput includes conversation history
      // which can contaminate the hint (e.g., prior "correo" turn misfiring as email).
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
      const intent = await this.intentRouter.classify(routingInput, orgId, { taskId });
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
        const outcome = await this.forge.forge(orgId, taskId, contextualInput, (message, scope) => this.log(orgId, taskId, message, scope));
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

      // ── Email fast-path — use Gmail API when configured ───────────────────
      // NOTE: always test raw `input`, never routingInput — routingInput
      // includes conversation history that may contain "correo" from prior turns.
      if (ack.hint === 'email' || EMAIL_SIGNALS.test(input)) {
        await this.log(orgId, taskId, 'email request — querying Gmail API', 'tools');

        const searchQuery = this.extractEmailSearch(input);
        let gmailResult: GmailFetchResult;

        if (searchQuery) {
          await this.log(orgId, taskId, `Gmail search: "${searchQuery}"`, 'tools');
          gmailResult = await this.gmail.fetchSearch(orgId, searchQuery);
          // Empty search result → clear message, don't fall to model
          if (!gmailResult.ok && gmailResult.reason === 'empty') {
            const sender = searchQuery.startsWith('from:') ? searchQuery.replace('from:', '') : searchQuery;
            const notFound = `📬 No encontré correos de _${sender}_ en tu bandeja. Verifica que el nombre coincida exactamente con el remitente que aparece en Gmail.`;
            await this.deliver(orgId, taskId, notFound, 'gmail-api', 0);
            await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
            return;
          }
        } else {
          gmailResult = await this.gmail.fetchLatest(orgId);
        }

        if (gmailResult.ok) {
          await this.deliver(orgId, taskId, gmailResult.text, 'gmail-api', 0);
          await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
          this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: gmailResult.text, conversationContext });
          return;
        }

        // Always answer directly — never fall to model or recovery for email
        const reply = this.gmailErrorMessage(gmailResult.reason, gmailResult.error);
        await this.log(orgId, taskId, `Gmail: ${gmailResult.reason} — ${gmailResult.error ?? 'no detail'}`, 'tools');
        await this.deliver(orgId, taskId, reply, 'gmail-api', 0);
        await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
        return;
      }

      // ── Calendar fast-path — use local schedule + GCal when configured ────
      if (ack.hint === 'calendar' || CALENDAR_SIGNALS_PERSONAL.test(input)) {
        await this.log(orgId, taskId, 'calendar request — querying local schedule + Google Calendar', 'tools');
        const [localBlock, gcalBlock] = await Promise.all([
          this.schedule.formatUpcomingForSoul(orgId, 7).catch(() => null),
          this.calendar.formatUpcomingForSoul(orgId, 7).catch(() => null),
        ]);
        const agendaText = this.mergeScheduleBlocks(localBlock, gcalBlock);
        if (agendaText) {
          const reply = `📅 Tu agenda próxima:\n\n${agendaText}`;
          await this.deliver(orgId, taskId, reply, 'calendar-api', 0);
          await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
          this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: reply, conversationContext });
          return;
        }
        await this.log(orgId, taskId, 'No calendar events found — falling to model', 'tools');
      }

      // ── Drive fast-path — use Drive API when configured ───────────────────
      // NOTE: always test raw `input`, never routingInput — history contamination.
      if (ack.hint === 'drive' || DRIVE_SIGNALS.test(input)) {
        await this.log(orgId, taskId, 'drive request — querying Google Drive API', 'tools');
        const driveResult = await this.drive.fetchForQuery(orgId, input);

        if (driveResult.ok) {
          await this.deliver(orgId, taskId, driveResult.text, 'drive-api', 0);
          await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
          this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: driveResult.text, conversationContext });
          return;
        }

        // Always answer directly — never fall to model or recovery for Drive requests
        const reply = this.driveErrorMessage(driveResult.reason, driveResult.error);
        await this.log(orgId, taskId, `Drive: ${driveResult.reason} — ${driveResult.error ?? 'no detail'}`, 'tools');
        await this.deliver(orgId, taskId, reply, 'drive-api', 0);
        await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
        return;
      }

      // Tool routing (transparent dry-run of what executes this)
      const shouldUseResearch = this.shouldUseResearch(input, routingInput, ack.hint, freshness.required);
      const capability = shouldUseResearch ? 'search' : 'generate';
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

      if (shouldUseResearch) {
        await this.log(orgId, taskId, 'buscando en internet con Chromium… (web-search tool)', 'web');
        const researchInput = await this.planResearchInput(orgId, taskId, contextualInput);
        const t0 = Date.now();
        const answer = await this.research.answer(researchInput, orgId);
        const elapsed = Date.now() - t0;
        await this.log(orgId, taskId, `tool ${answer.tool} answered in ${elapsed}ms`, 'tools');
        await this.deliver(orgId, taskId, answer.text, answer.tool, elapsed);
        await this.maybeAttachMedia(orgId, taskId, input, answer.text);
        await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
        this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: answer.text, conversationContext });
        return;
      }

      // Model call — quick rides the cheap tier for speed
      const budget = tier.tier === 'quick' ? 'cheap' : 'balanced';
      await this.log(orgId, taskId, `calling model (budget=${budget}, org keys first, env fallback)…`, 'model');
      const t0 = Date.now();
      const result = await this.modelRouter.generate(contextualInput, {
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

      const staleReason = this.staleModelAnswerReason(routingInput, result.text, freshness.required);
      if (this.isUselessAnswer(result.text) || staleReason) {
        const reason = staleReason ?? 'non-actionable';
        await this.log(orgId, taskId, `model answer rejected as ${reason}; trying project tools`, 'model');
        const recovered = await this.recoverWithTools(orgId, taskId, contextualInput, startedAt, input);
        if (recovered) return;
      }

      await this.deliver(orgId, taskId, result.text, result.model, elapsed);
      await this.maybeAttachMedia(orgId, taskId, input, result.text);
      await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
      this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: result.text, conversationContext });
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

  private async generateImageReply(orgId: string, taskId: string, input: string, startedAt: number): Promise<string | null> {
    await this.log(orgId, taskId, 'generando imagen y subiendo al bucket eva-media…', 'media');
    const url = await this.media.sendImage(orgId, taskId, input);
    if (!url) return null;
    const text = `Listo, generé la imagen: ${url}`;
    await this.deliver(orgId, taskId, text, 'media:image', Date.now() - startedAt);
    await this.log(orgId, taskId, `imagen lista: ${url}`, 'media');
    return url;
  }

  private isPureImageRequest(input: string): boolean {
    return /\b(crea|crear|genera|generar|haz|hacer|dame|muestra|mu[eé]strame|dibuja|dibujar|ilustra|ilustrar)\b/i.test(input)
      && /\b(imagen|im[aá]genes|foto|dibujo|ilustraci[oó]n|logo)\b/i.test(input);
  }

  private isUselessAnswer(text: string): boolean {
    return USELESS_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
  }

  private getConversationContext(task: Task): ConversationContextTurn[] {
    const raw = task.metadata?.conversation_context;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((item): ConversationContextTurn | null => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const role = record.role === 'user' || record.role === 'assistant' ? record.role : null;
        const text = typeof record.text === 'string' ? record.text.trim() : '';
        if (!role || !text) return null;
        return { role, text: text.slice(0, 1200) };
      })
      .filter((item): item is ConversationContextTurn => Boolean(item))
      .slice(-8);
  }

  private withConversationContextForRouting(input: string, context: ConversationContextTurn[]): string {
    if (context.length === 0) return input;
    const contextText = context
      .map((turn) => `${turn.role === 'user' ? 'Usuario' : 'EVA'}: ${turn.text}`)
      .join('\n');
    return `${input}\n\nContexto reciente de la conversacion:\n${contextText}`;
  }

  /**
   * Merges local schedule (primary) with Google Calendar (enrichment).
   * If both have content, they're shown in separate labeled sections.
   * If only one has content, just that one is shown.
   */
  private mergeScheduleBlocks(local: string | null, gcal: string | null): string | null {
    if (!local && !gcal) return null;
    if (local && !gcal) return local;
    if (!local && gcal) return `[Google Calendar]\n${gcal}`;
    return `[Agenda local]\n${local}\n[Google Calendar]\n${gcal}`;
  }

  /**
   * Assembles the full contextual prompt injected into every non-trivial agent call.
   * Includes: personal profile, identity, active goals, local schedule (+ optional Google Calendar),
   * behavior patterns, proactive triggers, and optionally: recalled memories.
   */
  private buildContextualInput(
    input: string,
    conversationContext: ConversationContextTurn[],
    soulContext: AgentSoulContext,
    calendarBlock: string | null,
    patternBlock: string | null,
    proactiveTriggerMessages: string[],
    memoryRecallContext: string | null,
  ): string {
    const blocks: string[] = [input];

    const soulSummary = this.formatEnrichedSoulContext(soulContext, calendarBlock, patternBlock);
    if (soulSummary) {
      blocks.push('', soulSummary);
    }

    // Proactive triggers — patterns that match right now (e.g. "¿Llamo el Uber?")
    if (proactiveTriggerMessages.length > 0) {
      blocks.push(
        '',
        '## Sugerencias proactivas basadas en los patrones del usuario:',
        '(Puedes mencionarlas si es natural en esta conversación)',
        ...proactiveTriggerMessages.map(m => `- ${m}`),
      );
    }

    if (memoryRecallContext) {
      blocks.push('', memoryRecallContext);
    }

    if (conversationContext.length > 0) {
      const contextText = conversationContext
        .map((turn) => `${turn.role === 'user' ? 'Usuario' : 'EVA'}: ${turn.text}`)
        .join('\n');
      blocks.push(
        '',
        '## Conversación reciente:',
        contextText,
        '',
        'Resuelve la peticion actual usando ese contexto si el usuario usa referencias como "eso", "ese", "la direccion", "el lugar", "cuanto cuesta" o preguntas incompletas.',
      );
    }

    if (blocks.length === 1) return input;
    blocks.push('\nNo inventes datos actuales: si hace falta informacion vigente, usa busqueda/herramientas.');
    return blocks.join('\n');
  }

  /**
   * Formats the full soul context into a structured, human-readable block.
   * This is what makes EVA feel like a real personal assistant — she knows
   * who the user is, what they care about, and what's on their agenda.
   */
  private formatEnrichedSoulContext(
    context: AgentSoulContext,
    calendarBlock: string | null,
    patternBlock: string | null = null,
  ): string | null {
    const sections: string[] = ['## Contexto personal de tu usuario:'];
    let hasContent = false;

    // ── Identity & Profile ─────────────────────────────────────────────────
    const p = context.personal_profile;
    const persona = context.persona_context;
    const profileLines: string[] = [];

    if (p.full_name)         profileLines.push(`- Nombre: ${p.full_name}`);
    if (p.preferred_address) profileLines.push(`- Llámale: ${p.preferred_address}`);
    if (p.age)               profileLines.push(`- Edad: ${p.age}`);
    if (p.occupation || persona.occupation)
      profileLines.push(`- Se dedica a: ${p.occupation ?? persona.occupation}`);
    if (p.workplace)         profileLines.push(`- Empresa/Lugar de trabajo: ${p.workplace}`);
    if (p.current_location)  profileLines.push(`- Ubicación actual: ${p.current_location}`);
    if (p.likes)             profileLines.push(`- Le gusta: ${p.likes}`);
    if (p.hobbies)           profileLines.push(`- Hobbies: ${p.hobbies}`);
    if (p.values)            profileLines.push(`- Lo que más valora: ${p.values}`);
    if (p.dislikes)          profileLines.push(`- No le gusta: ${p.dislikes}`);
    if (p.allergies)         profileLines.push(`- Alergias: ${p.allergies}`);
    if (persona.bio)         profileLines.push(`- Sobre él/ella: ${persona.bio}`);

    if (profileLines.length > 0) {
      sections.push('\n### Perfil personal', ...profileLines);
      hasContent = true;
    }

    // ── Expectations from EVA ──────────────────────────────────────────────
    if (persona.expectations) {
      sections.push('\n### Qué espera de EVA', `- ${persona.expectations}`);
      hasContent = true;
    }
    if (persona.communication_preferences) {
      sections.push(`- Estilo de comunicación preferido: ${persona.communication_preferences}`);
    }

    // ── Active Goals ───────────────────────────────────────────────────────
    const activeGoals = context.goals.filter(g => g.status === 'active');
    if (activeGoals.length > 0) {
      sections.push('\n### Metas activas');
      activeGoals.forEach(g => {
        const deadline = g.deadline ? ` (meta: ${g.deadline})` : '';
        const progress = g.progress ? ` — Progreso: ${g.progress}` : '';
        sections.push(`- ${g.title}${deadline}${progress}`);
      });
      hasContent = true;
    }

    // ── Live Calendar (from Google Calendar API) ───────────────────────────
    if (calendarBlock) {
      sections.push('\n### Agenda próxima (Google Calendar)', calendarBlock);
      hasContent = true;
    } else if (context.cowork_context.upcoming_appointments) {
      sections.push('\n### Citas próximas (estáticas)', context.cowork_context.upcoming_appointments);
      hasContent = true;
    }

    // ── Projects & Tasks ───────────────────────────────────────────────────
    const projects = persona.projects ?? context.cowork_context.projects;
    if (projects) { sections.push('\n### Proyectos activos', projects); hasContent = true; }

    const pending = context.cowork_context.pending_tasks;
    if (pending) { sections.push('\n### Tareas pendientes', pending); hasContent = true; }

    // ── Routines & Work style ─────────────────────────────────────────────
    const routines = persona.routines ?? context.cowork_context.routines;
    if (routines) { sections.push('\n### Rutinas', routines); hasContent = true; }

    const workHours = persona.work_hours ?? context.cowork_context.work_hours;
    if (workHours) { sections.push(`\n### Horarios de trabajo: ${workHours}`); hasContent = true; }

    // ── Relationships ─────────────────────────────────────────────────────
    const family = persona.family ?? context.cowork_context.family;
    if (family) { sections.push('\n### Familia y relaciones importantes', family); hasContent = true; }

    // ── Behavior patterns ─────────────────────────────────────────────────
    if (patternBlock) {
      sections.push('\n### Patrones de comportamiento detectados', patternBlock);
      hasContent = true;
    }

    if (!hasContent) return null;
    return sections.join('\n').slice(0, 5000);
  }

  /** Legacy alias used by answerPersonalProfileQuestion — kept for compat. */
  private formatSoulContext(context: AgentSoulContext): string | null {
    return this.formatEnrichedSoulContext(context, null, null);
  }

  private gmailErrorMessage(reason: 'no_credential' | 'token_error' | 'api_error' | 'empty', error?: string): string {
    if (reason === 'no_credential') {
      return '📬 No tienes Gmail configurado. Ve a **Integraciones → Google** y guarda tu Client ID, Client Secret y Refresh Token para que pueda leer tu bandeja.';
    }
    if (reason === 'token_error') {
      const detail = error ? ` (${error})` : '';
      return `📬 No pude obtener acceso a Gmail${detail}. Verifica que tu Refresh Token siga siendo válido en **Integraciones → Google → Test Gmail · Calendar · Drive**. Si expiró, regenera el token en Google OAuth Playground.`;
    }
    if (reason === 'api_error') {
      const detail = error ? `: ${error}` : '';
      return `📬 Gmail respondió con un error${detail}. Puede ser un problema de permisos — asegúrate de que el scope \`gmail.readonly\` esté incluido en tu autorización.`;
    }
    // empty
    return '📬 Tu bandeja de entrada está vacía en este momento.';
  }

  private driveErrorMessage(reason: 'no_credential' | 'token_error' | 'api_error', error?: string): string {
    if (reason === 'no_credential') {
      return '📂 No tienes Google Drive configurado. Ve a **Integraciones → Google** y guarda tu Client ID, Client Secret y Refresh Token para que pueda acceder a tus archivos.';
    }
    if (reason === 'token_error') {
      const detail = error ? ` (${error})` : '';
      return `📂 No pude obtener acceso a Google Drive${detail}. Verifica que tu Refresh Token siga siendo válido en **Integraciones → Google → Test Gmail · Calendar · Drive**. Si expiró, regenera el token en Google OAuth Playground.`;
    }
    // api_error
    const detail = error ? `: ${error}` : '';
    return `📂 Google Drive respondió con un error${detail}. Puede ser un problema de permisos — asegúrate de que el scope \`drive.readonly\` esté incluido en tu autorización.`;
  }

  /**
   * Extracts a Gmail search query from natural-language input.
   * Returns a Gmail search string (e.g. "from:santander") or null for generic inbox requests.
   *
   * Supported patterns:
   *   - "que me envió/mandó [sender]" → from:[sender]
   *   - "enviado/mandado por [sender]" → from:[sender]
   *   - "correo de [sender]" → from:[sender]
   *   - "con asunto [topic]"  → subject:[topic]
   *   - "sobre [topic]"       → [topic]  (free-text search)
   */
  private extractEmailSearch(query: string): string | null {
    // Sender: "que me envio/mandó/escribió [sender]"
    let m = query.match(/(?:que me (?:envi[oó]|mand[oó]|escribi[oó]|contact[oó]))\s+([^?,.\n]{2,40}?)(?:\?|$|[,.])/i);
    if (m) return `from:${m[1].trim()}`;

    // Sender: "enviado/mandado/escrito por [sender]"
    m = query.match(/(?:enviado|mandado|escrito)\s+(?:por|de|from)\s+([^?,.\n]{2,40}?)(?:\?|$|[,.])/i);
    if (m) return `from:${m[1].trim()}`;

    // Sender: "correo(s) de/del [sender]" but NOT "correo de hoy/ayer" etc.
    m = query.match(/\bcorreo[s]?\s+(?:de|del)\s+([a-záéíóúüñA-ZÁÉÍÓÚÜÑ][\w\s.-]{1,30}?)(?:\?|$|[,.]|\s+que|\s+con|\s+sobre)/i);
    if (m && !/\b(hoy|ayer|semana|mes|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i.test(m[1])) {
      return `from:${m[1].trim()}`;
    }

    // Subject: "con asunto [topic]"
    m = query.match(/(?:con asunto|asunto)\s+([^?,.\n]{2,40}?)(?:\?|$|[,.])/i);
    if (m) return `subject:${m[1].trim()}`;

    // Free-text: "sobre [topic]" (skip if topic is generic email words)
    m = query.match(/\bsobre\s+([^?,.\n]{3,40}?)(?:\?|$|[,.])/i);
    if (m) {
      const topic = m[1].trim();
      if (!/\b(correo|email|mail|inbox|bandeja|mis|el|la|los|las)\b/i.test(topic)) {
        return topic;
      }
    }

    return null;
  }

  // rawInput = user's current message only; routingInput may include conversation history
  private shouldUseResearch(rawInput: string, routingInput: string, ackHint: string, freshnessRequired = false): boolean {
    // Personal-data requests must never fall to web search.
    // Always check raw input — routingInput may contain prior-turn keywords.
    if (ackHint === 'email' || ackHint === 'calendar' || ackHint === 'drive') return false;
    if (EMAIL_SIGNALS.test(rawInput) || CALENDAR_SIGNALS_PERSONAL.test(rawInput) || DRIVE_SIGNALS.test(rawInput)) return false;
    return freshnessRequired || ackHint === 'search' || RESEARCH_REQUIRED_SIGNALS.test(routingInput);
  }

  private needsFreshness(input: string): { required: boolean; reason: string } {
    const matched = FRESHNESS_REQUIRED_SIGNALS.find((pattern) => pattern.test(input));
    return matched
      ? { required: true, reason: 'volatile/current-info signal' }
      : { required: false, reason: 'stable or conversational' };
  }

  private applyFreshnessToTier(tier: TierDecision, freshness: { required: boolean; reason: string }): TierDecision {
    if (!freshness.required || tier.tier !== 'chat') return tier;
    return {
      tier: 'quick',
      estimateSec: Math.max(tier.estimateSec, 20),
      reason: `${tier.reason}; freshness guard: ${freshness.reason}`,
    };
  }

  private staleModelAnswerReason(input: string, answer: string, freshnessRequired: boolean): string | null {
    if (!freshnessRequired) return null;
    if (!STALE_ANSWER_SIGNALS.some((pattern) => pattern.test(answer))) return null;
    if (/\b(202[0-4]|201\d|qatar\s+2022|rusia\s+2018)\b/i.test(input)) return null;
    return 'possibly stale for a freshness-required question';
  }

  private isPersonalProfileQuestion(input: string): boolean {
    return /\b(mi nombre|me llamo|quien soy|qui[eé]n soy|mi edad|cu[aá]ntos a[nñ]os|mis datos|sabes.*(?:nombre|edad|datos)|datos personales)\b/i
      .test(input);
  }

  private requestedProfileFields(input: string): Array<{ key: keyof PersonalProfile; label: string; type: 'text' | 'number' }> {
    const fields: Array<{ key: keyof PersonalProfile; label: string; type: 'text' | 'number'; pattern: RegExp }> = [
      { key: 'full_name', label: 'Nombre', type: 'text', pattern: /\b(nombre|me llamo|quien soy|qui[eé]n soy)\b/i },
      { key: 'preferred_address', label: 'Como quieres que te llame', type: 'text', pattern: /\b(como me llamas|c[oó]mo me llamas|llamarme|apodo|trato)\b/i },
      { key: 'age', label: 'Edad', type: 'number', pattern: /\b(edad|a[nñ]os)\b/i },
      { key: 'current_location', label: 'Ubicacion actual', type: 'text', pattern: /\b(ubicaci[oó]n actual|d[oó]nde estoy|donde estoy)\b/i },
      { key: 'address', label: 'Direccion', type: 'text', pattern: /\b(direcci[oó]n|domicilio|casa)\b/i },
      { key: 'workplace', label: 'Lugar de trabajo', type: 'text', pattern: /\b(trabajo|empresa|oficina)\b/i },
      { key: 'likes', label: 'Gustos', type: 'text', pattern: /\b(gustos|me gusta)\b/i },
      { key: 'dislikes', label: 'Lo que no te gusta', type: 'text', pattern: /\b(no me gusta|disgustos)\b/i },
      { key: 'allergies', label: 'Alergias', type: 'text', pattern: /\b(alergias|al[eé]rgico)\b/i },
      { key: 'weight', label: 'Peso', type: 'text', pattern: /\b(peso|cu[aá]nto peso)\b/i },
      { key: 'height', label: 'Altura', type: 'text', pattern: /\b(altura|estatura|mido)\b/i },
    ];

    const requested = fields
      .filter(({ pattern }) => pattern.test(input))
      .map(({ key, label, type }) => ({ key, label, type }));

    return requested.length > 0
      ? requested
      : fields
        .filter(({ key }) => key === 'full_name' || key === 'age')
        .map(({ key, label, type }) => ({ key, label, type }));
  }

  private async answerPersonalProfileQuestion(
    orgId: string,
    taskId: string,
    input: string,
    startedAt: number,
  ): Promise<boolean> {
    const profile = await this.soul.getPersonalProfile(orgId);
    const requested = this.requestedProfileFields(input);
    const known = requested
      .map((field) => ({ ...field, value: String(profile[field.key] ?? '').trim() }))
      .filter((field) => field.value.length > 0);
    const missing = requested
      .filter((field) => !String(profile[field.key] ?? '').trim());

    if (known.length > 0 && missing.length === 0) {
      const text = [
        'Esto tengo guardado sobre ti:',
        ...known.map((field) => `- ${field.label}: ${field.value}`),
      ].join('\n');
      await this.log(orgId, taskId, 'answered from soul personal_profile', 'soul');
      await this.deliver(orgId, taskId, text, 'soul-profile', Date.now() - startedAt);
      return true;
    }

    const knownText = known.length > 0
      ? `${known.map((field) => `${field.label}: ${field.value}`).join(', ')}. `
      : '';
    const missingLabels = missing.map((field) => field.label).join(', ');
    throw new MissingInformationError(
      `${knownText}Me faltan estos datos en tu Soul: ${missingLabels}.`,
      {
        form_key: 'personal_profile.identity',
        title: 'Completa tu perfil personal',
        description: 'Guarda estos datos para que EVA pueda responder sobre ti sin inventar informacion.',
        fields: missing.map((field) => ({
          id: field.key,
          type: field.type,
          label: field.label,
          required: true,
          profile_path: `personal_profile.${field.key}`,
        })),
      },
    );
  }

  // rawInput = current user message; input here may be the full contextualInput
  private async recoverWithTools(orgId: string, taskId: string, input: string, startedAt: number, rawInput?: string): Promise<boolean> {
    const errors: string[] = [];
    const guard = rawInput ?? input;

    // Personal-data requests must never fall to web-search recovery.
    if (EMAIL_SIGNALS.test(guard) || CALENDAR_SIGNALS_PERSONAL.test(guard) || DRIVE_SIGNALS.test(guard)) {
      await this.log(orgId, taskId, 'recovery skipped: personal-data request — no web search fallback', 'tools');
      return false;
    }

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
      const plannerDate = this.currentPlannerDate();
      const result = await this.modelRouter.generate(input, {
        orgId,
        budget: 'cheap',
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 220,
        systemPrompt: `${RESEARCH_PLANNER_PROMPT}\n\nFecha actual: ${plannerDate}.`,
      });
      const parsed = JSON.parse(result.text) as {
        query?: unknown;
        intent?: unknown;
        source_hint?: unknown;
        reason?: unknown;
      };
      const rawQuery = typeof parsed.query === 'string' && parsed.query.trim().length > 0
        ? parsed.query.trim()
        : input;
      const query = this.normalizeResearchQuery(input, rawQuery);
      await this.log(
        orgId,
        taskId,
        `research-plan: query="${query}" intent=${String(parsed.intent ?? 'unknown')} source=${String(parsed.source_hint ?? 'unknown')} — ${String(parsed.reason ?? 'no reason')}`,
        'tools',
      );
      return query;
    } catch (error) {
      await this.log(orgId, taskId, `research-plan failed; using original input — ${(error as Error).message}`, 'tools');
      return this.normalizeResearchQuery(input, input);
    }
  }

  private currentPlannerDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private normalizeResearchQuery(input: string, query: string): string {
    const asksWorldCup = /\b(mundial|munidal|world cup|copa mundial|fifa)\b/i.test(input);
    const asksMexico = /\b(m[eé]xico|mexico|selecci[oó]n mexicana|tri\b)\b/i.test(input);
    const explicitlyOldWorldCup = /\b(2022|qatar)\b/i.test(input);

    if (asksWorldCup && asksMexico && !explicitlyOldWorldCup) {
      return 'Mexico Mundial FIFA 2026 calendario oficial partidos';
    }

    return query;
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
