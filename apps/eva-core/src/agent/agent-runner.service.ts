import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AgentLoopService } from './agent-loop.service';
import { AgentIntelligenceService } from './agent-intelligence.service';
import { BehaviorPatternService } from './behavior-pattern.service';
import { CapabilityGateService } from '../capability-gate/capability-gate.service';
import { SetupRequiredPayload } from '../capability-gate/capability-gate.types';
import { EventBusService } from '../events/event-bus.service';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ToolRouterService } from '../tool-router/tool-router.service';
import { TasksService } from '../tasks/tasks.service';
import { DatabaseService } from '../database/database.service';
import { Task, TaskCancelledError } from '../tasks/task.types';
import { ConversationDigesterService } from './conversation-digester.service';
import { DriveFetchResult, GoogleDriveService } from './google-drive.service';
import { CreateEventInput } from './google-calendar.service';
import { GmailFetchResult, GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { UberWebService } from '../integrations/uber-web.service';
import { RappiWebService } from '../integrations/rappi-web.service';
import { GoogleWebLoginService } from '../integrations/google-web-login.service';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';
import { MediaService } from './media.service';
import { MemoryRecallService } from './memory-recall.service';
import { MissingInformationError, ResearchToolsService } from './research-tools.service';
import { SandboxService } from './sandbox.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { AgentSoulContext, Goal, PersonalProfile, SoulContextService } from './soul-context.service';
import { TierDecision, classifyTier } from './tier';
import { wantsEvidence } from './evidence';
import { ScheduledJobsService } from '../jobs/scheduled-jobs.service';
import { CommunicationService } from '../communication/communication.service';
import type { CommunicationChannel } from '../communication/communication.types';
import { PipelineRunnerService } from './pipeline-runner.service';

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
  {
    pattern: /\b(clima|weather|temperatura|pron[oó]stico|lluvia|llover|calor|fr[ií]o|receta|recetas|recipe|recipes|cocina|cocinar|prepara(?:r)?|platillo|ingredientes?)\b/i,
    say: 'Lo consulto directo en una API pública y te doy solo lo útil.',
    hint: 'public_api',
  },
  // Web-search triggers — words that clearly need current internet data
  {
    pattern: /\b(busca|buscar|búsqueda|search|internet|noticias|news|precio|cotiza|tipo de cambio|reciente|actual|hoy|ma[nñ]ana|ayer|mundial|munidal|world cup|fifa|partidos?|jugar[aá]|fixture|cap[ií]tulo|episodio|anime|manga|estreno|presidente|presidenta|gobernador|gobernadora|alcalde|alcaldesa|ceo|director|directora|titular|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomienda|recomendaci[oó]n)\b/i,
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

const LONG_TASK_ACK = 'Va para largo 🛠️ Ya estoy en ello; te aviso en cuanto lo tenga.';

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

const RESEARCH_REQUIRED_SIGNALS = /\b(busca|buscar|b[uú]squeda|search|internet|noticias|news|precio|cotiza|tipo de cambio|clima|weather|pron[oó]stico|receta|recetas|recipe|recipes|cocina|cocinar|ingredientes?|reciente|actual|ahora|hoy|ma[nñ]ana|ayer|en vivo|mundial|munidal|world cup|fifa|partidos?|jugar[aá]|fixture|cap[ií]tulo|episodio|anime|manga|temporada|estreno|release|direcci[oó]n|ubicaci[oó]n|tel[eé]fono|horario|restaurante|comida|recomienda|recomendaci[oó]n)\b/i;
const PUBLIC_API_DIRECT_SIGNALS = /\b(clima|weather|temperatura|pron[oó]stico|lluvia|llover|calor|fr[ií]o|receta|recetas|recipe|recipes|cocina|cocinar|prepara(?:r)?|platillo|ingredientes?)\b/i;

// Personal-data requests: these must NEVER go to web search — they use their own APIs
const EMAIL_SIGNALS = /\b(correo|email|mail|mensajes|bandeja|inbox|gmail|outlook|mis mails|mis correos)\b/i;
const CALENDAR_SIGNALS_PERSONAL = /\b(mi(s)? (citas?|eventos?|agenda|calendario)|qu[eé] tengo|tengo algo|tengo una cita)\b/i;
const DRIVE_SIGNALS = /\b(drive|google drive|mis archivos|mis documentos|mis carpetas|mis docs|mis hojas|mis sheets|archivos? (grandes?|pesados?|de google)|carpeta(s)? (de google|en drive)|qu[eé] (archivos?|carpetas?|docs?) tengo)\b/i;
const UBER_SIGNALS = /\b(uber|taxi|viajes?|viajar|vieajes?|traslado|transporte)\b/i;
const UBER_ESTIMATE_SIGNALS = /\b(cu[aá]nto|cuanto|costo|costar|cuesta|sale|precio|tarifa|cotiza|cotizar|estimaci[oó]n|estimate|quote)\b/i;
const UBER_ORDER_SIGNALS = /\b(pedir|pide|solicita|solicitar|ordena|ordenar|manda|mandar|confirma|confirmar|reserva|reservar)\b/i;
const UBER_EMAIL_LOGIN_SIGNALS = /\b(inicia[r]?\s+(?:sesi[oó]n|sesion)|log\s*in|iniciar|conectar|vincular)\b.{0,30}\b(uber)\b|\b(uber)\b.{0,30}\b(correo|email|mail)\b/i;
const RAPPI_SIGNALS = /\b(rappi)\b/i;
const RAPPI_EMAIL_LOGIN_SIGNALS = /\b(inicia[r]?\s+(?:sesi[oó]n|sesion)|log\s*in|iniciar|conectar|vincular)\b.{0,30}\b(rappi)\b|\b(rappi)\b.{0,30}\b(correo|email|mail)\b/i;
// OTP code submission: short numeric string (4-8 digits) with optional "el código es" prefix
const OTP_SUBMIT_SIGNALS = /^\s*(?:el\s+c[oó]digo\s+(?:es\s+)?|c[oó]digo\s*[=:\s]\s*|es\s+)?(\d{4,8})\s*$/i;
// Context marker left in EVA's prior reply when waiting for OTP
const OTP_PENDING_CONTEXT = /dime(?:lo)?.*c[oó]digo|c[oó]digo.*dime|te enviaron.*c[oó]digo|ingres[aé].*correo.*(uber|rappi)/i;
const GOOGLE_BLOCKED_LOGIN_SIGNALS = /\b(iniciar?|inicia|login|conectar|vincular|abrir?)\b.{0,30}\b(google|gmail)\b.{0,30}\b(manual|manualmente|browser|navegador|visible|ventana)?\b|\bgoogle\b.{0,30}\bbloqueó\b|\bgoogle.*manual/i;
const WHATSAPP_SIGNALS = /\b(whatsapp|whatsap|watsapp|watsap|whats app|guasap|guasapp|wa\b|mensajes? de whats|mis mensajes? de wa)\b/i;
const WHATSAPP_READ_SIGNALS = /\b([uú]ltim[oa]s?|mensajes?|chats?|revisa|revisar|consulta|consultar|leer|lee|qu[eé] tengo)\b/i;
const WHATSAPP_UNREAD_SIGNALS = /\b(sin leer|no le[ií]dos?|unread)\b/i;
const WHATSAPP_UNANSWERED_SIGNALS = /\b(sin responder|sin contestar|por responder|por contestar|pendientes? de (?:responder|contestar)|no (?:he|has|han|est[aá]n)?\s*(?:respondid[oa]s?|contestad[oa]s?))\b/i;
const WHATSAPP_SEND_SIGNALS = /\b(responde|responder|contesta|contestar|env[ií]a|enviar|manda|mandar|escribe|escribir|env[ií]ale|m[aá]ndale|escr[ií]bele|dile|decirle)\b/i;
const WHATSAPP_SCREENSHOT_SIGNALS = /\b(captura(?:me)?|pantallazo|screenshot|screen\s*shot|scre+ns?h?o+t|scre+sh?o+t|screeshoot|svcreshoot|screenshoot|ss)\b/i;
const CHAT_CONTEXT_SIGNALS = /\b(conversaciones?|chats?|mensajes?|whatsapp|whatsap|watsapp|watsap|guasap|wa\b)\b/i;

// ── Gmail / Calendar write-intent signals ────────────────────────────────────
// These must be checked BEFORE the read-only email fast-path.
const GMAIL_SEND_SIGNALS = /\b(env[ií]a[r]?|manda[r]?|escrib[ei][r]?|redacta[r]?|componer?|compose)\b.{0,30}\b(correos?|emails?|mails?)\b/i;
const GMAIL_REPLY_SIGNALS = /\b(resp[oó]nde(le)?[r]?|contesta[r]?)\b.{0,30}\b(correos?|emails?|mails?)\b/i;
const GMAIL_TRASH_SIGNALS = /\b(borra[r]?|elimina[r]?|bota[r]?|desecha[r]?|manda a la basura|trash|papelera)\b.{0,30}\b(correos?|emails?|mails?)\b/i;
const GMAIL_ARCHIVE_SIGNALS = /\b(archiva[r]?|archive)\b.{0,30}\b(correos?|emails?|mails?)\b/i;
const GMAIL_MARK_READ_SIGNALS = /\bmarca[r]?.{0,30}\b(le[ií]do|como le[ií]do)\b/i;
const GMAIL_MARK_UNREAD_SIGNALS = /\bmarca[r]?.{0,30}\b(no le[ií]do|sin leer|unread)\b/i;
// Calendar signals require BOTH a write verb AND a calendar-specific noun to avoid
// false positives on "crea un script" / "crea una imagen" etc.
const CALENDAR_CREATE_SIGNALS =
  /\b(agenda[r]?|programa[r]?|a[nñ]ade[r]?|agrega[r]?)\b.{0,50}\b(cita[s]?|evento[s]?|reuni[oó]n(es)?|meeting)\b|\bnueva?\s+(cita|reuni[oó]n|evento)\b|\bcrea[r]?\s+(?:una?\s+)?(cita|reuni[oó]n|evento|meeting)\b/i;
const CALENDAR_DELETE_SIGNALS = /\b(cancela[r]?|elimina[r]?|borra[r]?|quita[r]?)\b.{0,40}\b(cita[s]?|evento[s]?|reuni[oó]n(es)?|meeting|compromiso)\b/i;
const CALENDAR_UPDATE_SIGNALS = /\b(cambia[r]?|mueve[r]?|modifica[r]?|actualiza[r]?|reagenda[r]?|posponer?|adelantar?)\b.{0,40}\b(cita|evento|reuni[oó]n)\b/i;
// Bulk/mass operation guard — reject any write that targets multiple items at once.
const BULK_GUARD_SIGNALS = /\b(todos(?: mis)?|todas(?: mis)?|masiv[oa]|bulk|en masa|toda la bandeja|todos los correos|todas las citas|todos los eventos)\b/i;

const APPROVE_KEYWORDS = /^\s*(?:sí|si|yes|ok|okay|dale|va|sale|claro|adelante|perfecto|aprovar|aprobar|aprobado|apruebo|aprueba|apru[eé]balo|autorizado|autorizo|confirmado|confirmo|confirmar|hazlo|env[ií]alo|m[aá]ndalo|ejec[uú]talo|procede|est[aá]\s+bien)(?:[\s,]+(?:sí|si|dale|claro|adelante|hazlo|env[ií]alo|m[aá]ndalo|ejec[uú]talo|aprobado|por\s*favor|porfa|gracias))*\s*[.!]*\s*$/i;
const REJECT_KEYWORDS = /^\s*(?:no|nel|nop|desaprovar|desaprobar|desaprueba|cancelar|cancela|canc[eé]lalo|rechazar|rechazo|rechazado|denegar|denegado|mejor\s+no|no\s+lo\s+(?:env[ií]es|hagas|mandes)|no,?\s*gracias)\s*[.!]*\s*$/i;

// R1.2: signals that the user wants to retry a previously failed task
const RETRY_INTENT_RE = /\b(reintenta|intenta\s+de\s+nuevo|vuelve\s+a\s+intentar|inténtalo?|prueba\s+de\s+nuevo|hazlo\s+de\s+nuevo|int[eé]ntalo\s+(?:de\s+nuevo|otra\s+vez)|opci[oó]n\s+(\d|uno|dos|tres|cuatro)|prueba\s+la\s+\d|elige\s+la\s+\d|la\s+opci[oó]n\s+\d|hazlo\s+as[ií])\b/i;

// R2.1: extract the option number from "opción 2" / "la 1" / "prueba la 3"
const OPTION_NUMBER_RE = /\b(?:opci[oó]n\s+|la\s+|prueba\s+la\s+)(\d)/i;

// ── Scheduled job intent signals ─────────────────────────────────────────────
// Detects requests to create / list / manage recurring or one-time scheduled jobs.
const SCHEDULE_CREATE_SIGNALS =
  /\b(recuér[d]?ame|avísame|notifícame|programa[r]?\s+(?:un\s+)?job|crea[r]?\s+(?:un\s+)?job|crea[r]?\s+(?:una?\s+)?tarea\s+programada|a\s+partir\s+de\s+hoy|cada\s+(día|hora|lunes|martes|miércoles|jueves|viernes|sábado|domingo|\d+\s*(?:hora[s]?|minuto[s]?))|todos\s+los\s+(días|lunes|martes|miércoles|jueves|viernes|sábados?|domingos?))\b/i;
const MANERO_SIGNALS =
  /\b(mañaner[oa]|briefing\s+(?:matutino|diario)?|resumen\s+(?:matutino|diario)|buenos\s+días\s+briefing|activa[r]?\s+(?:el\s+)?mañaner[oa]|configura[r]?\s+(?:el\s+)?mañaner[oa]|pon\s+(?:el\s+)?mañaner[oa]|mi\s+rutina\s+(?:de\s+)?mañana)\b/i;
const SCHEDULE_LIST_SIGNALS =
  /\b(qué\s+jobs?|mis\s+jobs?|qué\s+(?:tareas?\s+)?programadas?|lista[r]?\s+(?:mis\s+)?jobs?|ver\s+(?:mis\s+)?tareas\s+programadas?|mis\s+recordatorios\s+programados?|mis\s+automatizaciones?)\b/i;
const SCHEDULE_PAUSE_SIGNALS =
  /\b(pausa[r]?|desactiva[r]?|detén|detener)\b.{0,30}\b(job|tarea\s+programada|mañaner[oa]|recordatorio|automatizac)\b/i;

// ── Cross-channel delivery signals ───────────────────────────────────────────
// Detects "mándame la respuesta por telegram", "envíalo a telegram", etc.
// Supported targets: telegram (only one implemented; wired for future expansion).
const CROSS_CHANNEL_SIGNALS =
  /\b(mánda(me|lo|la|sela|selo)?|envía(me|lo|la)?|pása(me|lo|la)?|comparte(lo|la)?|por|v[ií]a|usando|a\s+trav[eé]s\s+de)\b.{0,25}\b(telegram)\b/i;

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

export interface RouteContext {
  orgId: string;
  taskId: string;
  task: Task;
  rawInput: string;
  input: string;
  crossChannel: CommunicationChannel | null;
  conversationContext: ConversationContextTurn[];
  soulContext: AgentSoulContext;
  calendarBlock: string | null;
  patternBlock: string | null;
  proactiveTriggers: any[];
  recallResult: { isRecall: boolean; context: string | null; memories: any[] };
  routingInput: string;
  contextualInput: string;
  startedAt: number;
  freshness: { required: boolean; reason?: string };
  tier: TierDecision;
  wantsImage: boolean;
  pureImageRequest: boolean;
  ack: { say: string; hint: string };
}

export interface RunnerRoute {
  name: string;
  priority: number;
  risk: 'low' | 'medium' | 'high';
  matches: (ctx: RouteContext) => boolean | Promise<boolean>;
  handler: (ctx: RouteContext) => Promise<boolean | void>;
}

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentRunnerService.name);
  // Per-task cross-channel routing context: populated when user requests delivery to another channel.
  // Map key = taskId. Cleared after task completes or fails.
  private readonly crossChannelCtx = new Map<string, { channel: CommunicationChannel; userId: string }>();
  private readonly activeToolSessions = new Map<string, { tool: string; details?: any; updatedAt: number }>();
  private readonly TOOL_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private routes: RunnerRoute[] = [];

  constructor(
    private readonly db: DatabaseService,
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
    private readonly uber: UberWebService,
    private readonly rappi: RappiWebService,
    private readonly googleWebLogin: GoogleWebLoginService,
    private readonly whatsapp: WhatsAppWebService,
    private readonly approvals: ApprovalsService,
    private readonly scheduledJobs: ScheduledJobsService,
    private readonly comms: CommunicationService,
    private readonly agentLoop: AgentLoopService,
    private readonly sandbox: SandboxService,
    private readonly intelligence: AgentIntelligenceService,
    private readonly pipeline: PipelineRunnerService,
  ) {
    this.initRoutes();
  }

  onApplicationBootstrap() {
    if (typeof this.events.on !== 'function') return; // test stub without consumer
    this.events.on('task.created', async (event) => {
      if (!event.taskId) return;
      await this.run(event.orgId, event.taskId);
    });
    // Close the approval → execute loop for Gmail / Calendar write operations.
    this.events.on('approval.resolved', async (event) => {
      const payload = event.payload as { approvalId?: string; status?: string } | undefined;
      if (payload?.status !== 'approved' || !payload.approvalId || !event.taskId) return;
      await this.executeApprovedAction(event.orgId, event.taskId, payload.approvalId);
    });
    this.logger.log('Agent runner subscribed to task.created + approval.resolved');
    // Re-queue any tasks that got stuck in a non-terminal state during a
    // previous run (app crashed, Redis event orphaned, etc.).
    void this.recoverStuckTasks();
  }

  /**
   * On startup: re-queue tasks stuck in `pending` (Redis event was lost during
   * a crash/restart) and fail tasks stuck in `planning` or `running` (process
   * died mid-execution).
   */
  private async recoverStuckTasks(): Promise<void> {
    const STUCK_PENDING_MS = 60_000;      // pending > 60s → re-fire task.created
    const STUCK_RUNNING_MS = 10 * 60_000; // planning/running > 10min → fail
    try {
      const stuck = await this.tasks.findStuck({ pendingOlderThanMs: STUCK_PENDING_MS, runningOlderThanMs: STUCK_RUNNING_MS });
      if (!stuck.length) return;
      this.logger.warn(`Found ${stuck.length} stuck task(s) — recovering`);
      for (const task of stuck) {
        if (task.status === 'pending') {
          await this.events.publish({ type: 'task.created', orgId: task.org_id, taskId: task.id, payload: { taskId: task.id, title: task.title } });
          this.logger.log(`Re-queued stuck pending task ${task.id}: "${task.title}"`);
        } else if (await this.hasRunningTrajectory(task.org_id, task.id)) {
          await this.db.admin
            .from('tasks')
            .update({ status: 'pending' })
            .eq('org_id', task.org_id)
            .eq('id', task.id);
          await this.events.publish({ type: 'task.created', orgId: task.org_id, taskId: task.id, payload: { taskId: task.id, resumed_from_checkpoint: true } });
          this.logger.log(`Re-queued checkpointed ${task.status} task ${task.id}: "${task.title}"`);
        } else {
          await this.failSafely(task.org_id, task.id, 'La tarea quedó incompleta al reiniciar el proceso.');
          this.logger.warn(`Failed stuck ${task.status} task ${task.id}: "${task.title}"`);
        }
      }
    } catch (err) {
      this.logger.warn(`recoverStuckTasks: ${(err as Error).message}`);
    }
  }

  private async hasRunningTrajectory(orgId: string, taskId: string): Promise<boolean> {
    const { data } = await this.db.admin
      .from('agent_trajectories')
      .select('id')
      .eq('org_id', orgId)
      .eq('task_id', taskId)
      .eq('outcome', 'running')
      .maybeSingle();
    return !!data;
  }

  private async answerWaitingInputIfAny(orgId: string, replyTask: Task, answer: string): Promise<boolean> {
    const { data: waitingTasks } = await this.db.admin
      .from('tasks')
      .select('id, created_by')
      .eq('org_id', orgId)
      .eq('created_by', replyTask.created_by)
      .eq('status', 'waiting_for_input')
      .order('updated_at', { ascending: false })
      .limit(1);
    const waiting = (waitingTasks ?? [])[0] as { id: string; created_by: string } | undefined;
    if (!waiting) return false;

    const { data: requests } = await this.db.admin
      .from('agent_input_requests')
      .select('id')
      .eq('org_id', orgId)
      .eq('task_id', waiting.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1);
    const request = (requests ?? [])[0] as { id: string } | undefined;
    if (!request) return false;

    const now = new Date().toISOString();
    await this.db.admin
      .from('agent_input_requests')
      .update({ status: 'answered', answer, answered_at: now })
      .eq('org_id', orgId)
      .eq('id', request.id);
    await this.db.admin
      .from('tasks')
      .update({ status: 'pending' })
      .eq('org_id', orgId)
      .eq('id', waiting.id);
    await this.tasks.transition(replyTask.id, orgId, 'planning');
    await this.tasks.transition(replyTask.id, orgId, 'running');
    await this.tasks.transition(replyTask.id, orgId, 'completed', {
      result: { text: 'Respuesta recibida. Continúo con la tarea pendiente.', model: 'input-resume' },
    });
    await this.events.publish({ type: 'task.created', orgId, taskId: waiting.id, payload: { resumed_from_input_request_id: request.id } });
    await this.deliver(orgId, replyTask.id, 'Respuesta recibida. Continúo con la tarea pendiente.', 'input-resume', 0);
    return true;
  }

  /** Picks the instant acknowledgment phrase for an order. */
  pickAck(text: string): { say: string; hint: string } {
    return ACK_RULES.find(({ pattern }) => pattern.test(text)) ?? DEFAULT_ACK;
  }

  private initRoutes() {
    this.routes = [
      {
        name: 'pure-image',
        priority: 100,
        risk: 'low',
        matches: (ctx) => ctx.pureImageRequest,
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.log(ctx.orgId, ctx.taskId, `tier=quick (${ctx.tier.reason}; media request) — image generation`, 'pipeline');
          const url = await this.generateImageReply(ctx.orgId, ctx.taskId, ctx.input, ctx.startedAt);
          if (url) {
            await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
            return true;
          }
          throw new Error('No pude generar la imagen con los proveedores configurados. Revisa las credenciales/modelos de imagen o intenta de nuevo si el proveedor esta saturado.');
        }
      },
      {
        name: 'otp-submission',
        priority: 95,
        risk: 'low',
        matches: (ctx) => this.isOtpSubmission(ctx.input, ctx.conversationContext),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.handleOtpSubmission(ctx.orgId, ctx.taskId, ctx.input, ctx.startedAt, ctx.conversationContext);
          return true;
        }
      },
      {
        name: 'rappi-login',
        priority: 90,
        risk: 'low',
        matches: (ctx) => RAPPI_SIGNALS.test(ctx.input) && RAPPI_EMAIL_LOGIN_SIGNALS.test(ctx.input),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.say(ctx.orgId, ctx.taskId, 'Abro Rappi e ingreso tu correo para iniciar sesión.');
          const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
          if (loopHandled) return true;
          await this.handleRappiEmailLogin(ctx.orgId, ctx.taskId, ctx.input, ctx.startedAt);
          return true;
        }
      },
      {
        name: 'uber-login',
        priority: 85,
        risk: 'low',
        matches: async (ctx) => UBER_EMAIL_LOGIN_SIGNALS.test(ctx.input) && !await this.isUberBrowserQuoteRequest(ctx.input, ctx.orgId, ctx.conversationContext, ctx.taskId),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.say(ctx.orgId, ctx.taskId, 'Abro Uber e ingreso tu correo para iniciar sesión.');
          const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
          if (loopHandled) return true;
          await this.handleUberEmailLogin(ctx.orgId, ctx.taskId, ctx.input, ctx.startedAt);
          return true;
        }
      },
      {
        name: 'google-manual-login',
        priority: 80,
        risk: 'low',
        matches: (ctx) => GOOGLE_BLOCKED_LOGIN_SIGNALS.test(ctx.input),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.handleGoogleManualLogin(ctx.orgId, ctx.taskId, ctx.startedAt);
          return true;
        }
      },
      {
        name: 'uber-quote',
        priority: 75,
        risk: 'medium',
        matches: (ctx) => this.isUberBrowserQuoteRequest(ctx.input, ctx.orgId, ctx.conversationContext, ctx.taskId),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.say(ctx.orgId, ctx.taskId, 'Abro Uber Web solo para cotizar y te mando screenshot antes de cualquier acción.');
          await this.log(ctx.orgId, ctx.taskId, 'uber quote request — opening Uber Web profile (quote-only)', 'tools');
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'uber');
          const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
          if (loopHandled) return true;
          await this.handleUberQuoteRequest(ctx.orgId, ctx.taskId, ctx.input, ctx.startedAt, ctx.conversationContext);
          return true;
        }
      },
      {
        name: 'whatsapp',
        priority: 70,
        risk: 'medium',
        matches: (ctx) => {
          const isWhatsAppContext = this.checkActiveToolContext(ctx.orgId, ctx.task.created_by, 'whatsapp');
          return (
            WHATSAPP_SIGNALS.test(ctx.input) ||
            this.isImplicitWhatsAppScreenshotRequest(ctx.input, ctx.conversationContext) ||
            (isWhatsAppContext && this.isWhatsAppFollowUp(ctx.input, ctx.conversationContext))
          );
        },
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.say(ctx.orgId, ctx.taskId, 'Abro WhatsApp Web con tu perfil local. Si falta login, te paso el QR.');
          await this.log(ctx.orgId, ctx.taskId, 'whatsapp request — opening WhatsApp Web profile', 'tools');
          const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
          if (loopHandled) return true;
          await this.handleWhatsAppRequest(ctx.orgId, ctx.taskId, ctx.task, ctx.input, ctx.startedAt, ctx.conversationContext);
          return true;
        }
      },
      {
        name: 'scheduled-jobs',
        priority: 65,
        risk: 'low',
        matches: (ctx) => this.isScheduleIntent(ctx.input),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
          if (loopHandled) return true;
          await this.handleScheduleIntent(ctx.orgId, ctx.taskId, ctx.task, ctx.input, ctx.startedAt);
          return true;
        }
      },
      {
        name: 'gmail-calendar-write',
        priority: 60,
        risk: 'medium',
        matches: (ctx) => this.isGmailWriteIntent(ctx.input) || this.isCalendarWriteIntent(ctx.input),
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          if (BULK_GUARD_SIGNALS.test(ctx.input)) {
            await this.deliver(ctx.orgId, ctx.taskId,
              '🚫 No ejecuto operaciones masivas sobre correos ni eventos. Indícame exactamente el correo o evento específico y te pido confirmación antes de cualquier cambio.',
              'safety', Date.now() - ctx.startedAt);
            return true;
          }
          if (this.isGmailWriteIntent(ctx.input)) {
            await this.say(ctx.orgId, ctx.taskId, 'Preparo la operación y te pido confirmación antes de ejecutarla 🛡️');
            this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'gmail');
          } else {
            await this.say(ctx.orgId, ctx.taskId, 'Preparo el cambio en tu agenda y te pido confirmación 🗓️');
            this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'calendar');
          }
          const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
          if (loopHandled) return true;
          if (this.isGmailWriteIntent(ctx.input)) {
            await this.handleGmailWriteIntent(ctx.orgId, ctx.taskId, ctx.task, ctx.input, ctx.startedAt);
          } else {
            await this.handleCalendarWriteIntent(ctx.orgId, ctx.taskId, ctx.task, ctx.input, ctx.startedAt);
          }
          return true;
        }
      },
      {
        name: 'chat-tier',
        priority: 55,
        risk: 'low',
        matches: (ctx) => ctx.tier.tier === 'chat',
        handler: async (ctx) => {
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.log(ctx.orgId, ctx.taskId, `tier=chat (${ctx.tier.reason}) — direct model, cheap tier`, 'pipeline');
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'chat');
          if (this.isPersonalProfileQuestion(ctx.input)) {
            const handled = await this.answerPersonalProfileQuestion(ctx.orgId, ctx.taskId, ctx.input, ctx.startedAt);
            if (handled) return true;
          }
          const t0 = Date.now();
          const chatInput = this.buildChatContextualInput(
            ctx.input,
            ctx.conversationContext,
            ctx.soulContext,
            ctx.proactiveTriggers.map(t => t.message),
            ctx.recallResult.context,
          );
          const reply = await this.modelRouter.generate(chatInput, {
            orgId: ctx.orgId,
            taskId: ctx.taskId,
            requestType: 'response',
            budget: 'cheap',
            maxTokens: 300,
            systemPrompt: CHAT_PROMPT,
          });
          await this.deliver(ctx.orgId, ctx.taskId, reply.text, reply.model, Date.now() - t0);
          await this.log(ctx.orgId, ctx.taskId, `chat answered in ${Date.now() - ctx.startedAt}ms`, 'pipeline');
          return true;
        }
      },
      {
        name: 'capability-gate',
        priority: 50,
        risk: 'low',
        matches: async (ctx) => !!(await this.capabilityGate.firstMissingRequirement(ctx.input, ctx.orgId)),
        handler: async (ctx) => {
          const missingReq = await this.capabilityGate.firstMissingRequirement(ctx.input, ctx.orgId);
          if (!missingReq) return false;
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'planning');
          await this.tasks.transition(ctx.taskId, ctx.orgId, 'running');
          await this.log(
            ctx.orgId, ctx.taskId,
            `capability gate blocked: "${missingReq.capability}" not configured — soft gate: will try partial progress`,
            'gate',
          );
          // R2.3: emit setup card (same as before) so user knows what to connect
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
            orgId: ctx.orgId,
            taskId: ctx.taskId,
            payload: setupPayload,
          });
          await this.say(ctx.orgId, ctx.taskId, missingReq.ack_message);
          // R4.2: register capability gap
          await this.intelligence.registerCapabilityGap(
            ctx.orgId, ctx.taskId, missingReq.capability, ctx.input, 3,
            { integration: missingReq.integrations?.[0]?.provider, kind: missingReq.integrations?.[0]?.kind },
          ).catch(() => undefined);
          // R2.3: instead of terminating, pass to loop with restriction context so it
          // advances everything possible and leaves only the locked step pending
          const restrictionCtx = `LIMITACIÓN: "${missingReq.capability}" no está configurado aún (${missingReq.user_message.slice(0, 120)}). Avanza TODO lo que no requiera esta integración. Prepara el resultado final. Para el paso que necesita ${missingReq.capability}, describe exactamente qué ejecutarías y deja la tarea en waiting_for_input con ask_user pidiendo al usuario que complete el setup. NO prometas usar ${missingReq.capability} hasta que esté disponible.`;
          const outcome = await this.agentLoop.run(ctx.orgId, ctx.taskId, ctx.input, {
            context: restrictionCtx,
            userId: ctx.task.created_by,
            log: (message, scope) => this.log(ctx.orgId, ctx.taskId, message, scope),
          });
          if (outcome.ok && outcome.text) {
            await this.deliver(ctx.orgId, ctx.taskId, outcome.text, 'agent-partial', Date.now() - ctx.startedAt);
            await this.tasks.transition(ctx.taskId, ctx.orgId, 'completed', {
              result: { text: outcome.text, model: 'agent-partial', latency_ms: Date.now() - ctx.startedAt },
            });
          } else {
            // fallback: terminate with setup message if loop produced nothing
            await this.tasks.transition(ctx.taskId, ctx.orgId, 'waiting_for_approval', {
              result: { text: missingReq.user_message, model: 'capability-gate' },
            });
          }
          return true;
        }
      },
      {
        name: 'long-script',
        priority: 45,
        risk: 'medium',
        matches: (ctx) => ctx.tier.tier === 'long' && this.forge.isScriptTask(ctx.input),
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'script');
          const outcome = await this.forge.forge(ctx.orgId, ctx.taskId, ctx.contextualInput, (message, scope) => this.log(ctx.orgId, ctx.taskId, message, scope));
          const summary = [
            `Generé el script **${outcome.filename}** (${outcome.language}): ${outcome.description}`,
            outcome.skillSlug ? `Quedó registrado como skill \`${outcome.skillSlug}\` y como artifact.` : 'Quedó guardado como artifact.',
            outcome.executed
              ? `Lo ejecuté en un sandbox Docker (sin red) y esta fue la salida:\n\n${outcome.output || '(sin salida)'}`
              : outcome.note ?? '',
          ].filter(Boolean).join('\n\n');
          await this.deliver(ctx.orgId, ctx.taskId, summary, 'script-forge', Date.now() - ctx.startedAt);
          await this.maybeAttachMedia(ctx.orgId, ctx.taskId, ctx.input, summary);
          await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
          return true;
        }
      },
      {
        name: 'multi-phase-pipeline',
        priority: 43,
        risk: 'high',
        matches: (ctx) => ctx.tier.tier !== 'chat' && this.pipeline.isMultiPhase(ctx.input),
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'pipeline');
          await this.log(ctx.orgId, ctx.taskId, `multi-phase pipeline detectado — sintetizando fases`, 'pipeline');

          // Build identity context so phases know who the user is
          const contextParts: string[] = [];
          const identity = ctx.soulContext ? this.slimIdentityLine(ctx.soulContext) : null;
          if (identity) contextParts.push(`Usuario: ${identity}`);
          if (ctx.conversationContext.length > 0) {
            contextParts.push(
              ctx.conversationContext
                .slice(-4)
                .map((t) => `${t.role === 'user' ? 'Usuario' : 'EVA'}: ${t.text.slice(0, 300)}`)
                .join('\n'),
            );
          }

          const outcome = await this.pipeline.run(ctx.orgId, ctx.taskId, ctx.input, {
            userId: ctx.task.created_by,
            context: contextParts.join('\n') || undefined,
            log: (message, scope) => this.log(ctx.orgId, ctx.taskId, message, scope),
          });

          await this.log(
            ctx.orgId, ctx.taskId,
            `pipeline terminado — ${outcome.phases.length} fases, ${outcome.totalSteps} pasos totales, ${outcome.totalTokens} tokens, ${(outcome.durationMs / 1000).toFixed(1)}s`,
            'pipeline',
          );
          await this.deliver(ctx.orgId, ctx.taskId, outcome.text, 'multi-phase-pipeline', Date.now() - ctx.startedAt);
          await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
          this.digester.digestAsync({ orgId: ctx.orgId, taskId: ctx.taskId, userInput: ctx.input, evaReply: outcome.text, conversationContext: ctx.conversationContext });
          return true;
        },
      },
      {
        name: 'medium-agent-loop',
        priority: 42,
        risk: 'medium',
        matches: (ctx) => ctx.tier.tier === 'medium',
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'agent_loop');
          const handled = await this.runAgentLoop(
            ctx.orgId,
            ctx.taskId,
            ctx.input,
            ctx.conversationContext,
            ctx.startedAt,
            ctx.task.created_by,
            ctx.soulContext,
            await this.maxStepsForTier(ctx.orgId, 'medium'),
          );
          if (handled) return true;
          await this.log(ctx.orgId, ctx.taskId, 'agent-loop no resolvió — usando pipeline clásico', 'loop');
          return false;
        }
      },
      {
        name: 'long-agent-loop',
        priority: 40,
        risk: 'high',
        matches: (ctx) => ctx.tier.tier === 'long',
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'agent_loop');
          const handled = await this.runAgentLoop(
            ctx.orgId,
            ctx.taskId,
            ctx.input,
            ctx.conversationContext,
            ctx.startedAt,
            ctx.task.created_by,
            ctx.soulContext,
            await this.maxStepsForTier(ctx.orgId, 'long'),
          );
          if (handled) return true;
          await this.log(ctx.orgId, ctx.taskId, 'agent-loop no resolvió — usando pipeline clásico', 'loop');
          return false;
        }
      },
      {
        name: 'email-read',
        priority: 35,
        risk: 'low',
        matches: (ctx) => ctx.ack.hint === 'email' || EMAIL_SIGNALS.test(ctx.input),
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'gmail');
          await this.log(ctx.orgId, ctx.taskId, 'email request — querying Gmail API', 'tools');

          const searchQuery = this.extractEmailSearch(ctx.input);
          let gmailResult: GmailFetchResult;

          if (searchQuery) {
            await this.log(ctx.orgId, ctx.taskId, `Gmail search: "${searchQuery}" (recent first, fallback to all-time)`, 'tools');
            gmailResult = await this.gmail.fetchSearchWithFallback(ctx.orgId, searchQuery);
            if (!gmailResult.ok && gmailResult.reason === 'empty') {
              const sender = searchQuery.startsWith('from:') ? searchQuery.replace('from:', '') : searchQuery;
              const notFound = `📬 No encontré correos de _${sender}_ ni en los últimos 3 meses ni en tu historial.`;
              await this.deliver(ctx.orgId, ctx.taskId, notFound, 'gmail-api', 0);
              await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
              return true;
            }
          } else {
            const limit = this.emailRequestedLimit(ctx.input);
            await this.log(ctx.orgId, ctx.taskId, `Gmail fetchLatest limit=${limit}`, 'tools');
            gmailResult = await this.gmail.fetchLatest(ctx.orgId, limit);
          }

          if (gmailResult.ok) {
            await this.deliver(ctx.orgId, ctx.taskId, gmailResult.text, 'gmail-api', 0);
            await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
            this.digester.digestAsync({ orgId: ctx.orgId, taskId: ctx.taskId, userInput: ctx.input, evaReply: gmailResult.text, conversationContext: ctx.conversationContext });
            return true;
          }

          const reply = this.gmailErrorMessage(gmailResult.reason, gmailResult.error);
          await this.log(ctx.orgId, ctx.taskId, `Gmail: ${gmailResult.reason} — ${gmailResult.error ?? 'no detail'}`, 'tools');
          await this.deliver(ctx.orgId, ctx.taskId, reply, 'gmail-api', 0);
          await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
          return true;
        }
      },
      {
        name: 'calendar-read',
        priority: 30,
        risk: 'low',
        matches: (ctx) => ctx.ack.hint === 'calendar' || CALENDAR_SIGNALS_PERSONAL.test(ctx.input),
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'calendar');
          await this.log(ctx.orgId, ctx.taskId, 'calendar request — querying local schedule + Google Calendar', 'tools');
          const [localBlock, gcalBlock] = await Promise.all([
            this.schedule.formatUpcomingForSoul(ctx.orgId, 7).catch(() => null),
            this.calendar.formatUpcomingForSoul(ctx.orgId, 7).catch(() => null),
          ]);
          const agendaText = this.mergeScheduleBlocks(localBlock, gcalBlock);
          if (agendaText) {
            const reply = `📅 Tu agenda próxima:\n\n${agendaText}`;
            await this.deliver(ctx.orgId, ctx.taskId, reply, 'calendar-api', 0);
            await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
            this.digester.digestAsync({ orgId: ctx.orgId, taskId: ctx.taskId, userInput: ctx.input, evaReply: reply, conversationContext: ctx.conversationContext });
            return true;
          }
          await this.log(ctx.orgId, ctx.taskId, 'No calendar events found — falling to model', 'tools');
          return false;
        }
      },
      {
        name: 'drive-read',
        priority: 25,
        risk: 'low',
        matches: (ctx) => ctx.ack.hint === 'drive' || DRIVE_SIGNALS.test(ctx.input),
        handler: async (ctx) => {
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'drive');
          await this.log(ctx.orgId, ctx.taskId, 'drive request — querying Google Drive API', 'tools');
          const driveResult = await this.drive.fetchForQuery(ctx.orgId, ctx.input);

          if (driveResult.ok) {
            await this.deliver(ctx.orgId, ctx.taskId, driveResult.text, 'drive-api', 0);
            await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
            this.digester.digestAsync({ orgId: ctx.orgId, taskId: ctx.taskId, userInput: ctx.input, evaReply: driveResult.text, conversationContext: ctx.conversationContext });
            return true;
          }

          const reply = this.driveErrorMessage(driveResult.reason, driveResult.error);
          await this.log(ctx.orgId, ctx.taskId, `Drive: ${driveResult.reason} — ${driveResult.error ?? 'no detail'}`, 'tools');
          await this.deliver(ctx.orgId, ctx.taskId, reply, 'drive-api', 0);
          await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
          return true;
        }
      },
      {
        name: 'research',
        priority: 20,
        risk: 'low',
        matches: (ctx) => this.shouldUseResearch(ctx.input, ctx.routingInput, ctx.ack.hint, ctx.freshness.required),
        handler: async (ctx) => {
          await this.logToolRouting(ctx);
          const directPublicApi = this.shouldUsePublicApiDirect(ctx.input, ctx.ack.hint);
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, directPublicApi ? 'api' : 'search');
          await this.log(
            ctx.orgId,
            ctx.taskId,
            directPublicApi
              ? 'consultando API pública directa (sin planificador LLM)'
              : 'buscando en internet con Chromium… (web-search tool)',
            directPublicApi ? 'api' : 'web',
          );
          const researchInput = directPublicApi
            ? ctx.input
            : await this.planResearchInput(ctx.orgId, ctx.taskId, ctx.contextualInput, ctx.input);
          const t0 = Date.now();
          const answer = await this.research.answer(researchInput, ctx.orgId);
          const elapsed = Date.now() - t0;
          await this.log(ctx.orgId, ctx.taskId, `tool ${answer.tool} answered in ${elapsed}ms`, 'tools');
          await this.deliver(ctx.orgId, ctx.taskId, answer.text, answer.tool, elapsed);
          await this.maybeAttachMedia(ctx.orgId, ctx.taskId, ctx.input, answer.text);
          await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
          this.digester.digestAsync({ orgId: ctx.orgId, taskId: ctx.taskId, userInput: ctx.input, evaReply: answer.text, conversationContext: ctx.conversationContext });
          return true;
        }
      },
      {
        name: 'model-call',
        priority: 10,
        risk: 'low',
        matches: () => true,
        handler: async (ctx) => {
          await this.logToolRouting(ctx);
          const budget = ctx.tier.tier === 'quick' ? 'cheap' : 'balanced';
          this.updateActiveToolSession(ctx.orgId, ctx.task.created_by, 'model');
          await this.log(ctx.orgId, ctx.taskId, `calling model (budget=${budget}, org keys first, env fallback)…`, 'model');
          const t0 = Date.now();
          const result = await this.modelRouter.generate(ctx.contextualInput, {
            orgId: ctx.orgId,
            taskId: ctx.taskId,
            requestType: 'response',
            budget,
            systemPrompt: SYSTEM_PROMPT,
            maxTokens: ctx.tier.tier === 'long' ? 1200 : 700,
          });
          const elapsed = Date.now() - t0;
          await this.log(
            ctx.orgId, ctx.taskId,
            `model ${result.model} (${result.backend}) answered in ${elapsed}ms — ${result.usage.totalTokens} tokens`,
            'model',
          );

          const staleReason = this.staleModelAnswerReason(ctx.routingInput, result.text, ctx.freshness.required);
          if (this.isUselessAnswer(result.text) || staleReason) {
            const reason = staleReason ?? 'non-actionable';
            await this.log(ctx.orgId, ctx.taskId, `model answer rejected as ${reason}; trying project tools`, 'model');
            const loopHandled = await this.runAgentLoop(ctx.orgId, ctx.taskId, ctx.input, ctx.conversationContext, ctx.startedAt, ctx.task.created_by, ctx.soulContext);
            if (loopHandled) return true;
            const recovered = await this.recoverWithTools(ctx.orgId, ctx.taskId, ctx.contextualInput, ctx.startedAt, ctx.input);
            if (recovered) return true;
          }

          await this.deliver(ctx.orgId, ctx.taskId, result.text, result.model, elapsed);
          await this.maybeAttachMedia(ctx.orgId, ctx.taskId, ctx.input, result.text);
          await this.log(ctx.orgId, ctx.taskId, `done in ${Date.now() - ctx.startedAt}ms total`, 'pipeline');
          this.digester.digestAsync({ orgId: ctx.orgId, taskId: ctx.taskId, userInput: ctx.input, evaReply: result.text, conversationContext: ctx.conversationContext });
          return true;
        }
      }
    ];
  }

  private async logToolRouting(ctx: RouteContext): Promise<void> {
    const directPublicApi = this.shouldUsePublicApiDirect(ctx.input, ctx.ack.hint);
    const shouldUseResearch = this.shouldUseResearch(ctx.input, ctx.routingInput, ctx.ack.hint, ctx.freshness.required);
    const capability = directPublicApi ? 'api' : shouldUseResearch ? 'search' : 'generate';
    try {
      const route = this.toolRouter.route(capability);
      await this.log(
        ctx.orgId, ctx.taskId,
        `tool-router: capability "${capability}" → ${route.tool.name} (score ${route.score.toFixed(3)}, ~${route.tool.avgLatencyMs}ms)`,
        'tools',
      );
    } catch {
      await this.log(ctx.orgId, ctx.taskId, `tool-router: no tool for "${capability}", going straight to the model`, 'tools');
    }
  }

  async run(orgId: string, taskId: string): Promise<void> {
    let task: Task;
    try {
      task = await this.tasks.getTask(taskId, orgId);
    } catch {
      return; // task vanished — nothing to do
    }
    if (task.status !== 'pending') return;

    const rawInput = task.description ?? task.title;

    // Check if user is replying to a pending approval request
    const inputForCheck = rawInput ? rawInput.trim().toLowerCase() : '';
    const isConfirm = APPROVE_KEYWORDS.test(inputForCheck);
    const isCancel = REJECT_KEYWORDS.test(inputForCheck);

    if (isConfirm || isCancel) {
      const { data: waitingTasks } = await this.db.admin
        .from('tasks')
        .select('*')
        .eq('org_id', orgId)
        .eq('created_by', task.created_by)
        .eq('status', 'waiting_for_approval')
        .order('created_at', { ascending: false })
        .limit(1);

      if (waitingTasks && waitingTasks.length > 0) {
        const waitingTask = waitingTasks[0];
        const { data: pendingApprovals } = await this.db.admin
          .from('approvals')
          .select('*')
          .eq('org_id', orgId)
          .eq('task_id', waitingTask.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1);

        if (pendingApprovals && pendingApprovals.length > 0) {
          const approval = pendingApprovals[0];

          await this.tasks.transition(taskId, orgId, 'planning');
          await this.tasks.transition(taskId, orgId, 'running');

          if (isConfirm) {
            await this.log(orgId, taskId, `User confirmed approval ${approval.id} via chat: "${rawInput}"`, 'approval');
            await this.approvals.approve(approval.id, orgId, task.created_by);
            await this.deliver(orgId, taskId, 'Aprobación recibida. Ejecutando la acción...', 'approval-chat', 0);
          } else {
            await this.log(orgId, taskId, `User rejected approval ${approval.id} via chat: "${rawInput}"`, 'approval');
            await this.approvals.reject(approval.id, orgId, task.created_by, 'Cancelado por el usuario en el chat');
            await this.tasks.transition(waitingTask.id, orgId, 'cancelled', {
              result: { text: 'La acción fue desaprobada y la tarea se canceló.', model: 'approval-chat' },
            });
            await this.deliver(orgId, taskId, 'Entendido. Cancelé la acción y la tarea pendiente.', 'approval-chat', 0);
          }
          return;
        }
      }
    }

    const answeredInput = await this.answerWaitingInputIfAny(orgId, task, rawInput);
    if (answeredInput) return;

    // R1.2: retry handler — "reintenta" / "opción N" resumes with failure context injected
    if (RETRY_INTENT_RE.test(inputForCheck)) {
      const retryCtx = await this.intelligence.loadRetryContext(orgId, task.created_by).catch(() => null);
      if (retryCtx && retryCtx.retry_count < 2) {
        const optionMatch = rawInput.match(OPTION_NUMBER_RE);
        const chosenIndex = optionMatch ? Math.max(0, parseInt(optionMatch[1], 10) - 1) : 0;
        const chosenStrategy = retryCtx.options[chosenIndex] ?? retryCtx.suggested_strategy;
        const augmentedCtx = { ...retryCtx, suggested_strategy: chosenStrategy, retry_count: retryCtx.retry_count + 1 };
        await this.tasks.transition(taskId, orgId, 'planning');
        await this.tasks.transition(taskId, orgId, 'running');
        await this.log(orgId, taskId, `retry handler: reusing context from task ${retryCtx.root_task_id} (retry_count=${augmentedCtx.retry_count})`, 'retry');
        const outcome = await this.agentLoop.run(orgId, taskId, retryCtx.goal, {
          context: rawInput,
          retryContext: augmentedCtx,
          userId: task.created_by,
          log: (message, scope) => this.log(orgId, taskId, message, scope),
        });
        if (outcome.ok) {
          await this.deliver(orgId, taskId, outcome.text, 'agent-retry', 0);
          await this.tasks.transition(taskId, orgId, 'completed', { result: { text: outcome.text, model: 'agent-retry', latency_ms: 0 } });
        } else {
          await this.failSafely(orgId, taskId, `Tercer intento agotado para: ${retryCtx.goal.slice(0, 200)}`);
        }
        return;
      }
    }

    // Detect cross-channel routing intent before any other processing.
    const crossChannel = this.extractCrossChannelTarget(rawInput);
    const input = crossChannel ? this.stripCrossChannelClause(rawInput) : rawInput;
    if (crossChannel) {
      // Pre-flight: verify the target channel is actually configured before we commit.
      const activeChannels = await this.comms.listActiveChannels(orgId).catch(() => ['dashboard'] as CommunicationChannel[]);
      if (activeChannels.includes(crossChannel)) {
        this.crossChannelCtx.set(taskId, { channel: crossChannel, userId: task.created_by });
      } else {
        // Channel not configured — inform the user via the originating channel and continue normally.
        await this.tasks.transition(taskId, orgId, 'planning');
        await this.tasks.transition(taskId, orgId, 'running');
        const availableList = activeChannels.filter((c) => c !== 'dashboard').join(', ') || 'ninguno configurado aún';
        await this.deliver(orgId, taskId,
          `⚠️ El canal **${crossChannel}** no está activo o no tienes una cuenta vinculada.\n\nCanales disponibles: ${availableList}.`,
          'channel-check', 0);
        return;
      }
    }
    const startedAt = Date.now();
    // Always classify tier and freshness from raw input — routingInput includes
    // conversation history which can make short drive/email requests appear as
    // tier='long' (length > 280) and produce wrong ACKs/routing.
    const freshness = this.needsFreshness(input);
    const tier = this.applyFreshnessToTier(classifyTier(input), freshness);
    const wantsImage = this.media.wantsImage(input);
    const pureImageRequest = wantsImage && this.isPureImageRequest(input);
    const ack = tier.tier === 'long'
      ? { say: LONG_TASK_ACK, hint: 'background' }
      : this.pickAck(input);

    // Tareas largas: el ack corto sale ANTES de cargar contexto (soul, agenda,
    // memoria), para que el usuario sepa en <1s que EVA ya está en ello.
    let ackSent = false;
    if (tier.tier === 'long') {
      await this.say(orgId, taskId, ack.say);
      ackSent = true;
    }

    const conversationContext = await this.getConversationContext(task);

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

    const ctx: RouteContext = {
      orgId,
      taskId,
      task,
      rawInput,
      input,
      crossChannel,
      conversationContext,
      soulContext,
      calendarBlock,
      patternBlock,
      proactiveTriggers,
      recallResult,
      routingInput,
      contextualInput,
      startedAt,
      freshness,
      tier,
      wantsImage,
      pureImageRequest,
      ack,
    };

    try {
      let inStandardPipeline = false;

      for (const route of this.routes) {
        const matches = await route.matches(ctx);
        if (matches) {
          if (route.priority <= 45 && !inStandardPipeline) {
            inStandardPipeline = true;
            if (!ackSent) {
              await this.say(orgId, taskId, ack.say);
              ackSent = true;
            }
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
          }

          const handled = await route.handler(ctx);
          if (handled !== false) {
            return;
          }
        }
      }
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        await this.log(orgId, taskId, 'Ejecución abortada: la tarea fue cancelada por el usuario.', 'pipeline');
        return;
      }
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
    const cross = this.crossChannelCtx.get(taskId);
    this.crossChannelCtx.delete(taskId); // clean up regardless of outcome
    const payload: Record<string, unknown> = { text, model, latency_ms: latencyMs };
    if (cross) {
      payload['cross_channel_target'] = cross.channel;
      payload['cross_channel_user_id'] = cross.userId;
    }
    await this.events.publish({ type: 'task.result', orgId, taskId, payload });
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

  private async handleWhatsAppRequest(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
    conversationContext: ConversationContextTurn[],
  ): Promise<void> {
    const wantsScreenshot = this.wantsWhatsAppScreenshot(input, conversationContext);
    if (wantsScreenshot) {
      const session = await this.whatsapp.captureSessionScreenshot(orgId, taskId);
      if (session.state === 'logged_in') {
        await this.maybePublishBrowserScreenshot(orgId, taskId, session.screenshot, 'WhatsApp Web');
        const text = session.screenshot?.image_base64
          ? 'Te envié una captura de WhatsApp Web con tus conversaciones visibles.'
          : 'WhatsApp Web está conectado, pero no pude generar la captura en este intento.';
        await this.deliver(orgId, taskId, text, 'whatsapp-web', Date.now() - startedAt);
        return;
      }

      await this.maybePublishWhatsAppQr(orgId, taskId, session.screenshot);
      const text = session.state === 'qr_required'
        ? 'Abrí WhatsApp Web, pero falta vincular la sesión. Escanea el QR y vuelve a pedir la captura.'
        : 'WhatsApp Web todavía está cargando. Espera unos segundos y vuelve a pedir la captura.';
      await this.deliver(orgId, taskId, text, 'whatsapp-web', Date.now() - startedAt);
      return;
    }

    const activeSession = this.activeToolSessions.get(`${orgId}:${task.created_by}`);
    const wantsUnansweredStatus = WHATSAPP_UNANSWERED_SIGNALS.test(input);
    if (WHATSAPP_SEND_SIGNALS.test(input) && !wantsUnansweredStatus) {
      const session = await this.whatsapp.startSession(orgId, taskId);
      if (session.state === 'qr_required') {
        // El QR sí se envía como imagen: el usuario lo necesita para vincular.
        await this.maybePublishWhatsAppQr(orgId, taskId, session.screenshot);
        const text = 'Primero escanea el QR para vincular WhatsApp Web. Después podré preparar una respuesta; cualquier envío real tendrá que pasar por Approval Engine.';
        await this.deliver(orgId, taskId, text, 'whatsapp-web', Date.now() - startedAt);
        return;
      }

      let draft = this.extractWhatsAppDraft(input);
      if (draft) {
        const isPronoun = !draft.contact || /^(le|la|lo|el|ese|él|ella|ellos|contacto|chat)$/i.test(draft.contact);
        if (isPronoun) {
          const fallback = activeSession?.tool === 'whatsapp' ? activeSession.details?.contact : null;
          if (fallback) {
            draft = { contact: fallback, text: draft.text };
          }
        }
      }

      if (!draft || !draft.contact) {
        const text = 'WhatsApp Web está listo. Para responder necesito que me digas el contacto y el texto exacto; cualquier envío real tendrá que pasar por Approval Engine.';
        await this.deliver(orgId, taskId, text, 'whatsapp-web', Date.now() - startedAt);
        return;
      }

      const approval = await this.approvals.requestForPreparedAction({
        orgId,
        userId: task.created_by,
        taskId,
        actionType: 'whatsapp.message.send',
        source: 'browser',
        payload: {
          session_id: session.session_id,
          contact: draft.contact,
          text: draft.text,
          send_evidence: wantsEvidence(input),
        },
        summary: `Enviar WhatsApp a ${draft.contact}: ${draft.text.slice(0, 160)}`,
        notify: false, // este texto ya es la solicitud de aprobación
      });
      const text = `Voy a enviar este WhatsApp a **${draft.contact}**:\n\n"${draft.text}"\n\n¿Lo envío? Responde **sí** para enviarlo o **no** para cancelar.`;
      await this.events.publish({
        type: 'task.result',
        orgId,
        taskId,
        payload: { text, model: 'whatsapp-web', latency_ms: Date.now() - startedAt },
      });
      this.updateActiveToolSession(orgId, task.created_by, 'whatsapp', { contact: draft.contact });
      await this.tasks.transition(taskId, orgId, 'waiting_for_approval', {
        result: { text, model: 'whatsapp-web', approval_id: approval.id },
      });
      return;
    }

    const contactToRead = this.extractWhatsAppContactToRead(input);
    const resolvedContact = contactToRead || (activeSession?.tool === 'whatsapp' ? activeSession.details?.contact : null);

    const shouldRead = WHATSAPP_READ_SIGNALS.test(input) || wantsUnansweredStatus || !!resolvedContact;
    if (!shouldRead) {
      const session = await this.whatsapp.startSession(orgId, taskId);
      if (session.state !== 'logged_in') {
        await this.maybePublishWhatsAppQr(orgId, taskId, session.screenshot);
      }
      const text = session.state === 'logged_in'
        ? 'WhatsApp Web está conectado y el perfil local quedó listo para consultas.'
        : 'Abrí WhatsApp Web. Escanea el QR con tu teléfono; cuando termine, la sesión quedará guardada en el perfil local.';
      await this.deliver(orgId, taskId, text, 'whatsapp-web', Date.now() - startedAt);
      return;
    }

    const result = wantsUnansweredStatus
      ? await this.whatsapp.fetchUnansweredMessages(orgId, taskId)
      : resolvedContact
        ? await this.whatsapp.fetchContactMessages(orgId, resolvedContact, taskId)
        : WHATSAPP_UNREAD_SIGNALS.test(input)
          ? await this.whatsapp.fetchUnreadMessages(orgId, taskId)
          : await this.whatsapp.fetchLatestMessage(orgId, taskId);
    // La captura solo se manda si el usuario pidió evidencia; el QR solo si hace falta vincular.
    if (resolvedContact && wantsEvidence(input)) {
      await this.maybePublishBrowserScreenshot(orgId, taskId, result.session.screenshot, 'WhatsApp Web');
    } else if (!resolvedContact && result.session.state === 'qr_required') {
      await this.maybePublishWhatsAppQr(orgId, taskId, result.session.screenshot);
    }

    let replyText = result.text;
    if (result.session.screenshot?.image_base64 && (resolvedContact || !wantsUnansweredStatus)) {
      try {
        await this.log(orgId, taskId, 'Analyzing WhatsApp Web screenshot with Vision model for context...', 'pipeline');
        const visionPrompt = `
El usuario hizo la siguiente petición sobre este chat de WhatsApp: "${input}"

Aquí tienes la lista de mensajes extraídos por DOM (puede estar incompleta o vacía):
${('messages' in result && result.messages) ? result.messages.join('\n') : '(Ninguno extraído por DOM)'}

Analiza la captura de pantalla de WhatsApp Web provista para:
1. Leer los mensajes del chat que sean visibles (tanto entrantes como salientes).
2. Complementar la lista de mensajes extraídos si falta alguno.
3. Responder con precisión y de forma conversacional a la petición del usuario (por ejemplo, si pide el último mensaje, indícalo claramente indicando quién lo envió, la hora y el contenido).
4. Si la petición es solo mostrar el chat, resume brevemente la última parte de la conversación.

Responde directamente al usuario en español, con un tono amable y natural.
`;
        const visionRes = await this.modelRouter.generate(visionPrompt, {
          orgId,
          taskId,
          imageBase64: result.session.screenshot.image_base64,
          imageMimeType: result.session.screenshot.mime_type || 'image/png',
          systemPrompt: 'Eres EVA, una asistente de IA capaz de ver y analizar capturas de pantalla para responder a las solicitudes de los usuarios.',
        });
        if (visionRes?.text) {
          replyText = visionRes.text;
          await this.log(orgId, taskId, 'Vision model analysis successful, replaced response text', 'pipeline');
        }
      } catch (visionErr) {
        this.logger.warn(`Failed to analyze screenshot with Vision model: ${(visionErr as Error).message}`);
      }
    }

    await this.deliver(orgId, taskId, replyText, 'whatsapp-web', Date.now() - startedAt);
    await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
    if (result.ok) {
      this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: replyText, conversationContext });
      const actualContact = 'contact' in result ? result.contact : resolvedContact;
      this.updateActiveToolSession(orgId, task.created_by, 'whatsapp', actualContact ? { contact: actualContact } : undefined);
    }
  }

  private async handleUberQuoteRequest(
    orgId: string,
    taskId: string,
    input: string,
    startedAt: number,
    conversationContext: ConversationContextTurn[],
  ): Promise<void> {
    let route: { origin: string; destination: string; url?: string } | null;
    try {
      route = await this.extractUberRoute(input, orgId, conversationContext, true, taskId);
    } catch (err) {
      if (err instanceof MissingInformationError) {
        await this.requestMissingInformation(orgId, taskId, err);
        return;
      }
      throw err;
    }
    if (!route) return;
    const result = await this.uber.estimateRide(orgId, {
      origin: route.origin,
      destination: route.destination,
      url: route.url,
      taskId,
    });
    await this.maybePublishBrowserScreenshot(orgId, taskId, result.session.screenshot, 'Uber Web');
    await this.deliver(orgId, taskId, result.text, 'uber-web', Date.now() - startedAt);
    await this.log(orgId, taskId, `Uber Web quote finished: ${result.reason}`, 'tools');
    if (result.ok) {
      this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: result.text, conversationContext });
    }
  }

  private async isUberBrowserQuoteRequest(input: string, orgId: string, context: ConversationContextTurn[] = [], taskId?: string): Promise<boolean> {
    if (/m\.uber\.com/i.test(input)) return true;
    if (UBER_SIGNALS.test(input) && !UBER_EMAIL_LOGIN_SIGNALS.test(input)) {
      if (/\buber\b/i.test(input)) return true;
      const route = await this.extractUberRoute(input, orgId, context, false, taskId);
      if (route) return true;
    }
    return false;
  }

  private isOtpSubmission(input: string, conversationContext: ConversationContextTurn[]): boolean {
    if (!OTP_SUBMIT_SIGNALS.test(input)) return false;
    const lastEvaReply = [...conversationContext].reverse().find(t => t.role === 'assistant')?.text ?? '';
    return OTP_PENDING_CONTEXT.test(lastEvaReply);
  }

  private async handleOtpSubmission(
    orgId: string,
    taskId: string,
    input: string,
    startedAt: number,
    conversationContext: ConversationContextTurn[],
  ): Promise<void> {
    const code = (OTP_SUBMIT_SIGNALS.exec(input)?.[1] ?? input.trim()).replace(/\s+/g, '');
    const lastEvaReply = [...conversationContext].reverse().find(t => t.role === 'assistant')?.text ?? '';
    const isRappi = /rappi/i.test(lastEvaReply);
    const isUber = /uber/i.test(lastEvaReply);

    if (isRappi) {
      await this.log(orgId, taskId, `submitting OTP code to Rappi (${code.length} digits)`, 'tools');
      const result = await this.rappi.submitLoginCode(orgId, code);
      if (result.screenshot) await this.maybePublishBrowserScreenshot(orgId, taskId, result.screenshot, 'Rappi');
      await this.deliver(orgId, taskId, result.text, 'rappi-web', Date.now() - startedAt);
      return;
    }

    if (isUber) {
      await this.log(orgId, taskId, `submitting OTP code to Uber (${code.length} digits)`, 'tools');
      const result = await this.uber.submitLoginCode(orgId, code, taskId);
      if (result.screenshot) await this.maybePublishBrowserScreenshot(orgId, taskId, result.screenshot, 'Uber Web');
      await this.deliver(orgId, taskId, result.text, 'uber-web', Date.now() - startedAt);
      return;
    }

    await this.deliver(orgId, taskId, 'Recibí el código pero no encontré una sesión de Uber o Rappi esperando verificación.', 'otp-handler', Date.now() - startedAt);
  }

  private async handleUberEmailLogin(
    orgId: string,
    taskId: string,
    input: string,
    startedAt: number,
  ): Promise<void> {
    const email = this.extractEmailFromInput(input);
    const password = this.extractPasswordFromInput(input);
    if (!email) {
      throw new MissingInformationError(
        'Para iniciar sesión en Uber con correo necesito tu dirección de email y opcionalmente tu contraseña.',
        {
          form_key: 'uber.email_login',
          title: 'Iniciar sesión en Uber',
          description: 'Ingresaré tu correo y contraseña en Uber, y después te pediré el código de verificación.',
          fields: [
            { id: 'email', type: 'text', label: 'Correo electrónico', required: true },
            { id: 'password', type: 'text', label: 'Contraseña (opcional)', required: false },
          ],
        },
      );
    }
    await this.log(orgId, taskId, `Uber email login for ${email}`, 'tools');
    const result = await this.uber.startEmailLogin(orgId, email, password ?? undefined, taskId);
    if (result.screenshot) await this.maybePublishBrowserScreenshot(orgId, taskId, result.screenshot, 'Uber Web');
    await this.deliver(orgId, taskId, result.text, 'uber-web', Date.now() - startedAt);
  }

  private async handleRappiEmailLogin(
    orgId: string,
    taskId: string,
    input: string,
    startedAt: number,
  ): Promise<void> {
    const email = this.extractEmailFromInput(input);
    if (!email) {
      throw new MissingInformationError(
        'Para iniciar sesión en Rappi con correo necesito tu dirección de email.',
        {
          form_key: 'rappi.email_login',
          title: 'Iniciar sesión en Rappi',
          description: 'Ingresaré tu correo en Rappi y te pediré el código de verificación.',
          fields: [{ id: 'email', type: 'text', label: 'Correo electrónico', required: true }],
        },
      );
    }
    await this.log(orgId, taskId, `Rappi email login for ${email}`, 'tools');
    const result = await this.rappi.startEmailLogin(orgId, email, taskId);
    if (result.screenshot) await this.maybePublishBrowserScreenshot(orgId, taskId, result.screenshot, 'Rappi');
    await this.deliver(orgId, taskId, result.text, 'rappi-web', Date.now() - startedAt);
  }

  private async handleGoogleManualLogin(
    orgId: string,
    taskId: string,
    startedAt: number,
  ): Promise<void> {
    await this.log(orgId, taskId, 'google blocked — instructing user to import session cookies', 'tools');
    const text = [
      '⚠️ **Google bloqueó el login automático.** En un servidor sin pantalla, no es posible completar el login de Google de forma interactiva.',
      '',
      '**Solución: importa tu sesión de Google en 3 pasos:**',
      '',
      '1. En tu **navegador local** (Chrome/Firefox), instala la extensión **Cookie-Editor**.',
      '2. Ve a `https://accounts.google.com` → abre Cookie-Editor → **Export → Export as JSON**.',
      '3. Llama al endpoint:',
      '   ```',
      '   POST /integrations/google-web/import-session',
      '   { "cookies": <pega el JSON aquí> }',
      '   ```',
      '',
      'Una vez importado, EVA usará esa sesión sin necesidad de login visual. Las cookies quedan encriptadas en tu perfil.',
    ].join('\n');
    await this.deliver(orgId, taskId, text, 'google-web', Date.now() - startedAt);
  }

  private extractEmailFromInput(input: string): string | null {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.email === 'string' && parsed.email) return parsed.email.trim();
        if (typeof parsed.correo === 'string' && parsed.correo) return parsed.correo.trim();
      }
    } catch {
      // Not JSON
    }
    const m = input.match(/\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/i);
    return m ? m[0] : null;
  }

  private extractPasswordFromInput(input: string): string | null {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.password === 'string' && parsed.password) return parsed.password.trim();
        if (typeof parsed.contrasena === 'string' && parsed.contrasena) return parsed.contrasena.trim();
      }
    } catch {
      // Not JSON
    }
    const m = input.match(/\b(?:contrase[ñn]a|password|pass|clave|pw)[:\s]+(".*?"|'.*?'|\S+)/i);
    if (m) {
      return m[1].replace(/^[",']|[",']$/g, '').trim();
    }
    return null;
  }

  private async reverseGeocode(lat: number, lon: number): Promise<string | null> {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=es`, {
        headers: {
          'User-Agent': 'EVA-Agentic-Platform/1.0 (djoker@eva.ai)',
        },
      });
      if (res.ok) {
        const data = await res.json() as { display_name?: string };
        if (data.display_name) {
          return data.display_name;
        }
      }
    } catch (error) {
      this.logger.warn(`Reverse geocoding failed: ${(error as Error).message}`);
    }
    return null;
  }

  private async extractUberRoute(
    input: string,
    orgId: string,
    context: ConversationContextTurn[] = [],
    throwOnError = true,
    taskId?: string,
  ): Promise<{ origin: string; destination: string; url?: string } | null> {
    // 0. Check if input is a JSON form response (submitted from the dashboard form)
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && parsed.form_key === 'uber.estimate_route') {
        const origin = String(parsed.origin ?? '').trim();
        const destination = String(parsed.destination ?? '').trim();
        if (origin && destination) return { origin, destination };
      }
    } catch {
      // Not JSON — proceed to normal parsing
    }

    // 1. Check if input or recent turns contain a direct Uber URL
    const allInputs = [input, ...[...context].reverse().map(t => t.text)];
    for (const text of allInputs) {
      const urlMatch = text.match(/(https?:\/\/[^\s>)"',]+)/i);
      if (urlMatch && urlMatch[0].includes('uber.com')) {
        let url = urlMatch[0].replace(/[.,;:'"*?!)+\]>]+$/, '');
        let origin = '';
        let destination = '';
        try {
          const urlObj = new URL(url);
          const pickupStr = urlObj.searchParams.get('pickup');
          const dropStr = urlObj.searchParams.get('drop[0]') || urlObj.searchParams.get('drop');
          if (pickupStr) {
            const pObj = JSON.parse(pickupStr);
            origin = pObj.addressLine1 || pObj.addressLine2 || 'Ubicación de origen';
          }
          if (dropStr) {
            const dObj = JSON.parse(dropStr);
            destination = dObj.addressLine1 || dObj.addressLine2 || 'Ubicación de destino';
          }
        } catch {
          // ignore
        }
        if (!origin) origin = 'Origen desde URL';
        if (!destination) destination = 'Destino desde URL';
        return { origin, destination, url };
      }
    }

    // 2. Otherwise scan input and context for text patterns
    const patterns = [
      {
        regex: /\b(?:de|desde)\s+(.+?)\s+(?:a|hasta|para|al)\s+(.+?)(?:\?|$|[.,])/i,
        originIdx: 1,
        destIdx: 2,
      },
      {
        regex: /\borigen[:\s]+(.+?)\s+destino[:\s]+(.+?)(?:\?|$|[.,])/i,
        originIdx: 1,
        destIdx: 2,
      },
      {
        regex: /\b(?:a|hasta|para|al)\s+(.+?)\s+(?:desde)\s+(.+?)(?:\?|$|[.,])/i,
        originIdx: 2,
        destIdx: 1,
      },
      {
        regex: /\b(?:a|hasta|para|al)\s+(.+?)\s+(?:de)\s+(.+?)(?:\?|$|[.,])/i,
        originIdx: 2,
        destIdx: 1,
      },
      {
        regex: /\b(?:a|hasta|para|al)\s+(.+?)(?:\?|$|[.,])/i,
        originIdx: null,
        destIdx: 1,
      },
    ];

    for (const text of allInputs) {
      for (const pattern of patterns) {
        const match = text.match(pattern.regex);
        if (!match) continue;

        let rawOrigin = pattern.originIdx !== null ? match[pattern.originIdx] : null;
        let rawDest = match[pattern.destIdx];

        if (rawOrigin) {
          const cleanedOrigin = this.cleanUberPlace(rawOrigin);
          if (cleanedOrigin.toLowerCase() === 'uber' || cleanedOrigin.toLowerCase() === 'taxi' || !cleanedOrigin) {
            // If origin is invalid (e.g. matched "de Uber"), this is a false match.
            // Continue to the next pattern.
            continue;
          }
        }

        let origin: string;
        try {
          origin = rawOrigin ? await this.normalizeUberPlace(rawOrigin, orgId, taskId) : await this.defaultUberOrigin(orgId, taskId);
        } catch {
          // defaultUberOrigin throws MissingInformationError when no profile address is set
          // Let the outer logic decide if we should propagate or return null
          origin = '';
        }
        const destination = this.cleanUberPlace(rawDest);
        if (origin && destination) return { origin, destination };
        // Have destination but no origin from profile → ask form only for origin
        if (destination && !origin) {
          if (throwOnError) {
            throw new MissingInformationError(
              'Para cotizar Uber necesito saber desde dónde sales.',
              {
                form_key: 'uber.estimate_route',
                title: 'Ruta para cotizar Uber',
                description: `Tengo el destino: **${destination}**. ¿Desde dónde sales?`,
                fields: [
                  {
                    id: 'origin',
                    type: 'text',
                    label: 'Origen',
                    placeholder: 'Ej. Roma Norte, Ciudad de Mexico',
                    required: true,
                  },
                  {
                    id: 'destination',
                    type: 'text',
                    label: 'Destino',
                    placeholder: destination,
                    required: true,
                  },
                ],
              },
            );
          }
          return null;
        }
      }
    }

    if (throwOnError) {
      throw new MissingInformationError(
        'Para cotizar Uber necesito origen y destino.',
        {
          form_key: 'uber.estimate_route',
          title: 'Ruta para cotizar Uber',
          description: 'Solo consultaré tarifas visibles y mandaré screenshot; no pediré ni confirmaré el viaje.',
          fields: [
            {
              id: 'origin',
              type: 'text',
              label: 'Origen',
              placeholder: 'Ej. Roma Norte, Ciudad de Mexico',
              required: true,
            },
            {
              id: 'destination',
              type: 'text',
              label: 'Destino',
              placeholder: 'Ej. Aeropuerto Internacional de la Ciudad de Mexico',
              required: true,
            },
          ],
        },
      );
    }
    return null;
  }

  private async normalizeUberPlace(value: string, orgId: string, taskId?: string): Promise<string> {
    const cleaned = this.cleanUberPlace(value);
    if (!/\b(mi ubicaci[oó]n|ubicaci[oó]n actual|aqu[ií]|aqui|donde estoy|mi casa|casa|depa|departamento|mi depa|mi departamento)\b/i.test(cleaned)) return cleaned;
    
    if (taskId) {
      try {
        const task = await this.tasks.getTask(taskId, orgId);
        const deviceLocation = task.metadata?.device_location as { latitude: number; longitude: number } | null;
        if (deviceLocation && typeof deviceLocation.latitude === 'number' && typeof deviceLocation.longitude === 'number') {
          const address = await this.reverseGeocode(deviceLocation.latitude, deviceLocation.longitude);
          if (address) {
            return address;
          }
        }
      } catch (e) {
        this.logger.warn(`Could not resolve device location for normalizeUberPlace in task ${taskId}: ${(e as Error).message}`);
      }
    }

    const profile = await this.soul.getPersonalProfile(orgId).catch(() => ({} as PersonalProfile));
    const fallback = String(profile.current_location ?? profile.address ?? '').trim();
    if (fallback) return fallback;
    return cleaned;
  }

  private async defaultUberOrigin(orgId: string, taskId?: string): Promise<string> {
    if (taskId) {
      try {
        const task = await this.tasks.getTask(taskId, orgId);
        const deviceLocation = task.metadata?.device_location as { latitude: number; longitude: number } | null;
        if (deviceLocation && typeof deviceLocation.latitude === 'number' && typeof deviceLocation.longitude === 'number') {
          const address = await this.reverseGeocode(deviceLocation.latitude, deviceLocation.longitude);
          if (address) {
            this.logger.log(`Resolved Uber origin from device location coordinates in task ${taskId}: ${address}`);
            return address;
          }
        }
      } catch (e) {
        this.logger.warn(`Could not resolve device location for defaultUberOrigin in task ${taskId}: ${(e as Error).message}`);
      }
    }

    const profile = await this.soul.getPersonalProfile(orgId).catch(() => ({} as PersonalProfile));
    const origin = String(profile.current_location ?? profile.address ?? '').trim();
    if (origin) return origin;
    throw new MissingInformationError(
      'Para cotizar Uber necesito tu origen.',
      {
        form_key: 'uber.estimate_origin',
        title: 'Origen para cotizar Uber',
        description: 'Guarda o escribe el origen para consultar tarifa visible.',
        fields: [
          {
            id: 'origin',
            type: 'text',
            label: 'Origen',
            placeholder: 'Ej. mi ubicacion actual o una direccion',
            required: true,
            profile_path: 'personal_profile.current_location',
          },
        ],
      },
    );
  }

  private cleanUberPlace(value: string): string {
    let cleaned = value
      .replace(/\b(en|por)\s+uber\b/ig, '')
      .replace(/\b(cu[aá]nto|cuanto|costo|costar|cuesta|sale|precio|tarifa|cotiza|cotizar|estimaci[oó]n|uber|taxi|viajes?|vieajes?|traslados?|transportes?)\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Repeatedly strip leading Spanish prepositions/articles
    while (true) {
      const next = cleaned.replace(/^(?:el|la|los|las|un|una|unos|unas|de|del|al|a|para|este|ese|mi|tu|su)\b\s*/ig, '');
      if (next === cleaned) break;
      cleaned = next;
    }
    return cleaned;
  }

  private async maybePublishWhatsAppQr(orgId: string, taskId: string, screenshot?: { image_base64: string; mime_type: string }) {
    await this.maybePublishBrowserScreenshot(orgId, taskId, screenshot, 'WhatsApp Web QR');
  }

  private async maybePublishBrowserScreenshot(orgId: string, taskId: string, screenshot: { image_base64: string; mime_type: string } | undefined, label: string) {
    if (!screenshot?.image_base64) return;
    const contentType = screenshot.mime_type || 'image/png';
    const url = await this.media.upload(
      orgId,
      taskId,
      `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'browser'}-screenshot.png`,
      Buffer.from(screenshot.image_base64, 'base64'),
      contentType,
    );
    if (!url) {
      await this.log(orgId, taskId, `${label} screenshot upload failed`, 'tools');
      return;
    }
    await this.events.publish({
      type: 'task.media',
      orgId,
      taskId,
      payload: {
        kind: 'image',
        url,
        label,
        content_type: contentType,
      },
    });
    await this.log(orgId, taskId, `${label} screenshot uploaded and sent to the conversation`, 'tools');
  }

  private cleanWhatsAppContactName(contact: string): string {
    if (!contact) return '';
    // 1. Remove trailing instruction/action clauses starting with "y" followed by a verb (dime, dile, lee, etc.)
    let cleaned = contact.replace(/\s+y\s+(?:dime|dile|lee|revisa|escribe|manda|envia|preguntale|ver|buscar|mostrar|enviar|mandar|escribir|contestar|responder|verificar|captura|haz|hacer|toma|tomar|tomarle|hacerle|mandarle|enviarle|decirle|leerle|preguntarle|deci|decir)\b.*/gi, '');
    
    // 2. Remove common WhatsApp platform words and any preceding prepositions (en, de, por, a)
    cleaned = cleaned.replace(/\b(?:en|de|por|a)?\s*(?:whatsapp|whatsap|watsapp|watsap|guasap|guasapp|wa)\b/gi, '');
    
    // 3. Trim extra whitespace
    cleaned = cleaned.trim();
    
    // 4. Remove trailing prepositions/conjunctions that might be left over (de, con, en, para, a, y)
    cleaned = cleaned.replace(/\s+(?:de|con|en|para|a|y)$/i, '');
    
    return cleaned.trim();
  }

  private extractWhatsAppDraft(input: string): { contact: string | null; text: string } | null {
    // 1. Explicit contact + text patterns
    const explicitPatterns = [
      /\b(?:responde|responder|contesta|contestar|dile|decirle)\s+(?:por\s+)?(?:whatsapp|whatsap|watsapp|watsap|guasap|wa)?\s*(?:a\s+)?(.+?)\s+(?:que|diciendo|:)\s+(.+)$/i,
      /\b(?:env[ií]a|enviar|manda|mandar|escribe|escribir|env[ií]ale|m[aá]ndale|escr[ií]bele)\s+(?:un\s+)?(?:mensaje\s+(?:por\s+)?(?:whatsapp|whatsap|watsapp|watsap|guasap|wa)?\s*)?(?:a\s+)?(.+?)\s+(?:que|diciendo|:)\s+(.+)$/i,
    ];
    for (const pattern of explicitPatterns) {
      const match = input.match(pattern);
      if (match) {
        const contact = this.cleanWhatsAppContactName(match[1]);
        const text = match[2].trim();
        if (contact && text) return { contact, text };
      }
    }

    // 2. Implicit contact patterns (just dile / enviale / mandale + text)
    const implicitPatterns = [
      /\b(?:dile|decirle|env[ií]ale|m[aá]ndale|escr[ií]bele)\s+(?:por\s+)?(?:whatsapp|whatsap|watsapp|watsap|guasap|wa)?\s*(?:que|diciendo|:)?\s*(.+)$/i,
    ];
    for (const pattern of implicitPatterns) {
      const match = input.match(pattern);
      if (match) {
        let text = match[1].trim();
        // Clean up leading "un " or "mensaje diciendo "
        text = text.replace(/^(?:un\s+mensaje|un\s+whatsapp|un\s+wa|un|una)\s+/i, '');
        text = text.replace(/^(?:diciendo|que)\s+/i, '');
        if (text) return { contact: null, text: text.trim() };
      }
    }

    return null;
  }

  private extractWhatsAppContactToRead(input: string): string | null {
    const patterns = [
      /\b(?:mensajes?|chats?|conversaci[oó]n|conversaciones?)\s+(?:de|con|para)\s+([^#\n\.\?,]+)/i,
      /\b(?:abre|ver|busca|buscar|mostrar|muestra|m[uú]estrame)\s+(?:el\s+chat\s+(?:de|con)|los\s+mensajes\s+(?:de|con))\s+([^#\n\.\?,]+)/i,
      /\b(?:abre|ver|busca|buscar|mostrar|muestra|m[uú]estrame)\s+(?:a\s+)?([^#\n\.\?,]+?)\s+(?:en\s+whatsapp|de\s+whatsapp|en\s+wa|de\s+wa)\b/i,
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (match) {
        const contact = this.cleanWhatsAppContactName(match[1]);
        const genericPhrases = /^(mis?|el|los|un|una|la|ultimo\s+chat|el\s+ultimo\s+chat|los\s+ultimo\s+chats|mensajes?|chats?|conversaci[oó]n|conversaciones?|mensajes?\s+sin\s+(?:leer|responder|contestar))$/i;
        if (contact && contact.length > 1 && !genericPhrases.test(contact)) {
          return contact;
        }
      }
    }
    return null;
  }

  private checkActiveToolContext(orgId: string, userId: string, toolName: string): boolean {
    const session = this.activeToolSessions.get(`${orgId}:${userId}`);
    if (!session) return false;
    const isExpired = Date.now() - session.updatedAt > this.TOOL_SESSION_TTL_MS;
    if (isExpired) {
      this.activeToolSessions.delete(`${orgId}:${userId}`);
      return false;
    }
    return session.tool === toolName;
  }

  private updateActiveToolSession(orgId: string, userId: string, toolName: string, details?: any): void {
    this.activeToolSessions.set(`${orgId}:${userId}`, {
      tool: toolName,
      details,
      updatedAt: Date.now(),
    });
    this.logger.log(`Active tool session updated for user ${userId} in org ${orgId}: ${toolName}`);
  }

  private isWhatsAppFollowUp(input: string, conversationContext: ConversationContextTurn[]): boolean {
    const normalized = input.toLowerCase().trim();

    // 1. Explicit read or send or status signals
    if (
      WHATSAPP_READ_SIGNALS.test(input) ||
      WHATSAPP_SEND_SIGNALS.test(input) ||
      WHATSAPP_UNREAD_SIGNALS.test(input) ||
      WHATSAPP_UNANSWERED_SIGNALS.test(input) ||
      WHATSAPP_SCREENSHOT_SIGNALS.test(input)
    ) {
      return true;
    }

    // 2. Pronouns or phrases referring to a chat/message/screenshot/contact
    const confirmationPatterns = [
      /\b(abre\s+ese|entra\s+(?:a\s+)?ese|si\s+abre\s+ese|si\s+ese|ese\s+mismo|ver\s+ese|lee\s+ese|entra|abrir|dale|abre|abrirlo|abrir\s+el\s+chat|ver\s+el\s+chat)\b/i,
      /\b(mandame|m[aá]ndame|dame|lee|revisa|escribe|escr[ií]bele|dile|preg[uú]ntale|enviarle|enviar|contestar|responder|mostrar|muestra|ver)\b/i,
    ];
    if (confirmationPatterns.some(pat => pat.test(normalized))) {
      return true;
    }

    // 3. Conversation context has WhatsApp mentions in recent turns
    const lastTurns = conversationContext.slice(-3);
    if (lastTurns.some(turn => WHATSAPP_SIGNALS.test(turn.text))) {
      return true;
    }

    return false;
  }

  private wantsWhatsAppScreenshot(input: string, conversationContext: ConversationContextTurn[]): boolean {
    if (WHATSAPP_SCREENSHOT_SIGNALS.test(input)) return true;
    if (!WHATSAPP_SIGNALS.test(input)) return false;
    const previousUserText = [...conversationContext].reverse().find((turn) => turn.role === 'user')?.text ?? '';
    return WHATSAPP_SCREENSHOT_SIGNALS.test(previousUserText) && CHAT_CONTEXT_SIGNALS.test(previousUserText);
  }

  private isImplicitWhatsAppScreenshotRequest(input: string, conversationContext: ConversationContextTurn[]): boolean {
    if (WHATSAPP_SCREENSHOT_SIGNALS.test(input) && CHAT_CONTEXT_SIGNALS.test(input)) return true;
    if (!WHATSAPP_SCREENSHOT_SIGNALS.test(input)) return false;
    return conversationContext.some((turn) => WHATSAPP_SIGNALS.test(turn.text));
  }

  private isPureImageRequest(input: string): boolean {
    return /\b(crea|crear|genera|generar|haz|hacer|dame|muestra|mu[eé]strame|dibuja|dibujar|ilustra|ilustrar)\b/i.test(input)
      && /\b(imagen|im[aá]genes|foto|dibujo|ilustraci[oó]n|logo)\b/i.test(input);
  }

  private isUselessAnswer(text: string): boolean {
    return USELESS_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
  }

  private async getConversationContextFromDb(orgId: string, userId: string, currentTaskId: string): Promise<ConversationContextTurn[]> {
    try {
      const { data, error } = await this.db.admin
        .from('tasks')
        .select('id, title, description, result')
        .eq('org_id', orgId)
        .eq('created_by', userId)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error || !data) {
        this.logger.warn(`Failed to fetch task history for context: ${error?.message || 'no data'}`);
        return [];
      }

      const turns: ConversationContextTurn[] = [];
      const pastTasks = data
        .filter((t) => t.id !== currentTaskId)
        .reverse();

      for (const t of pastTasks) {
        const userText = t.description || t.title || '';
        const assistantText = (t.result as Record<string, unknown> | null)?.['text'] as string | null;
        if (userText.trim()) {
          turns.push({ role: 'user', text: userText.trim() });
        }
        if (assistantText && assistantText.trim()) {
          turns.push({ role: 'assistant', text: assistantText.trim() });
        }
      }

      return turns;
    } catch (err) {
      this.logger.warn(`Error in getConversationContextFromDb: ${(err as Error).message}`);
      return [];
    }
  }

  private compressConversationContext(turns: ConversationContextTurn[]): ConversationContextTurn[] {
    const N = turns.length;
    return turns
      .map((turn, index) => {
        const distance = N - 1 - index; // distance from newest (0 is newest)
        if (distance < 6) {
          return { role: turn.role, text: turn.text.slice(0, 1200) };
        } else if (distance < 16) {
          const truncated = turn.text.slice(0, 250);
          const suffix = turn.text.length > 250 ? '... [resumido]' : '';
          return { role: turn.role, text: `${truncated}${suffix}` };
        } else if (distance < 30) {
          const truncated = turn.text.slice(0, 80);
          const suffix = turn.text.length > 80 ? '... [comprimido]' : '';
          return { role: turn.role, text: `${truncated}${suffix}` };
        } else {
          return null;
        }
      })
      .filter((t): t is ConversationContextTurn => t !== null);
  }

  private async getConversationContext(task: Task): Promise<ConversationContextTurn[]> {
    let turns = await this.getConversationContextFromDb(task.org_id, task.created_by, task.id);

    if (turns.length === 0) {
      const raw = task.metadata?.conversation_context;
      if (Array.isArray(raw)) {
        turns = raw
          .map((item): ConversationContextTurn | null => {
            if (!item || typeof item !== 'object') return null;
            const record = item as Record<string, unknown>;
            const role = record.role === 'user' || record.role === 'assistant' ? record.role : null;
            const text = typeof record.text === 'string' ? record.text.trim() : '';
            if (!role || !text) return null;
            return { role, text };
          })
          .filter((item): item is ConversationContextTurn => Boolean(item));
      }
    }

    return this.compressConversationContext(turns);
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
   * Contexto compacto para tier chat (la ruta de mayor volumen): identidad
   * esencial + estilo + memorias recordadas + sugerencias proactivas + últimos
   * 4 turnos. Sin agenda, patrones, metas ni proyectos.
   */
  private buildChatContextualInput(
    input: string,
    conversationContext: ConversationContextTurn[],
    soulContext: AgentSoulContext,
    proactiveTriggerMessages: string[],
    memoryRecallContext: string | null,
  ): string {
    const blocks: string[] = [input];

    const identity = this.slimIdentityLine(soulContext);
    if (identity) blocks.push('', `(Contexto: ${identity})`);

    if (proactiveTriggerMessages.length > 0) {
      blocks.push('', 'Sugerencias proactivas (menciónalas solo si fluye):', ...proactiveTriggerMessages.map(m => `- ${m}`));
    }

    if (memoryRecallContext) blocks.push('', memoryRecallContext);

    if (conversationContext.length > 0) {
      blocks.push(
        '',
        'Conversación reciente:',
        ...conversationContext.slice(-4).map(t => `${t.role === 'user' ? 'Usuario' : 'EVA'}: ${t.text.slice(0, 400)}`),
      );
    }

    return blocks.length === 1 ? input : blocks.join('\n');
  }

  /**
   * Identidad esencial en una línea (~30 tokens): lo mínimo para que un agente
   * actúe sin tener que gastar un memory_recall solo para saber quién es el
   * usuario. Usado por el tier chat y por el bucle agéntico.
   */
  private slimIdentityLine(soulContext: AgentSoulContext): string | null {
    const p = soulContext.personal_profile;
    const persona = soulContext.persona_context;
    const bits = [
      p.full_name ? `usuario: ${p.full_name}` : null,
      p.preferred_address ? `llámale ${p.preferred_address}` : null,
      (p.occupation ?? persona.occupation) ? `se dedica a ${p.occupation ?? persona.occupation}` : null,
      p.current_location ? `está en ${p.current_location}` : null,
      persona.communication_preferences ? `estilo preferido: ${persona.communication_preferences}` : null,
      persona.relationship_map?.length ? `relaciones mapeadas: ${persona.relationship_map.map(r => `${r.relation}=${r.display_name}`).slice(0, 4).join(', ')}` : null,
    ].filter(Boolean);
    return bits.length > 0 ? bits.join(' · ') : null;
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

    if (persona.relationship_map?.length) {
      sections.push(
        '\n### Mapa de relaciones y contactos',
        'Usa este mapa para resolver referencias como "mi mamá", "mamá", "madre", "mi jefe" o aliases repetidos antes de buscar contactos externos.',
        ...persona.relationship_map
          .slice()
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          .map((entry) => {
            const aliases = entry.aliases?.length ? ` aliases: ${entry.aliases.join(', ')}` : '';
            const contact = entry.contact_hint ? ` contacto: ${entry.contact_hint}` : '';
            const notes = entry.notes ? ` notas: ${entry.notes}` : '';
            return `- ${entry.relation}: ${entry.display_name}.${aliases}${contact}${notes}`;
          }),
      );
      hasContent = true;
    }

    if (context.private_context?.text) {
      sections.push(
        '\n### Contexto privado cifrado',
        'Este bloque fue descifrado server-side para uso interno del modelo. No lo reveles ni lo repitas salvo que el usuario lo pida explícitamente.',
        context.private_context.text,
      );
      hasContent = true;
    }

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
    return freshnessRequired || ackHint === 'search' || ackHint === 'public_api' || RESEARCH_REQUIRED_SIGNALS.test(routingInput);
  }

  private shouldUsePublicApiDirect(rawInput: string, ackHint: string): boolean {
    return ackHint === 'public_api' || PUBLIC_API_DIRECT_SIGNALS.test(rawInput);
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

  /**
   * Ejecuta el bucle agéntico genérico y entrega el resultado si resolvió.
   * Devuelve false (sin efectos) cuando el loop no pudo, para que el caller
   * caiga al pipeline clásico. MissingInformationError sube como formulario.
   */
  private async runAgentLoop(
    orgId: string,
    taskId: string,
    input: string,
    conversationContext: ConversationContextTurn[],
    startedAt: number,
    userId?: string,
    soulContext?: AgentSoulContext,
    maxSteps?: number,
  ): Promise<boolean> {
    try {
      // Contexto mínimo necesario: identidad del usuario en una línea + últimos
      // 4 turnos. Nada de agenda/metas/patrones (el agente los pide con sus
      // herramientas si los necesita) → contexto suficiente sin inflar tokens.
      const contextParts: string[] = [];
      const identity = soulContext ? this.slimIdentityLine(soulContext) : null;
      if (identity) contextParts.push(`Usuario: ${identity}`);
      if (conversationContext.length > 0) {
        contextParts.push(
          conversationContext
            .slice(-4)
            .map((turn) => `${turn.role === 'user' ? 'Usuario' : 'EVA'}: ${turn.text.slice(0, 300)}`)
            .join('\n'),
        );
      }
      const context = contextParts.length > 0 ? contextParts.join('\n') : undefined;
      // R2.1: build capability self-model once per run so the agent knows what's available BEFORE failing
      const capabilityModel = await this.buildCapabilityModel(orgId).catch(() => undefined);
      const outcome = await this.agentLoop.run(orgId, taskId, input, {
        context,
        userId,
        maxSteps,
        capabilityModel,
        log: (message, scope) => this.log(orgId, taskId, message, scope),
      });
      if (!outcome.ok || !outcome.text) return false;
      await this.log(
        orgId, taskId,
        `agent-loop resolvió en ${outcome.steps.length} pasos${outcome.degraded ? ' (recuperación: respuesta con opciones)' : ''} — herramientas [${outcome.toolsUsed.join(', ') || 'ninguna'}], ${outcome.tokensUsed} tokens de razonamiento`,
        'loop',
      );
      await this.deliver(orgId, taskId, outcome.text, 'agent-loop', Date.now() - startedAt);
      await this.maybeAttachMedia(orgId, taskId, input, outcome.text);
      await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
      this.digester.digestAsync({ orgId, taskId, userInput: input, evaReply: outcome.text, conversationContext });
      return true;
    } catch (error) {
      if (error instanceof MissingInformationError) {
        await this.requestMissingInformation(orgId, taskId, error);
        return true;
      }
      await this.log(orgId, taskId, `agent-loop falló: ${(error as Error).message}`, 'loop');
      return false;
    } finally {
      // El workspace de la tarea muere con el loop; el sandbox es por-tarea.
      void this.sandbox.release(taskId).catch(() => undefined);
    }
  }

  private async maxStepsForTier(orgId: string, tier: 'chat' | 'quick' | 'medium' | 'long'): Promise<number> {
    return this.intelligence.maxStepsForTier(orgId, tier).catch(() => (
      tier === 'long' ? 8 : tier === 'medium' ? 4 : tier === 'quick' ? 4 : 2
    ));
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
        const researchInput = await this.planResearchInput(orgId, taskId, input, rawInput);
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
      errors.length > 0 ? `Lo que intenté y su detalle: ${errors.join(' | ')}` : 'Ninguna de mis herramientas actuales aplica directo a esto.',
      '',
      'Opciones para sacarlo adelante:',
      '1. Dime "reintenta" y lo vuelvo a intentar por otra ruta (otra herramienta o búsqueda distinta).',
      '2. Si falta una integración/API, conéctala en Credentials y lo reintento al instante.',
      '3. Puedo dividirlo en pasos pequeños y avanzar ya con la parte que sí está a mi alcance — solo dime.',
    ].join('\n');
    await this.deliver(orgId, taskId, text, 'tool-recovery', Date.now() - startedAt);
    return true;
  }

  private async planResearchInput(orgId: string, taskId: string, input: string, rawInput?: string): Promise<string> {
    try {
      const plannerDate = this.currentPlannerDate();
      const result = await this.modelRouter.generate(input, {
        orgId,
        taskId,
        requestType: 'tools',
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
        : (rawInput ?? input);
      const query = this.normalizeResearchQuery(rawInput ?? input, rawQuery);
      await this.log(
        orgId,
        taskId,
        `research-plan: query="${query}" intent=${String(parsed.intent ?? 'unknown')} source=${String(parsed.source_hint ?? 'unknown')} — ${String(parsed.reason ?? 'no reason')}`,
        'tools',
      );
      return query;
    } catch (error) {
      await this.log(orgId, taskId, `research-plan failed; using original input — ${(error as Error).message}`, 'tools');
      return this.normalizeResearchQuery(rawInput ?? input, rawInput ?? input);
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
    return this.events.publish({
      type: 'task.log',
      orgId,
      taskId,
      payload: {
        message,
        scope,
        agent: scope,
        module: 'AgentRunnerService',
        action: `agent.${scope}`,
        level: message.startsWith('ERROR:') ? 'error' : 'debug',
      },
    });
  }

  private async failSafely(orgId: string, taskId: string, message: string) {
    this.crossChannelCtx.delete(taskId); // prevent Map leaks on failure
    try {
      const current = await this.tasks.getTask(taskId, orgId);
      if (current.status === 'pending') await this.tasks.transition(taskId, orgId, 'planning');
      const refreshed = await this.tasks.getTask(taskId, orgId);
      // planning, running and waiting_for_approval can all fail directly
      if (!['completed', 'failed', 'cancelled'].includes(refreshed.status)) {
        // The user must never get dead silence (or a bare "no se pudo"):
        // persist result to the task row AND publish a task.result event so
        // every channel (dashboard, Telegram, wearOS) receives what happened
        // plus concrete next moves EVA can take.  Storing in result means the
        // text survives even if the WebSocket was closed at delivery time.
        const failureText = this.composeFailureOptions(message);
        await this.events.publish({
          type: 'task.result',
          orgId,
          taskId,
          payload: { text: failureText, model: 'failure-options', latency_ms: 0 },
        }).catch(() => undefined);
        await this.tasks.transition(taskId, orgId, 'failed', {
          error: message,
          result: { text: failureText, model: 'failure-options', latency_ms: 0 },
        });

        // R1.4: persist retry context so "reintenta" next time starts with full context
        const optionLines = failureText.split('\n').filter((l) => /^\d+\./.test(l.trim()));
        const goal = refreshed.description ?? refreshed.title ?? message.slice(0, 200);
        const retryCtx = await this.intelligence.buildRetryContext(orgId, taskId, goal, [], message, optionLines, 0).catch(() => null);
        if (retryCtx) {
          await this.intelligence.persistRetryContext(orgId, taskId, retryCtx).catch(() => undefined);
        }
        // R4.2: register capability gap at L3 level
        await this.intelligence.registerCapabilityGap(orgId, taskId, 'hard_failure', goal, 3, { error: message.slice(0, 200) }).catch(() => undefined);
      }
    } catch (transitionError) {
      this.logger.error(`Could not mark task ${taskId} as failed`, transitionError as Error);
    }
  }

  /**
   * Turns a raw failure into a natural reply with autonomous solution options.
   * Heuristics keyed on the error text — no model call here, because the model
   * itself may be what just failed.
   */
  private composeFailureOptions(message: string): string {
    const m = message.toLowerCase();
    const options: string[] = [];
    if (/docker|sandbox|contenedor/.test(m)) {
      options.push('Reintentar la ejecución en cuanto el sandbox Docker esté disponible — dime "reintenta" y lo vuelvo a correr.');
      options.push('Resolverlo sin código: puedo buscar el dato o hacerlo paso a paso con mis otras herramientas.');
    } else if (/key|credencial|credential|token|api|unauthorized|401|403/.test(m)) {
      options.push('Conectar la credencial que falta en Credentials/Integraciones y me dices "reintenta".');
      options.push('Intentarlo por otra vía que no requiera esa credencial (web pública o sandbox).');
    } else if (/timeout|tiempo|timed out|etimedout/.test(m)) {
      options.push('Reintentarlo ahora mismo dividiéndolo en pasos más pequeños — dime "reintenta".');
      options.push('Dejarlo programado para que lo intente en unos minutos y te avise con el resultado.');
    } else if (/login|sesi[oó]n|qr|cookie|navegador|browser|chromium/.test(m)) {
      options.push('Renovar la sesión del navegador (QR o cookies) y vuelvo a intentarlo de inmediato.');
      options.push('Conseguir la información por otra ruta (API o búsqueda) mientras tanto.');
    } else {
      options.push('Reintentarlo con otro enfoque — dime "reintenta" y pruebo una ruta distinta (otra herramienta u otro proveedor).');
      options.push('Dividir la tarea en pasos pequeños y avanzar lo que sí se puede ahora.');
    }
    return [
      'Me topé con un obstáculo y no quiero darte una respuesta a medias.',
      `Detalle técnico: ${message.slice(0, 220)}`,
      '',
      'Esto es lo que puedo hacer ahora mismo:',
      ...options.map((o, i) => `${i + 1}. ${o}`),
      '',
      'Dime cuál prefieres (o solo di "reintenta") y sigo yo.',
    ].join('\n');
  }

  /**
   * Resolves how many emails to fetch based on the user's phrasing.
   * "el último correo" → 1, "los últimos N" → N (max 10), default → 3.
   */
  private emailRequestedLimit(input: string): number {
    if (/\b(el\s+)?[uú]ltimo\s+(correo|email|mail|mensaje)\b/i.test(input)) return 1;
    const m = input.match(/[uú]ltimos\s+(\d+)\s+(correos?|emails?|mails?)/i);
    if (m) return Math.min(parseInt(m[1], 10), 10);
    return 3;
  }

  // ── Gmail / Calendar write-intent detection ───────────────────────────────

  private isGmailWriteIntent(input: string): boolean {
    return (
      GMAIL_SEND_SIGNALS.test(input)
      || GMAIL_REPLY_SIGNALS.test(input)
      || GMAIL_TRASH_SIGNALS.test(input)
      || GMAIL_ARCHIVE_SIGNALS.test(input)
      || GMAIL_MARK_READ_SIGNALS.test(input)
      || GMAIL_MARK_UNREAD_SIGNALS.test(input)
    );
  }

  private isCalendarWriteIntent(input: string): boolean {
    return (
      CALENDAR_CREATE_SIGNALS.test(input)
      || CALENDAR_DELETE_SIGNALS.test(input)
      || CALENDAR_UPDATE_SIGNALS.test(input)
    );
  }

  // ── Cross-channel routing ─────────────────────────────────────────────────

  private extractCrossChannelTarget(input: string): CommunicationChannel | null {
    if (!CROSS_CHANNEL_SIGNALS.test(input)) return null;
    if (/\btelegram\b/i.test(input)) return 'telegram';
    return null;
  }

  /**
   * Removes the cross-channel routing clause from the input so the model
   * sees only the actual request ("dame el clima" not "dame el clima y mándamelo por telegram").
   */
  private stripCrossChannelClause(input: string): string {
    return input
      .replace(/[,;]?\s*\b(y\s+)?(mánda(me|lo|la|sela|selo)?|envía(me|lo|la)?|pása(me|lo|la)?|comparte(lo|la)?|por|v[ií]a|usando|a\s+trav[eé]s\s+de)\b.{0,30}\b(telegram)\b[^\n]*/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      || input; // fallback: keep original if strip wiped everything
  }

  // ── Scheduled job intent detection ───────────────────────────────────────

  private isScheduleIntent(input: string): boolean {
    return (
      MANERO_SIGNALS.test(input)
      || SCHEDULE_LIST_SIGNALS.test(input)
      || SCHEDULE_PAUSE_SIGNALS.test(input)
      || SCHEDULE_CREATE_SIGNALS.test(input)
    );
  }

  private async handleScheduleIntent(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    // Activate / reconfigure the mañanero
    if (MANERO_SIGNALS.test(input)) {
      const hourMatch = input.match(/\ba\s+las?\s+(\d{1,2})\b|\b(\d{1,2})[:\s]*(am|pm)?\b/i);
      let hour: number | undefined;
      if (hourMatch) {
        const raw = parseInt(hourMatch[1] ?? hourMatch[2], 10);
        const period = (hourMatch[3] ?? '').toLowerCase();
        if (!Number.isNaN(raw)) {
          hour = period === 'pm' && raw < 12 ? raw + 12 : raw;
        }
      }
      const job = await this.scheduledJobs.activateManero(orgId, task.created_by, hour);
      const summary = this.scheduledJobs.describeSchedule(job);
      await this.deliver(orgId, taskId,
        `✅ Mañanero activado. ${summary}\n\nCada mañana te daré: clima del día, correos importantes y tu agenda.`,
        'jobs', Date.now() - startedAt);
      return;
    }

    // List scheduled jobs
    if (SCHEDULE_LIST_SIGNALS.test(input)) {
      const jobs = await this.scheduledJobs.list(orgId);
      if (jobs.length === 0) {
        await this.deliver(orgId, taskId,
          '📋 No tienes tareas programadas aún. Puedes activar el **mañanero** diciendo "activa el mañanero" o pedirme que programe algo.',
          'jobs', Date.now() - startedAt);
        return;
      }
      const lines = jobs.map(j => {
        const status = j.status === 'active' ? '🟢' : j.status === 'paused' ? '⏸️' : '✅';
        const schedule = this.scheduledJobs.describeSchedule(j);
        return `${status} **${j.name}** — ${schedule}`;
      });
      await this.deliver(orgId, taskId,
        `📋 Tus tareas programadas (${jobs.length}):\n\n${lines.join('\n')}`,
        'jobs', Date.now() - startedAt);
      return;
    }

    // Pause a job
    if (SCHEDULE_PAUSE_SIGNALS.test(input)) {
      const jobs = await this.scheduledJobs.list(orgId);
      const activeJobs = jobs.filter(j => j.status === 'active');
      if (activeJobs.length === 0) {
        await this.deliver(orgId, taskId, '⏸️ No tienes tareas activas para pausar.', 'jobs', Date.now() - startedAt);
        return;
      }
      // If only one active job, pause it directly
      if (activeJobs.length === 1) {
        await this.scheduledJobs.pause(activeJobs[0].id, orgId);
        await this.deliver(orgId, taskId,
          `⏸️ Tarea **"${activeJobs[0].name}"** pausada. Di "reactiva mis jobs" para reanudarla.`,
          'jobs', Date.now() - startedAt);
        return;
      }
      // Multiple jobs — pause mañanero/briefing first, otherwise ask
      const briefing = activeJobs.find(j => j.job_type === 'briefing');
      if (briefing) {
        await this.scheduledJobs.pause(briefing.id, orgId);
        await this.deliver(orgId, taskId,
          `⏸️ Tarea **"${briefing.name}"** pausada. Tienes ${activeJobs.length - 1} tarea(s) activa(s) más.`,
          'jobs', Date.now() - startedAt);
        return;
      }
      const list = activeJobs.map((j, i) => `${i + 1}. **${j.name}**`).join('\n');
      await this.deliver(orgId, taskId,
        `⏸️ ¿Cuál tarea quieres pausar?\n\n${list}\n\nDime el nombre o número.`,
        'jobs', Date.now() - startedAt);
      return;
    }

    // Generic schedule creation
    if (SCHEDULE_CREATE_SIGNALS.test(input)) {
      const { job, summary } = await this.scheduledJobs.createFromNl(input, orgId, task.created_by);
      await this.deliver(orgId, taskId,
        `✅ Tarea programada creada. ${summary}\n\n_ID: \`${job.id.slice(0, 8)}…\`_`,
        'jobs', Date.now() - startedAt);
      return;
    }

    // Fallback — should not reach here
    await this.deliver(orgId, taskId, 'No entendí qué quieres programar. ¿Puedes darme más detalles?', 'jobs', Date.now() - startedAt);
  }

  // ── Gmail write handlers ──────────────────────────────────────────────────

  private async handleGmailWriteIntent(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    if (GMAIL_TRASH_SIGNALS.test(input)) {
      await this.handleGmailSingleMessageOp(orgId, taskId, task, input, startedAt, 'gmail.trash', '🗑️ Listo para mover a la papelera');
    } else if (GMAIL_ARCHIVE_SIGNALS.test(input)) {
      await this.handleGmailSingleMessageOp(orgId, taskId, task, input, startedAt, 'gmail.archive', '📦 Listo para archivar');
    } else if (GMAIL_REPLY_SIGNALS.test(input)) {
      await this.handleGmailReplyRequest(orgId, taskId, task, input, startedAt);
    } else if (GMAIL_MARK_READ_SIGNALS.test(input)) {
      await this.handleGmailSingleMessageOp(orgId, taskId, task, input, startedAt, 'gmail.mark_read', '✅ Listo para marcar como leído');
    } else if (GMAIL_MARK_UNREAD_SIGNALS.test(input)) {
      await this.handleGmailSingleMessageOp(orgId, taskId, task, input, startedAt, 'gmail.mark_unread', '✅ Listo para marcar como no leído');
    } else {
      await this.handleGmailSendRequest(orgId, taskId, task, input, startedAt);
    }
  }

  private async handleGmailSendRequest(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    const params = this.extractEmailSendParams(input);
    if (!params.to || !params.body) {
      throw new MissingInformationError(
        'Para enviar el correo necesito el destinatario y el mensaje.',
        {
          form_key: 'gmail.send',
          title: 'Enviar correo',
          description: 'Revisa los datos antes de que te pida confirmación.',
          fields: [
            ...(!params.to ? [{ id: 'to', type: 'text' as const, label: 'Destinatario (email)', required: true }] : []),
            ...(!params.body ? [{ id: 'body', type: 'text' as const, label: 'Mensaje', required: true }] : []),
          ],
        },
      );
    }
    const subject = params.subject ?? 'Mensaje de EVA';
    const preview = `**Para:** ${params.to}\n**Asunto:** ${subject}\n\n${params.body}`;
    const approval = await this.approvals.requestForPreparedAction({
      orgId,
      userId: task.created_by,
      taskId,
      actionType: 'gmail.send',
      payload: { to: params.to, subject, body: params.body },
      summary: `Enviar correo a ${params.to}: ${subject}`,
      notify: false,
    });
    const text = `📧 Voy a enviar este correo:\n\n${preview}\n\n¿Lo envío? Responde **sí** para enviarlo o **no** para cancelar.`;
    await this.events.publish({ type: 'task.result', orgId, taskId, payload: { text, model: 'gmail-write', latency_ms: Date.now() - startedAt } });
    await this.tasks.transition(taskId, orgId, 'waiting_for_approval', { result: { text, model: 'gmail-write', approval_id: approval.id } });
  }

  private async handleGmailReplyRequest(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    const searchQuery = this.extractEmailSearch(input);
    const body = this.extractReplyBody(input);
    if (!searchQuery || !body) {
      throw new MissingInformationError(
        'Para responder necesito identificar el correo y el texto de la respuesta.',
        {
          form_key: 'gmail.reply',
          title: 'Responder correo',
          description: 'Indica el remitente/asunto y el texto de tu respuesta.',
          fields: [
            { id: 'search_query', type: 'text' as const, label: 'Remitente o asunto del correo original', required: true },
            { id: 'body', type: 'text' as const, label: 'Tu respuesta', required: true },
          ],
        },
      );
    }
    const messages = await this.gmail.findMessages(orgId, searchQuery, 1);
    if (messages.length === 0) {
      await this.deliver(orgId, taskId, `📬 No encontré el correo al que quieres responder. Intenta ser más específico.`, 'gmail-write', Date.now() - startedAt);
      return;
    }
    const msg = messages[0];
    const preview = `**Respondiendo a:** ${msg.from}\n**Asunto:** ${msg.subject}\n\n**Tu respuesta:** ${body}`;
    const approval = await this.approvals.requestForPreparedAction({
      orgId,
      userId: task.created_by,
      taskId,
      actionType: 'gmail.reply',
      payload: { message_id: msg.id, body },
      summary: `Responder a ${msg.from}: ${msg.subject}`,
      notify: false,
    });
    const text = `📧 Voy a responder este correo:\n\n${preview}\n\n¿La envío? Responde **sí** para enviarla o **no** para cancelar.`;
    await this.events.publish({ type: 'task.result', orgId, taskId, payload: { text, model: 'gmail-write', latency_ms: Date.now() - startedAt } });
    await this.tasks.transition(taskId, orgId, 'waiting_for_approval', { result: { text, model: 'gmail-write', approval_id: approval.id } });
  }

  private async handleGmailSingleMessageOp(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
    actionType: string,
    opLabel: string,
  ): Promise<void> {
    const searchQuery = this.extractEmailSearch(input) ?? this.extractTrashTarget(input);
    if (!searchQuery) {
      await this.deliver(orgId, taskId, '¿Cuál correo? Descríbelo por remitente o asunto para que pueda identificarlo.', 'gmail-write', Date.now() - startedAt);
      return;
    }
    const messages = await this.gmail.findMessages(orgId, searchQuery, 1);
    if (messages.length === 0) {
      await this.deliver(orgId, taskId, `📬 No encontré ese correo. Intenta describirlo de otra forma.`, 'gmail-write', Date.now() - startedAt);
      return;
    }
    const msg = messages[0];
    const date = msg.date ? ` (${this.relativeEmailDate(msg.date)})` : '';
    const preview = `**De:** ${msg.from}\n**Asunto:** ${msg.subject || '(sin asunto)'}${date}\n${msg.snippet ? `_${msg.snippet.slice(0, 100)}_` : ''}`;
    const approval = await this.approvals.requestForPreparedAction({
      orgId,
      userId: task.created_by,
      taskId,
      actionType,
      payload: { message_id: msg.id, summary: `${msg.subject} — ${msg.from}` },
      summary: `${opLabel}: ${msg.subject} — ${msg.from}`,
      notify: false,
    });
    const text = `${opLabel}:\n\n${preview}\n\n¿Confirmo? Responde **sí** para hacerlo o **no** para cancelar.`;
    await this.events.publish({ type: 'task.result', orgId, taskId, payload: { text, model: 'gmail-write', latency_ms: Date.now() - startedAt } });
    await this.tasks.transition(taskId, orgId, 'waiting_for_approval', { result: { text, model: 'gmail-write', approval_id: approval.id } });
  }

  // ── Calendar write handlers ───────────────────────────────────────────────

  private async handleCalendarWriteIntent(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    if (CALENDAR_DELETE_SIGNALS.test(input)) {
      await this.handleCalendarDeleteRequest(orgId, taskId, task, input, startedAt);
    } else if (CALENDAR_UPDATE_SIGNALS.test(input)) {
      await this.handleCalendarUpdateRequest(orgId, taskId, task, input, startedAt);
    } else {
      await this.handleCalendarCreateRequest(orgId, taskId, task, input, startedAt);
    }
  }

  private async handleCalendarCreateRequest(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    const eventInput = this.extractCalendarCreateParams(input);
    if (!eventInput) {
      throw new MissingInformationError(
        'Para crear el evento necesito el título, fecha y hora.',
        {
          form_key: 'calendar.create',
          title: 'Nuevo evento de calendario',
          description: 'Completa los datos del evento antes de que te pida confirmación.',
          fields: [
            { id: 'summary', type: 'text' as const, label: 'Título del evento', required: true },
            { id: 'start', type: 'text' as const, label: 'Fecha y hora de inicio (ej. 2026-06-15T10:00:00)', required: true },
            { id: 'end', type: 'text' as const, label: 'Fecha y hora de fin', required: true },
          ],
        },
      );
    }
    const preview = [
      `**Evento:** ${eventInput.summary}`,
      `**Inicio:** ${eventInput.startDateTime}`,
      `**Fin:** ${eventInput.endDateTime}`,
      eventInput.description ? `**Descripción:** ${eventInput.description}` : '',
      eventInput.attendees?.length ? `**Invitados:** ${eventInput.attendees.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const approval = await this.approvals.requestForPreparedAction({
      orgId,
      userId: task.created_by,
      taskId,
      actionType: 'calendar.create',
      payload: eventInput as unknown as Record<string, unknown>,
      summary: `Crear evento: ${eventInput.summary} el ${eventInput.startDateTime}`,
      notify: false,
    });
    const text = `🗓️ Voy a crear este evento:\n\n${preview}\n\n¿Lo creo? Responde **sí** para confirmarlo o **no** para cancelar.`;
    await this.events.publish({ type: 'task.result', orgId, taskId, payload: { text, model: 'calendar-write', latency_ms: Date.now() - startedAt } });
    await this.tasks.transition(taskId, orgId, 'waiting_for_approval', { result: { text, model: 'calendar-write', approval_id: approval.id } });
  }

  private async handleCalendarDeleteRequest(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    const title = this.extractCalendarEventTitle(input);
    if (!title) {
      await this.deliver(orgId, taskId, '¿Qué evento quieres cancelar? Dime el nombre exacto o la fecha para identificarlo.', 'calendar-write', Date.now() - startedAt);
      return;
    }
    const events = await this.calendar.getUpcomingEvents(orgId, 30);
    const target = events.find(e =>
      e.summary.toLowerCase().includes(title.toLowerCase())
      || title.toLowerCase().includes(e.summary.toLowerCase()),
    );
    if (!target) {
      await this.deliver(orgId, taskId, `🗓️ No encontré ningún evento próximo llamado _${title}_. Verifica el nombre o la fecha.`, 'calendar-write', Date.now() - startedAt);
      return;
    }
    const dt = new Date(target.start);
    const dateLabel = dt.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const preview = `**${target.summary}** — ${dateLabel}${target.location ? ` @ ${target.location}` : ''}`;
    const approval = await this.approvals.requestForPreparedAction({
      orgId,
      userId: task.created_by,
      taskId,
      actionType: 'calendar.delete',
      payload: { event_id: target.id, summary: target.summary },
      summary: `Eliminar evento: ${target.summary}`,
      notify: false,
    });
    const text = `🗓️ Voy a eliminar este evento:\n\n${preview}\n\n¿Lo elimino? Responde **sí** para confirmarlo o **no** para cancelar.`;
    await this.events.publish({ type: 'task.result', orgId, taskId, payload: { text, model: 'calendar-write', latency_ms: Date.now() - startedAt } });
    await this.tasks.transition(taskId, orgId, 'waiting_for_approval', { result: { text, model: 'calendar-write', approval_id: approval.id } });
  }

  private async handleCalendarUpdateRequest(
    orgId: string,
    taskId: string,
    task: Task,
    input: string,
    startedAt: number,
  ): Promise<void> {
    // Calendar update requires finding the event and a new time — use form for now.
    throw new MissingInformationError(
      'Para modificar el evento necesito saber cuál evento y cuál es el nuevo horario.',
      {
        form_key: 'calendar.update',
        title: 'Modificar evento de calendario',
        description: 'Indica el evento y los nuevos datos.',
        fields: [
          { id: 'event_title', type: 'text' as const, label: 'Nombre del evento a modificar', required: true },
          { id: 'new_start', type: 'text' as const, label: 'Nueva fecha y hora de inicio', required: true },
          { id: 'new_end', type: 'text' as const, label: 'Nueva fecha y hora de fin', required: true },
        ],
      },
    );
  }

  // ── executeApprovedAction — closes the approval → execute loop ────────────

  private async executeApprovedAction(orgId: string, taskId: string, approvalId: string): Promise<void> {
    const startedAt = Date.now();
    let approval;
    try {
      approval = await this.approvals.consumeApproved(approvalId, orgId);
    } catch (err) {
      await this.log(orgId, taskId, `executeApprovedAction: could not consume approval ${approvalId}: ${(err as Error).message}`, 'approval');
      return;
    }

    const { action_type: actionType, payload } = approval;
    await this.log(orgId, taskId, `executing approved action: ${actionType}`, 'approval');

    let resultText: string;

    try {
      switch (actionType) {
        case 'gmail.send': {
          const r = await this.gmail.sendEmail(orgId, String(payload.to), String(payload.subject), String(payload.body));
          resultText = r.ok
            ? `✅ Correo enviado a **${payload.to}**.`
            : `❌ No pude enviar el correo: ${r.error ?? r.reason}`;
          break;
        }
        case 'gmail.reply': {
          const r = await this.gmail.replyToEmail(orgId, String(payload.message_id), String(payload.body));
          resultText = r.ok
            ? '✅ Respuesta enviada.'
            : `❌ No pude enviar la respuesta: ${r.error ?? r.reason}`;
          break;
        }
        case 'gmail.trash': {
          const r = await this.gmail.trashEmail(orgId, String(payload.message_id));
          resultText = r.ok
            ? `✅ Correo movido a la papelera.`
            : `❌ No pude mover el correo a la papelera: ${r.error ?? r.reason}`;
          break;
        }
        case 'gmail.archive': {
          const r = await this.gmail.archiveEmail(orgId, String(payload.message_id));
          resultText = r.ok
            ? '✅ Correo archivado (removido del inbox).'
            : `❌ No pude archivar el correo: ${r.error ?? r.reason}`;
          break;
        }
        case 'gmail.mark_read': {
          const r = await this.gmail.markRead(orgId, String(payload.message_id));
          resultText = r.ok ? '✅ Correo marcado como leído.' : `❌ ${r.error ?? r.reason}`;
          break;
        }
        case 'gmail.mark_unread': {
          const r = await this.gmail.markUnread(orgId, String(payload.message_id));
          resultText = r.ok ? '✅ Correo marcado como no leído.' : `❌ ${r.error ?? r.reason}`;
          break;
        }
        case 'calendar.create': {
          const eventInput = payload as unknown as Parameters<typeof this.calendar.createEvent>[1];
          const created = await this.calendar.createEvent(orgId, eventInput);
          resultText = created
            ? `✅ Evento **${created.summary}** creado en tu calendario.`
            : '❌ No pude crear el evento. Verifica que tu integración de Google Calendar tenga el scope de escritura.';
          break;
        }
        case 'calendar.delete': {
          const r = await this.calendar.deleteEvent(orgId, String(payload.event_id));
          resultText = r.ok
            ? `✅ Evento eliminado de tu calendario.`
            : `❌ No pude eliminar el evento: ${r.error}`;
          break;
        }
        case 'sandbox.network_exec': {
          // Aprobada por el usuario: código del agent-loop que pidió red.
          // La tarea puede estar ya cerrada (el loop entregó y dejó esto
          // pendiente), así que se publica el resultado sin re-transicionar.
          const language = String(payload.language ?? 'python') as 'python' | 'node' | 'bash';
          const r = await this.sandbox.runOneShot({ language, code: String(payload.code ?? ''), orgId, network: true });
          const text = r.ok
            ? `✅ Ejecución con red aprobada y completada (${language}):\n\n\`\`\`\n${r.output || '(sin salida)'}\n\`\`\``
            : `❌ La ejecución con red falló: ${r.error ?? r.output}`;
          await this.events.publish({ type: 'task.result', orgId, taskId, payload: { text, model: 'sandbox-network', latency_ms: Date.now() - startedAt } });
          try {
            const current = await this.tasks.getTask(taskId, orgId);
            if (!['completed', 'failed', 'cancelled'].includes(current.status)) {
              await this.tasks.transition(taskId, orgId, 'completed', { result: { text, model: 'sandbox-network' } });
            }
          } catch { /* el resultado ya salió por el event bus */ }
          await this.log(orgId, taskId, `sandbox network exec done in ${Date.now() - startedAt}ms`, 'approval');
          return;
        }
        case 'whatsapp.message.send': {
          const contact = String(payload.contact);
          const body = String(payload.text);
          const r = await this.whatsapp.sendMessage(orgId, contact, body, taskId);
          // Evidencia visual solo si el usuario la pidió al preparar el envío.
          if (payload.send_evidence === true && r.session.screenshot) {
            await this.maybePublishBrowserScreenshot(orgId, taskId, r.session.screenshot, 'WhatsApp Web');
          }
          resultText = r.text;
          break;
        }
        default:
          await this.log(orgId, taskId, `executeApprovedAction: unknown action_type "${actionType}"`, 'approval');
          return;
      }
    } catch (err) {
      resultText = `❌ Error ejecutando la acción aprobada: ${(err as Error).message}`;
      await this.log(orgId, taskId, `executeApprovedAction error: ${(err as Error).message}`, 'approval');
    }

    await this.deliver(orgId, taskId, resultText, 'approved-action', Date.now() - startedAt);
    await this.log(orgId, taskId, `done in ${Date.now() - startedAt}ms total`, 'pipeline');
  }

  // ── NL extraction helpers for write operations ────────────────────────────

  private extractEmailSendParams(input: string): { to: string | null; subject: string | null; body: string | null } {
    const toMatch = input.match(/\b(?:a|para)\s+([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
    const to = toMatch ? toMatch[1] : null;
    const subjectMatch = input.match(/\bcon\s+asunto\s+["']?([^"'\n.,?]{2,60})["']?/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : null;
    const bodyPatterns: RegExp[] = [
      /\b(?:diciendo(le)?|que\s+diga|el\s+texto|el\s+mensaje|mensaje\s*:)\s+["']?(.{10,500})["']?$/is,
      /\bque\s+["'](.{10,500})["']$/is,
    ];
    let body: string | null = null;
    for (const pattern of bodyPatterns) {
      const m = input.match(pattern);
      if (m) { body = (m[2] ?? m[1]).trim(); break; }
    }
    return { to, subject, body };
  }

  private extractReplyBody(input: string): string | null {
    const patterns: RegExp[] = [
      /\b(?:diciendo(le)?|que\s+diga|respondiendo?|contestando?)\s+(?:que\s+)?["']?(.{5,500})["']?$/is,
      /\bque\s+["'](.{5,500})["']$/is,
    ];
    for (const pattern of patterns) {
      const m = input.match(pattern);
      if (m) return (m[2] ?? m[1]).trim();
    }
    return null;
  }

  private extractTrashTarget(input: string): string | null {
    const m = input.match(/\b(?:el|la|los|las)?\s*(?:correo|email|mail)\s+(?:de|del|sobre|con asunto)\s+([^?,.\n]{2,40}?)(?:\?|$|[.,])/i);
    return m ? m[1].trim() : null;
  }

  private extractCalendarCreateParams(input: string): CreateEventInput | null {
    // Require a date/time signal to be present before attempting to parse
    if (!/\b(\d{1,2}(:\d{2})?|\d{4}-\d{2}-\d{2}|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[nñ]ana|hoy|pr[oó]ximo|siguiente)\b/i.test(input)) {
      return null;
    }
    // Extract title — what comes after create verbs
    const titleMatch = input.match(
      /\b(?:crea[r]?|agenda[r]?|programa[r]?|añade[r]?|agrega[r]?)\s+(?:una?\s+)?(?:cita|reuni[oó]n|evento|meeting)?\s*(?:llamad[ao]|con nombre|titulad[ao])?\s*["']?([^"'\n.,?]{3,60})["']?/i,
    );
    const title = titleMatch ? titleMatch[1].trim() : null;
    if (!title) return null;

    // Extract time
    const timeMatch = input.match(/\ba\s+las?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
    const hour = timeMatch ? parseInt(timeMatch[1], 10) + (timeMatch[3]?.toLowerCase().startsWith('p') && parseInt(timeMatch[1], 10) < 12 ? 12 : 0) : 10;
    const minute = timeMatch ? parseInt(timeMatch[2] ?? '0', 10) : 0;

    // Extract date — try ISO first, then relative
    let dateStr = new Date().toISOString().slice(0, 10);
    const isoMatch = input.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (isoMatch) {
      dateStr = isoMatch[1];
    } else if (/\bma[nñ]ana\b/i.test(input)) {
      dateStr = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    }
    // Weekday matching: advance to the next occurrence
    const weekdayMap: Record<string, number> = {
      lunes: 1, martes: 2, 'miercoles': 3, 'miércoles': 3,
      jueves: 4, viernes: 5, sabado: 6, sábado: 6, domingo: 0,
    };
    const weekdayMatch = input.match(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i);
    if (weekdayMatch) {
      const targetDay = weekdayMap[weekdayMatch[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')] ?? null;
      if (targetDay !== null) {
        const d = new Date();
        while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
        dateStr = d.toISOString().slice(0, 10);
      }
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const startDateTime = `${dateStr}T${pad(hour)}:${pad(minute)}:00`;
    const endDateTime = `${dateStr}T${pad(hour + 1)}:${pad(minute)}:00`;

    return { summary: title, startDateTime, endDateTime };
  }

  private extractCalendarEventTitle(input: string): string | null {
    const m = input.match(
      /\b(?:cancela[r]?|elimina[r]?|borra[r]?|quita[r]?)\s+(?:la?\s+|el\s+)?(?:cita|evento|reuni[oó]n|meeting|compromiso)?\s*(?:de|del|llamad[ao]|titulad[ao])?\s*["']?([^"'\n.,?]{2,60})["']?/i,
    );
    return m ? m[1].trim() : null;
  }

  private relativeEmailDate(dateStr: string): string {
    if (!dateStr) return '';
    try {
      const dt = new Date(dateStr);
      const diffD = Math.floor((Date.now() - dt.getTime()) / 86_400_000);
      if (diffD === 0) return 'hoy';
      if (diffD === 1) return 'ayer';
      if (diffD < 7) return `hace ${diffD} días`;
      return dt.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    } catch {
      return dateStr;
    }
  }

  // ── R2.1: capability self-model ───────────────────────────────────────────

  /**
   * Builds a short CAPACIDADES block for the agent's system prompt.
   * Cached per run (not across runs) to avoid extra RTTs per step.
   */
  private async buildCapabilityModel(orgId: string): Promise<string> {
    const { data } = await this.db.admin
      .from('integrations')
      .select('provider, kind, status')
      .eq('org_id', orgId)
      .limit(50);

    const rows = (data ?? []) as Array<{ provider: string; kind: string; status: string }>;
    const active = rows.filter((r) => r.status === 'active').map((r) => r.provider.toLowerCase());
    const inactive = rows.filter((r) => r.status !== 'active').map((r) => r.provider.toLowerCase());

    const puedo = ['web_search', 'code_python', 'code_nodejs', 'code_bash', ...active].join(', ');
    const noTengo = inactive.length > 0 ? inactive.join(', ') : null;

    const lines = [
      'CAPACIDADES:',
      `PUEDO: ${puedo}`,
    ];
    if (noTengo) lines.push(`NO TENGO (no disponibles aún): ${noTengo}`);
    lines.push('SI FALTA ALGO: propón la alternativa más cercana con lo que SÍ está en PUEDO; nunca prometas usar algo que no está en PUEDO.');
    return lines.join('\n');
  }
}
