import { Test, TestingModule } from '@nestjs/testing';
import { BehaviorPatternService } from '../behavior-pattern.service';
import { GmailService } from '../gmail.service';
import { GoogleDriveService } from '../google-drive.service';
import { CapabilityGateService } from '../../capability-gate/capability-gate.service';
import { EventBusService } from '../../events/event-bus.service';
import { IntentRouterService } from '../../intent-router/intent-router.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { TasksService } from '../../tasks/tasks.service';
import { DatabaseService } from '../../database/database.service';
import { ToolRouterService } from '../../tool-router/tool-router.service';
import { AgentLoopService } from '../agent-loop.service';
import { AgentRunnerService } from '../agent-runner.service';
import { ConversationDigesterService } from '../conversation-digester.service';
import { GoogleCalendarService } from '../google-calendar.service';
import { MediaService } from '../media.service';
import { MemoryRecallService } from '../memory-recall.service';
import { MissingInformationError, ResearchToolsService } from '../research-tools.service';
import { SandboxService } from '../sandbox.service';
import { ScheduleService } from '../schedule.service';
import { ScriptForgeService } from '../script-forge.service';
import { SoulContextService } from '../soul-context.service';
import { UberWebService } from '../../integrations/uber-web.service';
import { RappiWebService } from '../../integrations/rappi-web.service';
import { GoogleWebLoginService } from '../../integrations/google-web-login.service';
import { WhatsAppWebService } from '../../integrations/whatsapp-web.service';
import { classifyTier, decideTaskHorizon } from '../tier';
import { Task } from '../../tasks/task.types';
import { AGENT_AUTONOMY_JOB_KEY, ScheduledJobsService } from '../../jobs/scheduled-jobs.service';
import { CommunicationService } from '../../communication/communication.service';
import { AgentIntelligenceService } from '../agent-intelligence.service';
import { PipelineRunnerService } from '../pipeline-runner.service';
import { ProfileContextBuilderService } from '../profile-context-builder.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    org_id: ORG,
    created_by: 'user-1',
    title: 'Busca el clima',
    description: 'Busca el clima de hoy en CDMX',
    status: 'pending',
    metadata: {},
    result: null,
    error: null,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('classifyTier', () => {
  it('routes greetings and short messages to chat', () => {
    expect(classifyTier('hola').tier).toBe('chat');
    expect(classifyTier('¿cómo estás?').tier).toBe('chat');
    expect(classifyTier('gracias!').tier).toBe('chat');
  });

  it('routes lookups to quick (<1 min)', () => {
    expect(classifyTier('busca el clima de hoy').tier).toBe('quick');
    expect(classifyTier('el clima').tier).toBe('quick');
    expect(classifyTier('¿cuánto cuesta el dólar?').tier).toBe('quick');
    expect(classifyTier('puedes decirme un restaurante de comida argentina rico para ir').tier).toBe('quick');
    expect(classifyTier('crea una imagen de un gato conduciendo').tier).toBe('quick');
    expect(classifyTier('dame una receta con pollo').tier).toBe('quick');
    expect(classifyTier('dame el ultimo correo').tier).toBe('quick');
  });

  it('routes current-information requests to quick instead of chat', () => {
    expect(classifyTier('que esta pasando ahora con OpenAI').tier).toBe('quick');
    expect(classifyTier('dame lo ultimo de bitcoin').tier).toBe('quick');
    expect(classifyTier('cual es el clima de manana').tier).toBe('quick');
    expect(classifyTier('que partidos del munidal jugara primero').tier).toBe('quick');
  });

  it('routes automation/code orders to long (background)', () => {
    expect(classifyTier('crea un script que limpie mis descargas').tier).toBe('long');
    expect(classifyTier('crea un script que me de mi peso en diferentes planetas usando docker').tier).toBe('long');
    expect(classifyTier('automatiza un reporte cada día').tier).toBe('long');
    expect(classifyTier('puedes descargar un video de youtube de platzi y mandarmelo por telegram?').tier).toBe('long');
    expect(classifyTier('descárgame el video').tier).toBe('long');
    expect(classifyTier('bájalo de youtube').tier).toBe('long');
    expect(classifyTier('descárgamelo de youtube y mándamelo por telegram').tier).toBe('long');
    expect(classifyTier('envíaselo a mi mamá por whatsapp').tier).toBe('long');
  });

  it('handles Spanish verbs with trailing pronouns without taking the chat shortcut', () => {
    expect(classifyTier('recuérdamelo mañana').tier).toBe('quick');
    expect(classifyTier('mándaselo a Luis').tier).toBe('long');
    expect(classifyTier('descargámelo en mp3').tier).toBe('long');
  });

  it('never lets sensitive actions take the chat shortcut', () => {
    expect(classifyTier('compra el dominio eva.dev').tier).toBe('quick');
    expect(classifyTier('borra la base de datos').tier).toBe('quick');
  });

  it('routes multi-step/range/reasoning requests to medium', () => {
    expect(classifyTier('clima de los siguientes 3 dias').tier).toBe('medium');
    expect(classifyTier('busca noticias de bitcoin de hoy y resume el impacto en el precio').tier).toBe('medium');
    expect(classifyTier('dame el clima de los proximos 5 dias').tier).toBe('medium');
    expect(classifyTier('revisa mis ultimos 3 correos').tier).toBe('medium');
    expect(classifyTier('compara el precio de bitcoin vs ethereum').tier).toBe('medium');
  });
});

describe('decideTaskHorizon', () => {
  it('marks recurring work as a visible scheduled job horizon', () => {
    const decision = decideTaskHorizon('automatiza un reporte cada día a las 7');

    expect(decision.mode).toBe('scheduled');
    expect(decision.waitPolicy).toBe('schedule');
    expect(decision.shouldCreateScheduledJob).toBe(true);
    expect(decision.resumable).toBe(true);
  });

  it('parks external waits as standby instead of pretending immediate completion', () => {
    const decision = decideTaskHorizon('espera a que me responda Ana y luego seguimos');

    expect(decision.mode).toBe('standby');
    expect(decision.waitPolicy).toBe('external_event');
    expect(decision.timeoutMinutes).toBe(24 * 60);
  });

  it('keeps sensitive actions on the approval horizon', () => {
    const decision = decideTaskHorizon('borra la base de datos');

    expect(decision.mode).toBe('approval');
    expect(decision.waitPolicy).toBe('approval');
  });

  it('treats code and skill improvement work as background self-improvement work', () => {
    const decision = decideTaskHorizon('mejora tus skills usando código y terminal');

    expect(decision.mode).toBe('background');
    expect(decision.shouldUseCodeTools).toBe(true);
    expect(decision.shouldUseSkills).toBe(true);
    expect(decision.shouldSelfImprove).toBe(true);
  });
});

describe('AgentRunnerService', () => {
  let module: TestingModule;
  let service: AgentRunnerService;
  let events: jest.Mocked<EventBusService>;
  let tasks: jest.Mocked<TasksService>;
  let intentRouter: jest.Mocked<IntentRouterService>;
  let modelRouter: jest.Mocked<ModelRouterService>;
  let media: jest.Mocked<MediaService>;
  let research: jest.Mocked<ResearchToolsService>;
  let agentLoop: jest.Mocked<AgentLoopService>;
  let pipeline: jest.Mocked<PipelineRunnerService>;
  let forge: jest.Mocked<ScriptForgeService>;
  let soul: jest.Mocked<SoulContextService>;
  let db: any;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        ProfileContextBuilderService,
        {
          provide: DatabaseService,
          useValue: {
            admin: {
              from: jest.fn().mockReturnThis(),
              select: jest.fn().mockReturnThis(),
              update: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              order: jest.fn().mockReturnThis(),
              limit: jest.fn().mockResolvedValue({ data: [], error: null }),
            },
          },
        },
        {
          provide: EventBusService,
          useValue: { publish: jest.fn().mockResolvedValue('0-1'), on: jest.fn() },
        },
        {
          provide: TasksService,
          useValue: {
            getTask: jest.fn().mockResolvedValue(makeTask()),
            transition: jest.fn().mockImplementation(async (_id, _org, status) => makeTask({ status })),
            findStuck: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: IntentRouterService,
          useValue: {
            classify: jest.fn().mockResolvedValue({
              intent: 'fast_path', confidence: 0.9, classifier: 'rule', reasons: ['lookup keyword'],
            }),
          },
        },
        {
          provide: ModelRouterService,
          useValue: {
            generate: jest.fn().mockResolvedValue({
              text: 'Hoy en CDMX: 22°C, despejado.',
              model: 'claude-haiku-4-5-20251001',
              backend: 'claude',
              usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
            }),
          },
        },
        {
          provide: ToolRouterService,
          useValue: {
            route: jest.fn().mockReturnValue({
              tool: { name: 'web-search', avgLatencyMs: 800 },
              score: 0.12,
              alternates: [],
              matchedCapability: 'search',
            }),
          },
        },
        {
          provide: MediaService,
          useValue: {
            wantsImage: jest.fn().mockReturnValue(false),
            wantsAudio: jest.fn().mockReturnValue(false),
            sendImage: jest.fn().mockResolvedValue('https://bucket/eva-media/img.svg'),
            sendAudio: jest.fn().mockResolvedValue('https://bucket/eva-media/audio.mp3'),
            upload: jest.fn().mockResolvedValue('https://bucket/eva-media/screenshot.png'),
          },
        },
        {
          provide: ResearchToolsService,
          useValue: {
            canAnswer: jest.fn().mockReturnValue(true),
            answer: jest.fn().mockResolvedValue({
              text: 'Resultado encontrado con busqueda web.',
              tool: 'chromium:duckduckgo',
              sources: ['https://duckduckgo.com/html/'],
            }),
          },
        },
        {
          provide: ScriptForgeService,
          useValue: {
            isScriptTask: jest.fn().mockReturnValue(false),
            forge: jest.fn().mockResolvedValue({
              language: 'python',
              filename: 'cleaner.py',
              description: 'Limpia descargas',
              executed: true,
              output: 'OK: 12 archivos',
              skillSlug: 'gen-cleaner',
            }),
          },
        },
        {
          provide: SoulContextService,
          useValue: {
            getPersonalProfile: jest.fn().mockResolvedValue({}),
            getCoworkContext: jest.fn().mockResolvedValue({}),
            getAgentContext: jest.fn().mockResolvedValue({
              personal_profile: {}, cowork_context: {}, goals: [], persona_context: {},
            }),
            resolveCurrentLocation: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: CapabilityGateService,
          useValue: { firstMissingRequirement: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: GoogleCalendarService,
          useValue: {
            formatUpcomingForSoul: jest.fn().mockResolvedValue(null),
            isConnected: jest.fn().mockResolvedValue(false),
            getUpcomingEvents: jest.fn().mockResolvedValue([]),
            createEvent: jest.fn().mockResolvedValue(null),
            deleteEvent: jest.fn().mockResolvedValue({ ok: true }),
            updateEvent: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: MemoryRecallService,
          useValue: { check: jest.fn().mockResolvedValue({ isRecall: false, context: null, memories: [] }) },
        },
        {
          provide: ConversationDigesterService,
          useValue: { digestAsync: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AgentLoopService,
          // Default ok:false → callers fall through to the classic pipeline.
          useValue: {
            run: jest.fn().mockResolvedValue({ ok: false, text: '', steps: [], tokensUsed: 0, toolsUsed: [] }),
          },
        },
        {
          provide: SandboxService,
          useValue: {
            release: jest.fn().mockResolvedValue(undefined),
            runOneShot: jest.fn().mockResolvedValue({ ok: true, output: 'net ok' }),
          },
        },
        {
          provide: ScheduleService,
          useValue: { formatUpcomingForSoul: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: BehaviorPatternService,
          useValue: {
            formatPatternsForSoul: jest.fn().mockResolvedValue(null),
            getTriggersNow: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: GmailService,
          useValue: {
            fetchLatest: jest.fn().mockResolvedValue({ ok: false, reason: 'no_credential' }),
            fetchSearch: jest.fn().mockResolvedValue({ ok: false, reason: 'no_credential' }),
            fetchSearchWithFallback: jest.fn().mockResolvedValue({ ok: false, reason: 'no_credential' }),
            formatLatestForResponse: jest.fn().mockResolvedValue(null),
            isConnected: jest.fn().mockResolvedValue(false),
            findMessages: jest.fn().mockResolvedValue([]),
            sendEmail: jest.fn().mockResolvedValue({ ok: false, reason: 'no_credential' }),
            replyToEmail: jest.fn().mockResolvedValue({ ok: false, reason: 'no_credential' }),
            trashEmail: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-1', threadId: 'thread-1' }),
            archiveEmail: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-1', threadId: 'thread-1' }),
            markRead: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-1', threadId: 'thread-1' }),
            markUnread: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-1', threadId: 'thread-1' }),
          },
        },
        {
          provide: GoogleDriveService,
          useValue: {
            fetchForQuery: jest.fn().mockResolvedValue({ ok: false, reason: 'no_credential' }),
          },
        },
        {
          provide: UberWebService,
          useValue: {
            startEmailLogin: jest.fn().mockResolvedValue({ ok: true, reason: 'code_required', session_id: 'uber-session-1', text: 'Ingresé el correo en Uber. Dime el código.' }),
            submitLoginCode: jest.fn().mockResolvedValue({ ok: true, reason: 'logged_in', session_id: 'uber-session-1', text: '✅ Uber quedó autenticado.' }),
            startSession: jest.fn().mockResolvedValue({
              session_id: 'uber-session-1',
              state: 'logged_in',
              current_url: 'https://m.uber.com/go/home',
              google_login_available: false,
              screenshot: {
                id: 'uber-shot-1',
                org_id: ORG,
                session_id: 'uber-session-1',
                task_id: TASK,
                image_base64: 'dWJlcg==',
                mime_type: 'image/png',
                created_at: new Date().toISOString(),
              },
            }),
            estimateRide: jest.fn().mockResolvedValue({
              ok: true,
              reason: 'quote_ready',
              session: {
                session_id: 'uber-session-1',
                state: 'quote_ready',
                current_url: 'https://m.uber.com/go/product-selection',
                google_login_available: false,
                screenshot: {
                  id: 'uber-shot-1',
                  org_id: ORG,
                  session_id: 'uber-session-1',
                  task_id: TASK,
                  image_base64: 'dWJlcg==',
                  mime_type: 'image/png',
                  created_at: new Date().toISOString(),
                },
              },
              origin: 'Roma Norte',
              destination: 'Aeropuerto',
              candidates: [{ label: 'UberX', price: '$180', raw_lines: ['UberX', '$180'] }],
              text: 'Cotización visible de Uber para Roma Norte → Aeropuerto:\n\n- UberX: $180\n\nTe envié screenshot para confirmar. No pedí ni confirmé ningún viaje.',
            }),
          },
        },
        {
          provide: WhatsAppWebService,
          useValue: {
            startSession: jest.fn().mockResolvedValue({
              session_id: 'browser-session-1',
              state: 'logged_in',
              current_url: 'https://web.whatsapp.com/',
            }),
            captureSessionScreenshot: jest.fn().mockResolvedValue({
              session_id: 'browser-session-1',
              state: 'logged_in',
              current_url: 'https://web.whatsapp.com/',
              screenshot: {
                id: 'whatsapp-shot-1',
                org_id: ORG,
                session_id: 'browser-session-1',
                task_id: TASK,
                image_base64: 'd2hhdHNhcHA=',
                mime_type: 'image/png',
                created_at: new Date().toISOString(),
              },
            }),
            fetchLatestMessage: jest.fn().mockResolvedValue({
              ok: true,
              session: {
                session_id: 'browser-session-1',
                state: 'logged_in',
                current_url: 'https://web.whatsapp.com/',
              },
              latest: {
                chat_name: 'Ana',
                preview: 'Voy en camino',
                time: '17:38',
                raw_lines: ['Ana', '17:38', 'Voy en camino'],
              },
              text: 'Tu último chat visible en WhatsApp es **Ana** (17:38):\n\nVoy en camino',
            }),
            fetchUnreadMessages: jest.fn().mockResolvedValue({
              ok: true,
              session: {
                session_id: 'browser-session-1',
                state: 'logged_in',
                current_url: 'https://web.whatsapp.com/',
              },
              unread: [{
                chat_name: 'Ana',
                preview: 'Voy en camino',
                time: '17:38',
                unread_count: 2,
                raw_lines: ['Ana', '17:38', 'Voy en camino', '2'],
              }],
              text: 'Chats visibles con mensajes sin leer en WhatsApp:\n\n- **Ana** (17:38): Voy en camino — 2 sin leer',
            }),
            fetchUnansweredMessages: jest.fn().mockResolvedValue({
              ok: true,
              session: {
                session_id: 'browser-session-1',
                state: 'logged_in',
                current_url: 'https://web.whatsapp.com/',
              },
              pending: [{
                chat_name: 'Ana',
                preview: 'Me avisas cuando llegues',
                time: '17:38',
                latest_from_me: false,
                raw_lines: ['Ana', '17:38', 'Me avisas cuando llegues'],
              }],
              answered: [{
                chat_name: 'Luis',
                preview: 'Ya quedó',
                time: '17:20',
                latest_from_me: true,
                raw_lines: ['Luis', '17:20', '(You)', 'Ya quedó'],
              }],
              text: 'Chats visibles sin responder en WhatsApp:\n\n- **Ana** (17:38): Me avisas cuando llegues\n\nYa contestados visibles:\n- **Luis** (17:20): Ya quedó',
            }),
            fetchContactMessages: jest.fn().mockResolvedValue({
              ok: true,
              session: {
                session_id: 'browser-session-1',
                state: 'logged_in',
                current_url: 'https://web.whatsapp.com/',
              },
              contact: 'Michael Sec',
              messages: ['[2:09 pm]: Hola'],
              text: 'Mensajes recientes de **Michael Sec** en WhatsApp:\n\n[2:09 pm]: Hola',
            }),
            sendMessage: jest.fn().mockResolvedValue({
              ok: true,
              session: {
                session_id: 'browser-session-1',
                state: 'logged_in',
                current_url: 'https://web.whatsapp.com/',
              },
              text: '✅ Mensaje enviado con éxito',
            }),
          },
        },
        {
          provide: ApprovalsService,
          useValue: {
            requestForPreparedAction: jest.fn().mockResolvedValue({
              id: 'approval-1',
              action_hash: 'a'.repeat(64),
            }),
            consumeApproved: jest.fn().mockRejectedValue(new Error('Not approved')),
            approve: jest.fn().mockResolvedValue({}),
            reject: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: ScheduledJobsService,
          useValue: {
            list: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 'job-1', name: 'Test' }),
            createFromNl: jest.fn().mockResolvedValue({
              job: { id: 'job-1', name: 'Test', cron_expr: '0 7 * * *', schedule_type: 'cron', timezone: 'America/Mexico_City' },
              summary: '"Test" programado a las **7:00** (todos los días, zona America/Mexico_City).',
            }),
            activateManero: jest.fn().mockResolvedValue({
              id: 'job-1', name: 'Mañanero 🌅', cron_expr: '0 7 * * *', schedule_type: 'cron', timezone: 'America/Mexico_City',
            }),
            pause: jest.fn().mockResolvedValue({ id: 'job-1', name: 'Test', status: 'paused' }),
            ensureDefaultJobs: jest.fn().mockResolvedValue(undefined),
            describeSchedule: jest.fn().mockReturnValue('"Mañanero 🌅" programado a las **7:00** (todos los días, zona America/Mexico_City).'),
          },
        },
        {
          provide: CommunicationService,
          useValue: {
            listActiveChannels: jest.fn().mockResolvedValue(['dashboard']),
          },
        },
        {
          provide: RappiWebService,
          useValue: {
            startEmailLogin: jest.fn().mockResolvedValue({ ok: true, reason: 'code_required', session_id: 'rappi-session-1', text: 'Ingresé el correo en Rappi. Dime el código.' }),
            submitLoginCode: jest.fn().mockResolvedValue({ ok: true, reason: 'logged_in', session_id: 'rappi-session-1', text: '✅ Rappi quedó autenticado.' }),
            startSession: jest.fn().mockResolvedValue({ session_id: 'rappi-session-1', state: 'login_required', current_url: null }),
          },
        },
        {
          provide: GoogleWebLoginService,
          useValue: {
            openManualLogin: jest.fn().mockResolvedValue({ ok: true, app: 'Google Chrome', url: 'https://accounts.google.com', profile_id: 'profile-1', text: 'Chrome se abrió con el perfil de Google.' }),
            startSession: jest.fn().mockResolvedValue({ ok: true, state: 'logged_in', session_id: 'google-session-1', text: 'Autenticado.' }),
            hasCredential: jest.fn().mockResolvedValue(false),
          },
        },
        {
          provide: AgentIntelligenceService,
          useValue: {
            loadRetryContext: jest.fn().mockResolvedValue(null),
            persistRetryContext: jest.fn().mockResolvedValue(undefined),
            buildRetryContext: jest.fn().mockResolvedValue(null),
            registerCapabilityGap: jest.fn().mockResolvedValue(undefined),
            getCapabilityGapsDigest: jest.fn().mockResolvedValue(null),
            maxStepsForTier: jest.fn().mockResolvedValue(4),
            askUser: jest.fn().mockResolvedValue('WAITING_FOR_INPUT'),
            runAutonomyForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PipelineRunnerService,
          useValue: {
            isMultiPhase: jest.fn().mockReturnValue(false),
            run: jest.fn().mockResolvedValue({ ok: true, text: 'pipeline done', phases: [], totalTokens: 0, totalSteps: 0, durationMs: 0 }),
          },
        },
      ],
    }).compile();

    service = module.get(AgentRunnerService);
    agentLoop = module.get(AgentLoopService);
    events = module.get(EventBusService);
    tasks = module.get(TasksService);
    intentRouter = module.get(IntentRouterService);
    modelRouter = module.get(ModelRouterService);
    media = module.get(MediaService);
    research = module.get(ResearchToolsService);
    pipeline = module.get(PipelineRunnerService);
    forge = module.get(ScriptForgeService);
    soul = module.get(SoulContextService);
    db = module.get(DatabaseService);
  });

  function publishedTypes() {
    return events.publish.mock.calls.map(([event]) => event.type);
  }
  function publishedLogs() {
    return events.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'task.log')
      .map((event) => (event.payload as { message: string }).message);
  }

  it('answers a greeting directly: no filler, no intent classification, cheap model', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'hola, ¿cómo vas?' }));

    await service.run(ORG, TASK);

    expect(publishedTypes()).not.toContain('task.say');
    expect(intentRouter.classify).not.toHaveBeenCalled();
    expect(modelRouter.generate).toHaveBeenCalledWith('hola, ¿cómo vas?', expect.objectContaining({
      budget: 'cheap',
    }));
    expect(publishedTypes()).toContain('task.result');
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('adds slim Soul identity to greeting prompts without heavy cowork blocks', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'hola' }));
    soul.getAgentContext.mockResolvedValue({
      personal_profile: { full_name: 'Diego' },
      cowork_context: {
        pending_tasks: 'Preparar reporte semanal',
        work_hours: 'Lun-vie 9:00-18:00',
      },
      goals: [],
      persona_context: {},
    });

    await service.run(ORG, TASK);

    expect(intentRouter.classify).not.toHaveBeenCalled();
    // Identity travels with the prompt…
    expect(modelRouter.generate).toHaveBeenCalledWith(
      expect.stringContaining('Diego'),
      expect.objectContaining({ budget: 'cheap' }),
    );
    // …but heavy blocks (pending tasks, schedules) stay out of the chat path.
    expect(modelRouter.generate).not.toHaveBeenCalledWith(
      expect.stringContaining('Preparar reporte semanal'),
      expect.anything(),
    );
  });

  it('answers personal profile questions from Soul instead of inventing placeholders', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'sabes mi nombre y mi edad ?' }));
    soul.getPersonalProfile.mockResolvedValue({ full_name: 'Diego', age: '34' });

    await service.run(ORG, TASK);

    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(intentRouter.classify).not.toHaveBeenCalled();
    const resultEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    expect(resultEvent).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        model: 'soul-profile',
        text: expect.stringContaining('Diego'),
      }),
    }));
    expect((resultEvent!.payload as { text: string }).text).toContain('34');
    expect((resultEvent!.payload as { text: string }).text).not.toContain('[Nombre]');
    expect((resultEvent!.payload as { text: string }).text).not.toContain('[Edad]');
  });

  it('requests a Soul form when personal profile facts are missing', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'sabes mi nombre y mi edad ?' }));
    soul.getPersonalProfile.mockResolvedValue({});

    await service.run(ORG, TASK);

    expect(modelRouter.generate).not.toHaveBeenCalled();
    const formEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.form_request');
    expect(formEvent).toEqual(expect.objectContaining({
      orgId: ORG,
      taskId: TASK,
      payload: expect.objectContaining({
        message: expect.stringContaining('Me faltan estos datos en tu Soul'),
        form: expect.objectContaining({
          form_key: 'personal_profile.identity',
          fields: expect.arrayContaining([
            expect.objectContaining({ id: 'full_name', label: 'Nombre' }),
            expect.objectContaining({ id: 'age', label: 'Edad', type: 'number' }),
          ]),
        }),
      }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_input');
    expect(publishedTypes()).not.toContain('task.result');
  });

  it('runs weather through public APIs without spending planner tokens', async () => {
    research.answer.mockResolvedValue({
      text: 'Pronostico: manana 18-24 °C con lluvia ligera.',
      tool: 'open-meteo',
      sources: ['https://api.open-meteo.com/v1/forecast'],
    });

    await service.run(ORG, TASK); // "Busca el clima de hoy en CDMX"

    const published = events.publish.mock.calls.map(([event]) => event);
    expect(published[0].type).toBe('task.say');
    expect((published[0].payload as { text: string }).text).toContain('API pública');

    const logs = publishedLogs();
    expect(logs.some((message) => message.includes('tier=quick'))).toBe(true);
    expect(logs.some((message) => message.includes('intent=fast_path'))).toBe(true);
    expect(logs.some((message) => message.includes('tool-router: capability "api"'))).toBe(true);
    expect(logs.some((message) => message.includes('API pública directa'))).toBe(true);
    expect(logs.some((message) => message.includes('tool open-meteo'))).toBe(true);
    expect(logs.some((message) => message.includes('research-plan'))).toBe(false);

    expect(research.answer).toHaveBeenCalledWith('Busca el clima de hoy en CDMX', ORG);
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(publishedTypes()).toContain('task.result');
  });

  it('executes scheduled autonomy jobs internally without model calls', async () => {
    const intelligence = module.get(AgentIntelligenceService) as jest.Mocked<AgentIntelligenceService>;
    tasks.getTask.mockResolvedValue(makeTask({
      title: '[⏰ Job] Autonomía de EVA',
      description: 'Ejecuta mantenimiento interno de EVA',
      metadata: {
        scheduled_job_id: 'job-1',
        scheduled_job_payload: { system_job: AGENT_AUTONOMY_JOB_KEY },
      },
    }));

    await service.run(ORG, TASK);

    expect(intelligence.runAutonomyForOrg).toHaveBeenCalledWith(ORG, 'user-1');
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(agentLoop.run).not.toHaveBeenCalled();
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', {
      result: expect.objectContaining({
        text: 'Autonomía interna completada.',
        model: 'agent-intelligence',
      }),
    });
  });

  it('routes multi-day weather to the agent loop with restricted maxSteps', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      title: 'Clima 3 dias',
      description: 'todo bien cual es el clima de los siguientes 3 dias',
    }));
    agentLoop.run.mockResolvedValue({
      ok: true,
      text: 'Clima 3 días: Viernes lluvia, Sábado sol, Domingo templado.',
      steps: [{ tool: 'web_search', args: { query: 'clima 3 dias' }, thought: 'buscar', observation: 'datos' }],
      tokensUsed: 120,
      toolsUsed: ['web_search'],
    });

    await service.run(ORG, TASK);

    const logs = publishedLogs();
    expect(logs.some((message) => message.includes('tier=medium'))).toBe(true);
    expect(agentLoop.run).toHaveBeenCalledWith(ORG, TASK, 'todo bien cual es el clima de los siguientes 3 dias', expect.objectContaining({ maxSteps: 4 }));
    expect(publishedTypes()).toContain('task.result');
  });

  it('passes phase-retry mode to the pipeline when task metadata has failed phases', async () => {
    pipeline.isMultiPhase.mockReturnValue(true);
    const description = 'Investiga a fondo ventas trimestrales, redacta un informe extenso, luego conviértelo a PDF y finalmente envíalo por Telegram';
    const retryTask = makeTask({
      title: 'Pipeline fallido',
      description,
      metadata: {
        pipeline: {
          retryable: true,
          phases: [
            { name: 'crear_informe', status: 'completed' },
            { name: 'convertir_pdf', status: 'failed' },
            { name: 'enviar_telegram', status: 'skipped' },
          ],
        },
      },
    });
    expect((service as any).hasRetryablePipeline(retryTask)).toBe(true);
    tasks.getTask.mockResolvedValue(retryTask);

    await (service as any).handleMultiPhasePipeline({
      orgId: ORG,
      taskId: TASK,
      task: retryTask,
      input: description,
      startedAt: Date.now(),
      soulContext: { personal_profile: {}, cowork_context: {}, goals: [], persona_context: {} },
      conversationContext: [],
    }, true);

    expect(pipeline.run).toHaveBeenCalledWith(
      ORG,
      TASK,
      description,
      expect.objectContaining({ retryFailedPhases: true }),
    );
  });

  it('uses org max step settings for long agent-loop work', async () => {
    const intelligence = module.get(AgentIntelligenceService) as jest.Mocked<AgentIntelligenceService>;
    intelligence.maxStepsForTier.mockResolvedValueOnce(9);
    tasks.getTask.mockResolvedValue(makeTask({
      title: 'Investiga',
      description: 'investiga a fondo este tema y prepara un reporte completo',
    }));
    agentLoop.run.mockResolvedValue({
      ok: true,
      text: 'Reporte listo.',
      steps: [],
      tokensUsed: 90,
      toolsUsed: [],
    });

    await service.run(ORG, TASK);

    expect(intelligence.maxStepsForTier).toHaveBeenCalledWith(ORG, 'long');
    expect(agentLoop.run).toHaveBeenCalledWith(
      ORG,
      TASK,
      'investiga a fondo este tema y prepara un reporte completo',
      expect.objectContaining({ maxSteps: 9 }),
    );
  });

  it('runs recipe requests through public APIs without planner tokens', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      title: 'Receta',
      description: 'dame una receta con pollo',
    }));
    research.answer.mockResolvedValue({
      text: 'Receta: Chicken Handi',
      tool: 'themealdb',
      sources: ['https://www.themealdb.com/api/json/v1/1/filter.php?i=chicken_breast'],
    });

    await service.run(ORG, TASK);

    expect(research.answer).toHaveBeenCalledWith('dame una receta con pollo', ORG);
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(publishedLogs().some((message) => message.includes('API pública directa'))).toBe(true);
    expect(publishedTypes()).toContain('task.result');
  });

  it('uses freshness guard for short volatile questions that would otherwise be chat', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'quien es el presidente de Mexico?',
    }));
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'presidente de Mexico actual fuente oficial',
        intent: 'lookup',
        source_hint: 'chromium',
        reason: 'Cargo publico vigente que puede cambiar despues del corte del modelo.',
      }),
      model: 'gemini-2.5-flash-lite',
      backend: 'google',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });

    await service.run(ORG, TASK);

    const published = events.publish.mock.calls.map(([event]) => event);
    expect(published[0].type).toBe('task.say');
    expect((published[0].payload as { text: string }).text).toContain('buscar en internet');
    expect(modelRouter.generate).toHaveBeenCalledTimes(1);
    expect(research.answer).toHaveBeenCalledWith('presidente de Mexico actual fuente oficial', ORG);
    expect(publishedLogs().some((message) => message.includes('freshness guard'))).toBe(true);
    expect(publishedTypes()).toContain('task.result');
  });

  it('routes sports schedules through search instead of trusting stale model memory', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'que partidos del munidal jugara primero',
    }));
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'Mundial FIFA 2026 primeros partidos calendario oficial',
        intent: 'lookup',
        source_hint: 'chromium',
        reason: 'Calendario deportivo actual que debe verificarse en fuentes recientes.',
      }),
      model: 'gemini-2.5-flash-lite',
      backend: 'google',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });

    await service.run(ORG, TASK);

    expect(intentRouter.classify).toHaveBeenCalled();
    expect(modelRouter.generate).toHaveBeenCalledTimes(1);
    expect(modelRouter.generate).toHaveBeenCalledWith(
      'que partidos del munidal jugara primero',
      expect.objectContaining({ budget: 'cheap', responseFormat: 'json' }),
    );
    expect(research.answer).toHaveBeenCalledWith('Mundial FIFA 2026 primeros partidos calendario oficial', ORG);
    expect(publishedLogs().some((message) => message.includes('buscando en internet con Chromium'))).toBe(true);
    expect(publishedTypes()).toContain('task.result');
  });

  it('normalizes ambiguous Mexico World Cup lookups to FIFA 2026 even if the planner returns Qatar 2022', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'cuando juega mexico en el mundial ?',
    }));
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'calendario mundial de fútbol Qatar 2022 partidos México',
        intent: 'lookup',
        source_hint: 'chromium',
        reason: 'El modelo uso una edicion pasada.',
      }),
      model: 'gemini-2.5-flash-lite',
      backend: 'google',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });

    await service.run(ORG, TASK);

    expect(research.answer).toHaveBeenCalledWith('Mexico Mundial FIFA 2026 calendario oficial partidos', ORG);
    expect(publishedLogs().some((message) => message.includes('research-plan: query="Mexico Mundial FIFA 2026 calendario oficial partidos"'))).toBe(true);
    expect(publishedTypes()).toContain('task.result');
  });

  it('does not normalize queries to Mexico World Cup if they do not contain those keywords in the current turn but do in the history context', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'dime el ultimo video de platzi',
    }));
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'ultimo video Platzi youtube canal oficial',
        intent: 'lookup',
        source_hint: 'chromium',
        reason: 'Pide el ultimo video de Platzi.',
      }),
      model: 'gemini-2.5-flash-lite',
      backend: 'google',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });

    await service.run(ORG, TASK);

    expect(research.answer).toHaveBeenCalledWith('ultimo video Platzi youtube canal oficial', ORG);
  });

  it('routes latest episode questions through search instead of stale model memory', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'cual es el ultimo capitulo d eone piece el anime ?',
    }));
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'ultimo episodio emitido One Piece anime fecha oficial',
        intent: 'lookup',
        source_hint: 'chromium',
        reason: 'La pregunta pide el ultimo episodio emitido y cambia con el tiempo.',
      }),
      model: 'gemini-2.5-flash-lite',
      backend: 'google',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });

    await service.run(ORG, TASK);

    expect(modelRouter.generate).toHaveBeenCalledTimes(1);
    expect(modelRouter.generate).toHaveBeenCalledWith(
      'cual es el ultimo capitulo d eone piece el anime ?',
      expect.objectContaining({ budget: 'cheap', responseFormat: 'json' }),
    );
    expect(research.answer).toHaveBeenCalledWith('ultimo episodio emitido One Piece anime fecha oficial', ORG);
    expect(publishedLogs().some((message) => message.includes('tool-router: capability "search"'))).toBe(true);
    expect(publishedLogs().some((message) => message.includes('buscando en internet con Chromium'))).toBe(true);
    expect(publishedTypes()).toContain('task.result');
  });

  it('uses playground conversation context for short follow-up lookups', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'la direccion',
      metadata: {
        source: 'playground',
        conversation_context: [
          { role: 'user', text: 'puedes decirme un restauran de comida argentina rico para ir' },
          { role: 'assistant', text: 'Te recomiendo El Gaucho, su bife de chorizo es muy bueno.' },
        ],
      },
    }));
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'direccion restaurante El Gaucho comida argentina',
        intent: 'lookup',
        source_hint: 'chromium',
        reason: 'El usuario pide la direccion del restaurante recomendado en el turno anterior.',
      }),
      model: 'gemini-2.5-flash-lite',
      backend: 'google',
      usage: { promptTokens: 60, completionTokens: 25, totalTokens: 85 },
    });

    await service.run(ORG, TASK);

    expect(modelRouter.generate).toHaveBeenCalledWith(
      expect.stringContaining('Conversación reciente'),
      expect.objectContaining({ budget: 'cheap', responseFormat: 'json' }),
    );
    expect(research.answer).toHaveBeenCalledWith('direccion restaurante El Gaucho comida argentina', ORG);
    expect(publishedLogs().some((message) => message.includes('tool-router: capability "search"'))).toBe(true);
    expect(publishedTypes()).toContain('task.result');
  });

  it('announces background mode for long tasks so the chat stays free', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'automatiza un reporte diario de ventas con gráficos y envíalo',
    }));

    await service.run(ORG, TASK);

    const firstSay = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.say');
    expect((firstSay!.payload as { text: string }).text).toContain('Va para largo');
    expect(publishedLogs().some((message) => message.includes('tier=long'))).toBe(true);
  });

  it('announces scheduled horizon and creates a visible job for recurring work', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'automatiza un reporte cada día a las 7',
    }));
    const scheduledJobs = module.get(ScheduledJobsService) as jest.Mocked<ScheduledJobsService>;

    await service.run(ORG, TASK);

    const firstSay = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.say');
    expect((firstSay!.payload as { text: string }).text).toContain('programo');
    expect(scheduledJobs.createFromNl).toHaveBeenCalledWith('automatiza un reporte cada día a las 7', ORG, 'user-1');
    expect(publishedLogs().some((message) => message.includes('horizon=scheduled'))).toBe(true);
    expect(intentRouter.classify).not.toHaveBeenCalled();
  });

  it('parks external wait tasks in waiting_for_input with a long timeout', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'espera a que me responda Ana y luego seguimos con el correo',
    }));
    const intelligence = module.get(AgentIntelligenceService) as jest.Mocked<AgentIntelligenceService>;

    await service.run(ORG, TASK);

    const firstSay = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.say');
    expect((firstSay!.payload as { text: string }).text).toContain('pausa');
    expect(intelligence.askUser).toHaveBeenCalledWith(
      ORG,
      TASK,
      expect.stringContaining('espera a que me responda Ana'),
      ['Continuar', 'Cancelar'],
      24 * 60,
    );
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'planning');
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'running');
    expect(tasks.transition).not.toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
    expect(publishedLogs().some((message) => message.includes('horizon=standby'))).toBe(true);
  });

  it('uses a slim context for chat tier — no agenda/patterns, keeps identity and recent turns', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'hola, ¿cómo vas?',
      metadata: {
        conversation_context: [
          { role: 'user', text: 'ayer te pregunté del clima' },
          { role: 'assistant', text: 'sí, 22°C' },
        ],
      },
    }));
    soul.getAgentContext.mockResolvedValue({
      personal_profile: { full_name: 'Raúl', current_location: 'CDMX' },
      cowork_context: { pending_tasks: 'terminar el deck' },
      goals: [{ id: 'g1', title: 'Correr 5k', status: 'active', created_at: '2026-01-01' }],
      persona_context: { communication_preferences: 'directo y breve' },
    } as never);
    const schedule = module.get(ScheduleService) as jest.Mocked<ScheduleService>;
    schedule.formatUpcomingForSoul.mockResolvedValue('- Junta 10am');

    await service.run(ORG, TASK);

    const prompt = modelRouter.generate.mock.calls[0][0] as string;
    expect(prompt).toContain('Raúl');
    expect(prompt).toContain('directo y breve');
    expect(prompt).toContain('ayer te pregunté del clima');
    // Heavy blocks stay out of the chat path
    expect(prompt).not.toContain('Junta 10am');
    expect(prompt).not.toContain('Correr 5k');
    expect(prompt).not.toContain('terminar el deck');
  });

  it('resolves long non-script tasks with the agent loop when it succeeds', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'automatiza un reporte diario de ventas con gráficos y envíalo',
    }));
    agentLoop.run.mockResolvedValue({
      ok: true,
      text: 'Reporte armado: ventas estables, gráfico generado.',
      steps: [{ tool: 'web_search', args: { query: 'ventas' }, thought: 'buscar', observation: 'datos' }],
      tokensUsed: 320,
      toolsUsed: ['web_search'],
    });

    soul.getAgentContext.mockResolvedValue({
      personal_profile: { full_name: 'Raúl', current_location: 'CDMX' },
      cowork_context: {}, goals: [], persona_context: {},
    } as never);

    await service.run(ORG, TASK);

    expect(agentLoop.run).toHaveBeenCalledWith(ORG, TASK,
      'automatiza un reporte diario de ventas con gráficos y envíalo',
      expect.objectContaining({ log: expect.any(Function), userId: 'user-1' }));
    // Contexto mínimo necesario: identidad del usuario disponible sin gastar un memory_recall.
    const loopCtx = (agentLoop.run.mock.calls[0][3] as { context?: string }).context ?? '';
    expect(loopCtx).toContain('Raúl');
    expect(loopCtx).toContain('CDMX');
    const resultEvent = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.result');
    expect((resultEvent!.payload as { text: string; model: string }).model).toBe('agent-loop');
    expect((resultEvent!.payload as { text: string }).text).toContain('Reporte armado');
    expect(publishedLogs().some((m) => m.includes('agent-loop resolvió en 1 pasos'))).toBe(true);
    // The classic single-shot model call never runs
    expect(modelRouter.generate).not.toHaveBeenCalled();
  });

  it('falls back to the classic pipeline when the agent loop cannot resolve', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'automatiza un reporte diario de ventas con gráficos y envíalo',
    }));
    // default agentLoop mock returns ok:false

    await service.run(ORG, TASK);

    expect(agentLoop.run).toHaveBeenCalled();
    expect(publishedLogs().some((m) => m.includes('agent-loop no resolvió'))).toBe(true);
    expect(modelRouter.generate).toHaveBeenCalled(); // classic path took over
    expect(publishedTypes()).toContain('task.result');
  });

  it('prefers the agent loop over single-tool recovery for useless answers', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'resume este texto sobre OpenAI' }));
    modelRouter.generate.mockResolvedValueOnce({
      text: 'Como modelo no tengo acceso a informacion en tiempo real.',
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
    });
    agentLoop.run.mockResolvedValue({
      ok: true,
      text: 'OpenAI: resumen con datos frescos de la web.',
      steps: [{ tool: 'web_search', args: { query: 'OpenAI' }, thought: 'buscar', observation: 'noticias' }],
      tokensUsed: 150,
      toolsUsed: ['web_search'],
    });

    await service.run(ORG, TASK);

    expect(agentLoop.run).toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled(); // old recovery skipped
    const resultEvent = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.result');
    expect((resultEvent!.payload as { text: string }).text).toContain('datos frescos');
  });

  it('forges, sandboxes and registers a skill for script orders', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'crea un script que limpie mis descargas' }));
    forge.isScriptTask.mockReturnValue(true);

    await service.run(ORG, TASK);

    expect(forge.forge).toHaveBeenCalled();
    const resultEvent = events.publish.mock.calls.map(([event]) => event).find((event) => event.type === 'task.result');
    const text = (resultEvent!.payload as { text: string }).text;
    expect(text).toContain('cleaner.py');
    expect(text).toContain('gen-cleaner');
    expect(text).toContain('OK: 12 archivos');
    expect(modelRouter.generate).not.toHaveBeenCalled(); // forge owns the model call
  });

  it('routes the playground smoke prompts through the expected agent paths', async () => {
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;

    tasks.getTask.mockResolvedValueOnce(makeTask({
      title: 'hola',
      description: 'hola',
      metadata: { source: 'playground' },
    }));
    await service.run(ORG, TASK);
    expect(modelRouter.generate).toHaveBeenCalledWith('hola', expect.objectContaining({
      budget: 'cheap',
    }));
    expect(intentRouter.classify).not.toHaveBeenCalled();
    expect(publishedTypes()).toContain('task.result');

    jest.clearAllMocks();
    research.answer.mockResolvedValue({
      text: 'Pronostico: 18-24 °C.',
      tool: 'open-meteo',
      sources: ['https://api.open-meteo.com/v1/forecast'],
    });
    tasks.getTask.mockResolvedValueOnce(makeTask({
      title: 'el clima',
      description: 'el clima',
      metadata: {
        source: 'playground',
        device_location: { latitude: 19.4326, longitude: -99.1332, accuracy: 25 },
      },
    }));
    await service.run(ORG, TASK);
    expect(research.answer).toHaveBeenCalledWith('el clima', ORG);
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(publishedLogs().some((message) => message.includes('API pública directa'))).toBe(true);

    jest.clearAllMocks();
    gmail.fetchLatest.mockResolvedValue({ ok: true, text: '📬 Último correo: **Factura digital**' });
    tasks.getTask.mockResolvedValueOnce(makeTask({
      title: 'dame el ultimo correo',
      description: 'dame el ultimo correo',
      metadata: { source: 'playground' },
    }));
    await service.run(ORG, TASK);
    expect(gmail.fetchLatest).toHaveBeenCalledWith(ORG, 1);
    expect(research.answer).not.toHaveBeenCalled();
    expect(modelRouter.generate).not.toHaveBeenCalled();

    jest.clearAllMocks();
    forge.isScriptTask.mockReturnValue(true);
    tasks.getTask.mockResolvedValueOnce(makeTask({
      title: 'crea un script que me de mi peso en diferentes planetas usando docker',
      description: 'crea un script que me de mi peso en diferentes planetas usando docker',
      metadata: { source: 'playground' },
    }));
    await service.run(ORG, TASK);
    expect(forge.forge).toHaveBeenCalledWith(
      ORG,
      TASK,
      expect.stringContaining('crea un script que me de mi peso en diferentes planetas usando docker'),
      expect.any(Function),
    );
    expect(agentLoop.run).not.toHaveBeenCalled();
    expect(modelRouter.generate).not.toHaveBeenCalled();
  });

  it('attaches an image from the bucket when the order asks for one', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'busca el clima y muéstrame una imagen' }));
    media.wantsImage.mockReturnValue(true);

    await service.run(ORG, TASK);

    expect(media.sendImage).toHaveBeenCalledWith(ORG, TASK, expect.stringContaining('imagen'));
    expect(publishedLogs().some((message) => message.includes('eva-media'))).toBe(true);
  });

  it('generates media directly for pure image requests instead of answering with text imagination', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'crea una imagen de un gato conduciendo' }));
    media.wantsImage.mockReturnValue(true);

    await service.run(ORG, TASK);

    expect(intentRouter.classify).not.toHaveBeenCalled();
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(media.sendImage).toHaveBeenCalledWith(ORG, TASK, 'crea una imagen de un gato conduciendo');
    const resultEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    expect((resultEvent!.payload as { text: string; model: string }).model).toBe('media:image');
    expect((resultEvent!.payload as { text: string }).text).toContain('https://bucket/eva-media/img.svg');
    expect(publishedLogs().some((message) => message.includes('image generation'))).toBe(true);
  });

  it('parks sensitive orders at the approval gate without executing', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'compra el dominio eva.dev' }));
    intentRouter.classify.mockResolvedValue({
      intent: 'core_path_approval', confidence: 0.95, classifier: 'rule', reasons: ['purchase keyword'],
    } as never);

    await service.run(ORG, TASK);

    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval');
    expect(modelRouter.generate).not.toHaveBeenCalled();
    const says = events.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'task.say')
      .map((event) => (event.payload as { text: string }).text);
    expect(says.some((text) => text.includes('aprobación'))).toBe(true);
  });

  it('marks the task failed and logs the error when the model call blows up', async () => {
    modelRouter.generate.mockRejectedValue(new Error('provider down'));
    tasks.getTask
      .mockResolvedValueOnce(makeTask({ description: 'resume este texto' })) // run() initial read
      .mockResolvedValueOnce(makeTask({ status: 'running' }))  // failSafely current
      .mockResolvedValueOnce(makeTask({ status: 'running' })); // failSafely refreshed

    await service.run(ORG, TASK);

    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'failed', expect.objectContaining({ error: 'provider down', result: expect.objectContaining({ model: 'failure-options' }) }));
    expect(publishedLogs().some((message) => message.includes('ERROR: provider down'))).toBe(true);
    // El usuario nunca recibe silencio ni un "no se pudo" a secas: la falla
    // llega como task.result con opciones de solución (visible en todos los canales).
    const failureResult = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    expect(failureResult).toBeDefined();
    const payload = failureResult!.payload as { text: string; model: string };
    expect(payload.model).toBe('failure-options');
    expect(payload.text).toContain('provider down');
    expect(payload.text).toContain('Esto es lo que puedo hacer ahora mismo');
    expect(payload.text).toContain('reintenta');
  });

  it('rejects useless model answers and recovers with available tools', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'resume este texto sobre OpenAI',
    }));
    modelRouter.generate
      .mockResolvedValueOnce({
      text: 'Como modelo no tengo acceso a informacion en tiempo real. Consulta un sitio externo.',
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          query: 'OpenAI latest news current status',
          intent: 'news',
          source_hint: 'chromium',
          reason: 'La solicitud pide estado actual y requiere fuentes recientes.',
        }),
        model: 'gpt-4o-mini',
        backend: 'openai',
        usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
      });

    await service.run(ORG, TASK);

    expect(research.answer).toHaveBeenCalledWith('OpenAI latest news current status', ORG);
    expect(publishedLogs().some((message) => message.includes('model answer rejected as non-actionable'))).toBe(true);
    expect(publishedLogs().some((message) => message.includes('research-plan: query="OpenAI latest news current status"'))).toBe(true);
    expect(publishedLogs().some((message) => message.includes('recovery tool chromium:duckduckgo'))).toBe(true);
    const resultEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    expect((resultEvent!.payload as { text: string }).text).toContain('Resultado encontrado');
  });

  it('does not publish the useless model answer when all recovery tools fail', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'resume este texto sobre OpenAI',
    }));
    modelRouter.generate
      .mockResolvedValueOnce({
      text: 'Como modelo no tengo acceso a informacion en tiempo real. Consulta un sitio externo.',
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          query: 'OpenAI current status latest updates',
          intent: 'news',
          source_hint: 'chromium',
          reason: 'Necesita buscar informacion actual.',
        }),
        model: 'gpt-4o-mini',
        backend: 'openai',
        usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
      });
    research.answer.mockRejectedValue(new Error('browser unavailable'));

    await service.run(ORG, TASK);

    const resultEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.result');
    const text = (resultEvent!.payload as { text: string }).text;
    expect(text).toContain('No voy a cerrar esta tarea con una respuesta genérica');
    expect(text).toContain('browser unavailable');
    expect(text).not.toContain('Como modelo no tengo acceso');
  });

  it('requests a renderable form when a tool needs missing personal context', async () => {
    modelRouter.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        query: 'clima de ayer en la ubicacion actual',
        intent: 'weather',
        source_hint: 'public_api',
        reason: 'Necesita ubicacion actual del usuario.',
      }),
      model: 'gpt-4o-mini',
      backend: 'openai',
      usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
    });
    research.answer.mockRejectedValue(new MissingInformationError(
      'Necesito tu ubicacion actual para consultar el clima.',
      {
        form_key: 'personal_profile.location',
        title: 'Falta tu ubicacion',
        description: 'Guarda tu ubicacion actual.',
        fields: [{ id: 'current_location', type: 'text', label: 'Ubicacion actual', required: true }],
      },
    ));

    await service.run(ORG, TASK);

    const formEvent = events.publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'task.form_request');
    expect(formEvent).toEqual(expect.objectContaining({
      orgId: ORG,
      taskId: TASK,
      payload: expect.objectContaining({
        message: 'Necesito tu ubicacion actual para consultar el clima.',
        form: expect.objectContaining({ form_key: 'personal_profile.location' }),
      }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_input');
    expect(publishedTypes()).not.toContain('task.failed');
  });

  it('ignores tasks that are no longer pending', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ status: 'completed' }));
    await service.run(ORG, TASK);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('routes email requests to Gmail API — never to web search', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'puedes ver mi ultimo correo electrónico' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.fetchLatest.mockResolvedValue({ ok: true, text: '📬 Últimos 3 correos en tu bandeja:\n\n1. **Factura digital** ...' });

    await service.run(ORG, TASK);

    // "mi ultimo correo" → single → limit=1
    expect(gmail.fetchLatest).toHaveBeenCalledWith(ORG, 1);
    expect(research.answer).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('bandeja') }));
  });

  it('routes calendar requests to local schedule — never to web search', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: '¿qué tengo en mi agenda hoy?' }));
    const schedule = module.get(ScheduleService) as jest.Mocked<ScheduleService>;
    schedule.formatUpcomingForSoul.mockResolvedValue('- Hoy 09:00: Reunión de equipo');

    await service.run(ORG, TASK);

    expect(schedule.formatUpcomingForSoul).toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();
  });

  it('delivers a clear error message when Gmail token is expired — never web search', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'revisa mi correo' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    // "revisa mi correo" has no specific sender → fetchLatest path, default limit=3
    gmail.fetchLatest.mockResolvedValue({ ok: false, reason: 'token_error', error: 'Token has been expired or revoked.' });

    await service.run(ORG, TASK);

    // Never web-searched
    expect(research.answer).not.toHaveBeenCalled();
    // Delivered a message explaining the token problem
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('Refresh Token') }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('delivers a setup prompt when Gmail is not configured — never web search', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'puedes ver mi correo' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.fetchLatest.mockResolvedValue({ ok: false, reason: 'no_credential' });

    await service.run(ORG, TASK);

    expect(research.answer).not.toHaveBeenCalled();
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('Integraciones') }));
  });

  it('routes sender-specific email search through fetchSearchWithFallback', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'puedes buscar el ultimo correo que me envio santander?' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.fetchSearchWithFallback.mockResolvedValue({ ok: true, text: '📬 Resultados para _from:santander_:\n\n1. **Tu estado de cuenta**' });

    await service.run(ORG, TASK);

    expect(gmail.fetchSearchWithFallback).toHaveBeenCalledWith(ORG, 'from:santander');
    expect(gmail.fetchLatest).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('santander') }));
  });

  it('delivers a clear "not found" message when Gmail search returns no results in any stage', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'busca correo de santander' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.fetchSearchWithFallback.mockResolvedValue({ ok: false, reason: 'empty' });

    await service.run(ORG, TASK);

    expect(research.answer).not.toHaveBeenCalled();
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('No encontré') }));
  });

  it('annotates results found in older emails (fallback stage)', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'busca correo de netflix' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.fetchSearchWithFallback.mockResolvedValue({
      ok: true,
      text: '📬 No encontré en los últimos 3 meses, pero sí en correos más antiguos:\n\n1. **Tu recibo de Netflix**',
    });

    await service.run(ORG, TASK);

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      text: expect.stringContaining('más antiguos'),
    }));
  });

  it('routes Drive requests to Drive API — never to web search or Gmail', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'que archivos tengo en drive muy pesados' }));
    const driveService = module.get(GoogleDriveService) as jest.Mocked<GoogleDriveService>;
    driveService.fetchForQuery.mockResolvedValue({ ok: true, text: '📂 Archivos más pesados en tu Drive:\n\n1. **video.mp4** — 2.3 GB' });
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;

    await service.run(ORG, TASK);

    expect(driveService.fetchForQuery).toHaveBeenCalledWith(ORG, 'que archivos tengo en drive muy pesados');
    expect(gmail.fetchLatest).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('Drive') }));
  });

  it('routes folder listing to Drive API — never to Gmail or web search', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'que carpetas tengo en drive?' }));
    const driveService = module.get(GoogleDriveService) as jest.Mocked<GoogleDriveService>;
    driveService.fetchForQuery.mockResolvedValue({ ok: true, text: '📂 Tus carpetas en Drive:\n\n1. 📁 **Proyectos**' });
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;

    await service.run(ORG, TASK);

    expect(driveService.fetchForQuery).toHaveBeenCalled();
    expect(gmail.fetchLatest).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('carpetas') }));
  });

  it('delivers a clear Drive error when credential is missing — never web search', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'mis archivos de drive' }));
    const driveService = module.get(GoogleDriveService) as jest.Mocked<GoogleDriveService>;
    driveService.fetchForQuery.mockResolvedValue({ ok: false, reason: 'no_credential' });

    await service.run(ORG, TASK);

    expect(research.answer).not.toHaveBeenCalled();
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('Integraciones') }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('does not route Drive request to Gmail even when conversation history contains "correo"', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'que carpetas tengo en drive?',
      metadata: {
        source: 'playground',
        conversation_context: [
          { role: 'user', text: 'puedes ver mi ultimo correo electrónico' },
          { role: 'assistant', text: '📬 Últimos 3 correos en tu bandeja...' },
        ],
      },
    }));
    const driveService = module.get(GoogleDriveService) as jest.Mocked<GoogleDriveService>;
    driveService.fetchForQuery.mockResolvedValue({ ok: true, text: '📂 Tus carpetas en Drive:\n\n1. 📁 **Docs**' });
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;

    await service.run(ORG, TASK);

    // Must use Drive, not Gmail (history contamination guard)
    expect(driveService.fetchForQuery).toHaveBeenCalled();
    expect(gmail.fetchLatest).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();
  });

  it('routes Uber price estimates through Uber Web with screenshot, never model or research', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'cuanto cuesta un Uber de Roma Norte a Aeropuerto?',
    }));
    const uber = module.get(UberWebService) as jest.Mocked<UberWebService>;

    await service.run(ORG, TASK);

    expect(uber.estimateRide).toHaveBeenCalledWith(ORG, {
      origin: 'Roma Norte',
      destination: 'Aeropuerto',
      taskId: TASK,
    });
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();

    const media = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.media');
    expect(media?.payload).toEqual(expect.objectContaining({
      kind: 'image',
      url: 'https://bucket/eva-media/screenshot.png',
      label: 'Uber Web',
    }));
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      model: 'uber-web',
      text: expect.stringContaining('UberX'),
    }));
  });

  it('routes Uber quote requests even with typos like "vieaje"', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'busca el costo de el vieaje de metro puebla a el zocalo',
    }));
    const uber = module.get(UberWebService) as jest.Mocked<UberWebService>;

    await service.run(ORG, TASK);

    expect(uber.estimateRide).toHaveBeenCalledWith(ORG, {
      origin: 'metro puebla',
      destination: 'zocalo',
      taskId: TASK,
    });
  });

  it('routes Uber quote requests from direct product selection URLs', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'estimar viaje (https://m.uber.com/go/product-selection?pickup=%7B%22addressLine1%22%3A%22calle%20uno%2031%22%7D&drop%5B0%5D=%7B%22addressLine1%22%3A%22Z%C3%B3calo%22%7D)',
    }));
    const uber = module.get(UberWebService) as jest.Mocked<UberWebService>;

    await service.run(ORG, TASK);

    expect(uber.estimateRide).toHaveBeenCalledWith(ORG, {
      origin: 'calle uno 31',
      destination: 'Zócalo',
      url: 'https://m.uber.com/go/product-selection?pickup=%7B%22addressLine1%22%3A%22calle%20uno%2031%22%7D&drop%5B0%5D=%7B%22addressLine1%22%3A%22Z%C3%B3calo%22%7D',
      taskId: TASK,
    });
  });

  it('routes Uber quote requests using conversation context when current turn is a pronoun/relative request', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'puedes validar ese viaje en uber',
      metadata: {
        conversation_context: [
          { role: 'user', text: 'busca el costo de el vieaje de metro puebla a el zocalo' },
          { role: 'assistant', text: 'Aquí tienes la cotización de Uber.' },
        ],
      },
    }));
    const uber = module.get(UberWebService) as jest.Mocked<UberWebService>;

    await service.run(ORG, TASK);

    expect(uber.estimateRide).toHaveBeenCalledWith(ORG, {
      origin: 'metro puebla',
      destination: 'zocalo',
      taskId: TASK,
    });
  });

  it('routes Uber quote requests with reverse destination-origin patterns and resolves "mi depa" from soul profile', async () => {
    soul.getPersonalProfile.mockResolvedValue({
      address: 'Calle Falsa 123, CDMX',
    });
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'Costo de un viaje de Uber a el zócalo de CDMX desde mi depa?',
    }));
    const uber = module.get(UberWebService) as jest.Mocked<UberWebService>;

    await service.run(ORG, TASK);

    expect(uber.estimateRide).toHaveBeenCalledWith(ORG, {
      origin: 'Calle Falsa 123, CDMX',
      destination: 'zócalo de CDMX',
      taskId: TASK,
    });
  });

  it('routes watsap latest-message requests to WhatsApp Web, never the model fallback', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'cual es el ultimo mensaje que tengo de watsap?' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.fetchLatestMessage).toHaveBeenCalledWith(ORG, TASK);
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      model: 'whatsapp-web',
      text: expect.stringContaining('Ana'),
    }));
  });

  it('routes WhatsApp unread-message requests to the unread extractor', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'que mensajes tengo sin leer en WhatsApp?' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.fetchUnreadMessages).toHaveBeenCalledWith(ORG, TASK);
    expect(whatsapp.fetchLatestMessage).not.toHaveBeenCalled();
    expect(modelRouter.generate).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      model: 'whatsapp-web',
      text: expect.stringContaining('sin leer'),
    }));
  });

  it('routes WhatsApp unanswered-message requests to response-status instead of send approval', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'que mensajes tengo sin responder en WhatsApp?' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(whatsapp.fetchUnansweredMessages).toHaveBeenCalledWith(ORG, TASK);
    expect(whatsapp.startSession).not.toHaveBeenCalled();
    expect(approvals.requestForPreparedAction).not.toHaveBeenCalled();
    expect(modelRouter.generate).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      model: 'whatsapp-web',
      text: expect.stringContaining('sin responder'),
    }));
  });

  it('routes WhatsApp contact-specific message requests to fetchContactMessages', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'Muéstrame los mensajes de Michael Sec de WhatsApp' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.fetchContactMessages).toHaveBeenCalledWith(ORG, 'Michael Sec', TASK);
    expect(whatsapp.fetchLatestMessage).not.toHaveBeenCalled();
    expect(modelRouter.generate).not.toHaveBeenCalled();

    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      model: 'whatsapp-web',
      text: expect.stringContaining('Michael Sec'),
    }));
  });

  it('sends a WhatsApp Web screenshot when the user asks for a captura', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'puedes darme una captura de mi whatsap' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.captureSessionScreenshot).toHaveBeenCalledWith(ORG, TASK);
    expect(modelRouter.generate).not.toHaveBeenCalled();

    const media = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.media');
    expect(media?.payload).toEqual(expect.objectContaining({
      kind: 'image',
      url: 'https://bucket/eva-media/screenshot.png',
      label: 'WhatsApp Web',
    }));
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({
      model: 'whatsapp-web',
      text: expect.stringContaining('captura'),
    }));
  });

  it('treats misspelled screenshot requests for conversations as WhatsApp screenshots', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'quiero que me envies una svcreshoot de mis conversaciones' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.captureSessionScreenshot).toHaveBeenCalledWith(ORG, TASK);
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();
  });

  it('uses recent screenshot context when the user follows up with "de whatsapp"', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'de whatsapp',
      metadata: {
        conversation_context: [
          { role: 'user', text: 'quiero que me envies una svcreshoot de mis conversaciones' },
          { role: 'assistant', text: '¿De qué conversaciones hablas?' },
        ],
      },
    }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.captureSessionScreenshot).toHaveBeenCalledWith(ORG, TASK);
    expect(modelRouter.generate).not.toHaveBeenCalled();
  });

  it('publishes the WhatsApp QR screenshot when the browser profile is not linked', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'revisa mi whatsap' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;
    whatsapp.fetchLatestMessage.mockResolvedValueOnce({
      ok: false,
      reason: 'qr_required',
      session: {
        session_id: 'browser-session-1',
        state: 'qr_required',
        current_url: 'https://web.whatsapp.com/',
        screenshot: {
          id: 'shot-1',
          org_id: ORG,
          session_id: 'browser-session-1',
          task_id: TASK,
          image_base64: 'iVBORw0KGgo=',
          mime_type: 'image/png',
          created_at: new Date().toISOString(),
        },
      },
      text: 'Abrí WhatsApp Web, pero falta vincular la sesión.',
    });

    await service.run(ORG, TASK);

    const media = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.media');
    expect(media?.payload).toEqual(expect.objectContaining({
      kind: 'image',
      url: 'https://bucket/eva-media/screenshot.png',
      label: 'WhatsApp Web QR',
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('prepares WhatsApp replies through Approval Engine instead of sending directly', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'responde por watsap a Ana que voy en camino',
    }));
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.startSession).toHaveBeenCalledWith(ORG, TASK);
    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      taskId: TASK,
      actionType: 'whatsapp.message.send',
      source: 'browser',
      payload: expect.objectContaining({
        contact: 'Ana',
        text: 'voy en camino',
      }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval', expect.anything());
  });

  it('correctly cleans WhatsApp contact names and strips trailing instructions', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'muestrame el chat de jair Monr en whatsapp y dime el ultimo mensaje que se envio' }));
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    await service.run(ORG, TASK);

    expect(whatsapp.fetchContactMessages).toHaveBeenCalledWith(ORG, 'jair Monr', TASK);
  });

  it('correctly extracts and cleans contact from message reply drafts with trailing actions', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'responde por watsap a jair Monr y dile que llegue bien',
    }));
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        contact: 'jair Monr',
        text: 'llegue bien',
      }),
    }));
  });

  it('correctly extracts drafts with suffix verbs and diciendo conjunctions', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'mandale mensaje por whatsap a joce diciendo hola fea',
    }));
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        contact: 'joce',
        text: 'hola fea',
      }),
    }));
  });

  it('correctly resolves implicit drafting using active session contact fallback', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'mandale un hola',
    }));
    (service as any).activeToolSessions.set(`${ORG}:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`, {
      tool: 'whatsapp',
      details: { contact: 'Jair Monr' },
      updatedAt: Date.now(),
    });
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        contact: 'Jair Monr',
        text: 'hola',
      }),
    }));
  });

  // ── Gmail write operations ────────────────────────────────────────────────

  it('rejects bulk email operations immediately without creating approvals', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'borra todos mis correos de spam' }));
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).not.toHaveBeenCalled();
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('masivas') }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('creates a gmail.send approval and parks task when asked to send an email', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'envía un correo a test@example.com diciendo que la reunión es el jueves',
    }));
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      taskId: TASK,
      actionType: 'gmail.send',
      payload: expect.objectContaining({ to: 'test@example.com' }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval', expect.anything());
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();
  });

  it('creates a gmail.trash approval after finding the message and parks task', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'borra el correo de santander',
    }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.findMessages.mockResolvedValue([{
      id: 'msg-abc',
      threadId: 'thread-abc',
      from: 'Santander <no-reply@santander.com>',
      subject: 'Tu estado de cuenta',
      date: new Date().toISOString(),
      snippet: 'Tu estado de cuenta está listo',
    }]);
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(gmail.findMessages).toHaveBeenCalledWith(ORG, 'from:santander', 1);
    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      actionType: 'gmail.trash',
      payload: expect.objectContaining({ message_id: 'msg-abc' }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval', expect.anything());
    expect(modelRouter.generate).not.toHaveBeenCalled();
  });

  it('delivers "not found" when trash target message does not exist in Gmail', async () => {
    tasks.getTask.mockResolvedValue(makeTask({ description: 'borra el correo de bancomer' }));
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;
    gmail.findMessages.mockResolvedValue([]);
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).not.toHaveBeenCalled();
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('No encontré') }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('creates a calendar.create approval and parks task when asked to create an event', async () => {
    tasks.getTask.mockResolvedValue(makeTask({
      created_by: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      description: 'agenda una reunión con Ana mañana a las 10am',
    }));
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;

    await service.run(ORG, TASK);

    expect(approvals.requestForPreparedAction).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      actionType: 'calendar.create',
      payload: expect.objectContaining({ summary: expect.stringContaining('Ana') }),
    }));
    expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'waiting_for_approval', expect.anything());
    expect(modelRouter.generate).not.toHaveBeenCalled();
    expect(research.answer).not.toHaveBeenCalled();
  });

  it('executes gmail.send after approval.resolved and delivers result', async () => {
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;
    const gmail = module.get(GmailService) as jest.Mocked<GmailService>;

    approvals.consumeApproved.mockResolvedValue({
      id: 'approval-1',
      org_id: ORG,
      task_id: TASK,
      action_type: 'gmail.send',
      action_hash: 'a'.repeat(64),
      nonce: 'n1',
      status: 'approved',
      level: 1,
      payload: { to: 'test@example.com', subject: 'Hola', body: 'La reunión es el jueves.' },
      summary: null,
      screenshot_ref: null,
      source: 'core_path',
      requested_by: 'user-1',
      reviewed_by: 'user-1',
      reviewed_by_2: null,
      reviewed_at: new Date().toISOString(),
      nonce_used_at: null,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never);
    gmail.sendEmail.mockResolvedValue({ ok: true, messageId: 'sent-1', threadId: 'thread-1' });

    tasks.getTask.mockResolvedValue(makeTask({ status: 'waiting_for_approval' }));

    // Simulate approval.resolved event by finding and calling the registered handler
    service.onApplicationBootstrap();
    const onCalls = (events.on as jest.Mock).mock.calls as [string, (event: unknown) => Promise<void>][];
    const resolvedHandler = onCalls.find(([type]) => type === 'approval.resolved')![1];
    await resolvedHandler({ type: 'approval.resolved', orgId: ORG, taskId: TASK, payload: { approvalId: 'approval-1', status: 'approved' }, ts: Date.now() });

    expect(approvals.consumeApproved).toHaveBeenCalledWith('approval-1', ORG);
    expect(gmail.sendEmail).toHaveBeenCalledWith(ORG, 'test@example.com', 'Hola', 'La reunión es el jueves.');
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('Correo enviado') }));
  });

  it('releases the task sandbox workspace after the agent loop finishes', async () => {
    const sandbox = module.get(SandboxService) as jest.Mocked<SandboxService>;
    tasks.getTask.mockResolvedValue(makeTask({
      description: 'automatiza un reporte diario de ventas con gráficos y envíalo',
    }));
    agentLoop.run.mockResolvedValue({
      ok: true, text: 'Listo.', steps: [], tokensUsed: 10, toolsUsed: ['code_execute'],
    });

    await service.run(ORG, TASK);

    expect(agentLoop.run).toHaveBeenCalledWith(ORG, TASK, expect.any(String), expect.objectContaining({
      userId: 'user-1',
    }));
    expect(sandbox.release).toHaveBeenCalledWith(TASK);
  });

  it('executes approved sandbox.network_exec runs with network and publishes the result', async () => {
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;
    const sandbox = module.get(SandboxService) as jest.Mocked<SandboxService>;

    approvals.consumeApproved.mockResolvedValue({
      id: 'approval-2',
      org_id: ORG,
      task_id: TASK,
      action_type: 'sandbox.network_exec',
      action_hash: 'b'.repeat(64),
      nonce: 'n2',
      status: 'approved',
      level: 1,
      payload: { language: 'python', code: 'import requests; print("ok")' },
      summary: null,
      screenshot_ref: null,
      source: 'core_path',
      requested_by: 'user-1',
      reviewed_by: 'user-1',
      reviewed_by_2: null,
      reviewed_at: new Date().toISOString(),
      nonce_used_at: null,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never);
    // La tarea ya cerró (el loop entregó y dejó la ejecución pendiente)
    tasks.getTask.mockResolvedValue(makeTask({ status: 'completed' }));

    service.onApplicationBootstrap();
    const onCalls = (events.on as jest.Mock).mock.calls as [string, (event: unknown) => Promise<void>][];
    const resolvedHandler = onCalls.find(([type]) => type === 'approval.resolved')![1];
    await resolvedHandler({ type: 'approval.resolved', orgId: ORG, taskId: TASK, payload: { approvalId: 'approval-2', status: 'approved' }, ts: Date.now() });

    expect(sandbox.runOneShot).toHaveBeenCalledWith({
      language: 'python', code: 'import requests; print("ok")', orgId: ORG, network: true,
    });
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('net ok') }));
    // Tarea ya terminal → no se fuerza otra transición a completed
    expect(tasks.transition).not.toHaveBeenCalledWith(TASK, ORG, 'completed', expect.anything());
  });

  it('executes whatsapp.message.send after approval.resolved and delivers result', async () => {
    const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;
    const whatsapp = module.get(WhatsAppWebService) as jest.Mocked<WhatsAppWebService>;

    approvals.consumeApproved.mockResolvedValue({
      id: 'approval-3',
      org_id: ORG,
      task_id: TASK,
      action_type: 'whatsapp.message.send',
      action_hash: 'c'.repeat(64),
      nonce: 'n3',
      status: 'approved',
      level: 1,
      payload: { contact: 'Michael Sec', text: 'Hola' },
      summary: null,
      screenshot_ref: null,
      source: 'core_path',
      requested_by: 'user-1',
      reviewed_by: 'user-1',
      reviewed_by_2: null,
      nonce_used_at: null,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never);

    whatsapp.sendMessage.mockResolvedValue({
      ok: true,
      session: {
        session_id: 'session-1',
        state: 'logged_in',
        current_url: 'https://web.whatsapp.com/',
        screenshot: {
          id: 'shot-1',
          org_id: ORG,
          session_id: 'session-1',
          task_id: TASK,
          image_base64: 'iVBORw0KGgo=',
          mime_type: 'image/png',
          created_at: new Date().toISOString(),
        },
      },
      text: '✅ Mensaje enviado con éxito a **Michael Sec**: "Hola"',
    });

    tasks.getTask.mockResolvedValue(makeTask({ status: 'waiting_for_approval' }));

    service.onApplicationBootstrap();
    const onCalls = (events.on as jest.Mock).mock.calls as [string, (event: unknown) => Promise<void>][];
    const resolvedHandler = onCalls.find(([type]) => type === 'approval.resolved')![1];
    await resolvedHandler({ type: 'approval.resolved', orgId: ORG, taskId: TASK, payload: { approvalId: 'approval-3', status: 'approved' }, ts: Date.now() });

    expect(approvals.consumeApproved).toHaveBeenCalledWith('approval-3', ORG);
    expect(whatsapp.sendMessage).toHaveBeenCalledWith(ORG, 'Michael Sec', 'Hola', TASK);
    const result = events.publish.mock.calls.map(([e]) => e).find(e => e.type === 'task.result');
    expect(result?.payload).toEqual(expect.objectContaining({ text: expect.stringContaining('Mensaje enviado con éxito') }));
  });

  describe('Compressing Memory & Active Tool routing context', () => {
    it('queries DB for history and compresses turns based on distance from newest', async () => {
      const mockTasks = Array.from({ length: 35 }, (_, i) => ({
        id: `task-${i}`,
        title: `User prompt ${i}`,
        description: `User description ${i}`,
        result: { text: `Assistant reply ${i}` },
        created_at: new Date(Date.now() - i * 60000).toISOString(),
      }));

      db.admin.limit.mockResolvedValueOnce({ data: mockTasks, error: null });

      const conversationContext = await (service as any).getConversationContext(makeTask({ id: 'current-task-id' }));

      expect(conversationContext.length).toBe(30);

      expect(conversationContext[29].text).toBe('Assistant reply 0');
      expect(conversationContext[29].text.includes('[resumido]')).toBe(false);

      const longMockTasks = Array.from({ length: 20 }, (_, i) => ({
        id: `task-${i}`,
        title: `User prompt ${i}`,
        description: 'a'.repeat(1500),
        result: { text: 'b'.repeat(1500) },
        created_at: new Date(Date.now() - i * 60000).toISOString(),
      }));
      db.admin.limit.mockResolvedValueOnce({ data: longMockTasks, error: null });

      const compressedContext = await (service as any).getConversationContext(makeTask({ id: 'current-task-id' }));

      expect(compressedContext[compressedContext.length - 1].text.length).toBe(1200);

      expect(compressedContext[19].text.length).toBe(264);
      expect(compressedContext[19].text.endsWith('... [resumido]')).toBe(true);

      expect(compressedContext[9].text.length).toBe(96);
      expect(compressedContext[9].text.endsWith('... [comprimido]')).toBe(true);
    });

    it('routes WhatsApp follow-ups correctly when in WhatsApp context', async () => {
      (service as any).updateActiveToolSession(ORG, 'user-1', 'whatsapp', { contact: 'Jair Monr' });

      tasks.getTask.mockResolvedValueOnce(makeTask({ description: 'si abre ese' }));
      db.admin.limit.mockResolvedValueOnce({ data: [], error: null });
      intentRouter.classify.mockResolvedValueOnce({ intent: 'fast_path', confidence: 0.9, classifier: 'rules', reasons: [] });

      const mockSession = {
        session_id: 'wa-session-1',
        state: 'logged_in',
        current_url: 'https://web.whatsapp.com/',
        screenshot: { image_base64: 'base64' },
      };
      (service as any).whatsapp.startSession = jest.fn().mockResolvedValue(mockSession);
      (service as any).whatsapp.fetchContactMessages = jest.fn().mockResolvedValue({
        ok: true,
        session: mockSession,
        contact: 'Jair Monr',
        text: 'Hola Jair',
      });

      await service.run(ORG, TASK);

      expect((service as any).whatsapp.fetchContactMessages).toHaveBeenCalledWith(ORG, 'Jair Monr', TASK);
    });

    it('approves a pending task when the user replies with a confirmation word', async () => {
      const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;
      tasks.getTask.mockResolvedValueOnce(makeTask({ description: 'sí' }));

      const mockWaitingTask = makeTask({ id: 'waiting-task-id', status: 'waiting_for_approval' });
      db.admin.limit.mockResolvedValueOnce({ data: [mockWaitingTask], error: null });

      const mockApproval = { id: 'app-123', status: 'pending', task_id: 'waiting-task-id' };
      db.admin.limit.mockResolvedValueOnce({ data: [mockApproval], error: null });

      await service.run(ORG, TASK);

      expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'planning');
      expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'running');
      expect(approvals.approve).toHaveBeenCalledWith('app-123', ORG, 'user-1');
    });

    it('rejects a pending task and cancels it when the user replies with a cancellation word', async () => {
      const approvals = module.get(ApprovalsService) as jest.Mocked<ApprovalsService>;
      tasks.getTask.mockResolvedValueOnce(makeTask({ description: 'no' }));

      const mockWaitingTask = makeTask({ id: 'waiting-task-id', status: 'waiting_for_approval' });
      db.admin.limit.mockResolvedValueOnce({ data: [mockWaitingTask], error: null });

      const mockApproval = { id: 'app-123', status: 'pending', task_id: 'waiting-task-id' };
      db.admin.limit.mockResolvedValueOnce({ data: [mockApproval], error: null });

      await service.run(ORG, TASK);

      expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'planning');
      expect(tasks.transition).toHaveBeenCalledWith(TASK, ORG, 'running');
      expect(approvals.reject).toHaveBeenCalledWith('app-123', ORG, 'user-1', expect.any(String));
      expect(tasks.transition).toHaveBeenCalledWith('waiting-task-id', ORG, 'cancelled', expect.any(Object));
    });
  });
});
