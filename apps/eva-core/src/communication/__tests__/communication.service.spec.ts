import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EvaEvent, EventBusService } from '../../events/event-bus.service';
import { IntegrationsService } from '../../integrations/integrations.service';
import { TasksService } from '../../tasks/tasks.service';
import { CommunicationRepository } from '../communication.repository';
import { CommunicationService } from '../communication.service';
import { TelegramAdapter } from '../telegram.adapter';
import { CommunicationAccount, Conversation } from '../communication.types';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONV = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const now = new Date().toISOString();

const account: CommunicationAccount = {
  id: 'acc-1',
  org_id: ORG,
  user_id: USER,
  channel: 'telegram',
  external_user_id: '42',
  external_chat_id: '100',
  display_name: 'Eva User',
  status: 'active',
  created_at: now,
  updated_at: now,
};

const conversation: Conversation = {
  id: CONV,
  org_id: ORG,
  channel: 'telegram',
  external_conversation_id: '100',
  user_id: USER,
  status: 'open',
  metadata: {},
  created_at: now,
  updated_at: now,
};

const telegramTask = {
  id: TASK,
  org_id: ORG,
  title: 'Comprar leche',
  description: 'Comprar leche',
  status: 'completed' as const,
  metadata: {
    source: 'telegram',
    external_chat_id: '100',
    conversation_id: CONV,
  },
  result: null,
  error: null,
  created_by: USER,
  started_at: null,
  completed_at: null,
  created_at: now,
  updated_at: now,
};

describe('CommunicationService', () => {
  let service: CommunicationService;
  let repo: jest.Mocked<CommunicationRepository>;
  let tasks: jest.Mocked<TasksService>;
  let telegram: jest.Mocked<TelegramAdapter>;
  let events: jest.Mocked<EventBusService>;
  let integrations: jest.Mocked<IntegrationsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunicationService,
        {
          provide: CommunicationRepository,
          useValue: {
            linkAccount: jest.fn().mockResolvedValue(account),
            findAccount: jest.fn().mockResolvedValue(account),
            getOrCreateConversation: jest.fn().mockResolvedValue(conversation),
            createMessage: jest.fn().mockImplementation(async (input) => ({
              id: 'msg-1',
              org_id: input.orgId,
              conversation_id: input.conversationId ?? null,
              task_id: input.taskId ?? null,
              user_id: input.userId ?? null,
              channel: input.channel,
              direction: input.direction,
              message_type: input.messageType ?? 'text',
              body: input.body ?? null,
              external_message_id: input.externalMessageId ?? null,
              payload: input.payload ?? {},
              created_at: now,
            })),
            createNotification: jest.fn().mockImplementation(async (input) => ({
              id: 'notif-1',
              org_id: input.orgId,
              user_id: input.userId ?? null,
              channel: input.channel,
              notification_type: input.notificationType,
              title: input.title,
              body: input.body ?? null,
              status: input.status ?? 'pending',
              target: input.target ?? {},
              payload: input.payload ?? {},
              sent_at: input.sentAt ?? null,
              error: input.error ?? null,
              created_at: now,
            })),
            findRecentNotifications: jest.fn().mockResolvedValue([]),
          } satisfies Partial<CommunicationRepository>,
        },
        {
          provide: TasksService,
          useValue: {
            createTask: jest.fn().mockResolvedValue({ id: TASK, title: 'Comprar leche' }),
            getTask: jest.fn().mockResolvedValue(telegramTask),
          } satisfies Partial<TasksService>,
        },
        {
          provide: EventBusService,
          useValue: {
            publish: jest.fn().mockResolvedValue('0-1'),
            on: jest.fn(),
          } satisfies Partial<EventBusService>,
        },
        {
          provide: TelegramAdapter,
          useValue: {
            verifyWebhookSecret: jest.fn().mockReturnValue(true),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, externalMessageId: '200' }),
            sendPhoto: jest.fn().mockResolvedValue({ ok: true, externalMessageId: '201' }),
          } satisfies Partial<TelegramAdapter>,
        },
        {
          provide: IntegrationsService,
          useValue: {
            getChannelSettings: jest.fn().mockResolvedValue(null),
          } satisfies Partial<IntegrationsService>,
        },
      ],
    }).compile();

    service = module.get(CommunicationService);
    repo = module.get(CommunicationRepository);
    tasks = module.get(TasksService);
    telegram = module.get(TelegramAdapter);
    events = module.get(EventBusService);
    integrations = module.get(IntegrationsService);
  });

  it('creates a task from a linked Telegram webhook and publishes message.received event', async () => {
    const result = await service.handleTelegramWebhook(ORG, 'secret', {
      update_id: 1,
      message: {
        message_id: 10,
        text: 'Comprar leche',
        chat: { id: 100, type: 'private' },
        from: { id: 42, first_name: 'Eva' },
      },
    });

    expect(result.ok).toBe(true);
    expect(repo.findAccount).toHaveBeenCalledWith({
      orgId: ORG,
      channel: 'telegram',
      externalUserId: '42',
    });
    expect(tasks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Comprar leche',
      metadata: expect.objectContaining({ source: 'telegram', conversation_id: CONV }),
    }), USER, ORG);
    // No immediate "Recibido" ack — the agent delivers the real answer directly
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'communication.message.received', orgId: ORG }));
  });

  it('rejects Telegram webhooks with invalid secret', async () => {
    telegram.verifyWebhookSecret.mockReturnValue(false);

    await expect(service.handleTelegramWebhook(ORG, 'bad', {
      update_id: 1,
      message: {
        message_id: 10,
        text: 'Hola',
        chat: { id: 100, type: 'private' },
        from: { id: 42 },
      },
    })).rejects.toThrow(ForbiddenException);
  });

  it('sends a helpful Telegram message when the account is not linked yet', async () => {
    repo.findAccount.mockResolvedValue(null as unknown as typeof account);
    integrations.getChannelSettings.mockResolvedValue({
      status: 'active',
      config: {},
      secret: 'bot-token',
      webhookSecret: null,
    });

    const result = await service.handleTelegramWebhook(ORG, undefined, {
      update_id: 1,
      message: {
        message_id: 10,
        text: 'HI',
        chat: { id: 100, type: 'private' },
        from: { id: 42 },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'telegram_account_not_linked' });
    expect(tasks.createTask).not.toHaveBeenCalled();
    // Should still reply with instructions and Telegram ID
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      { chat_id: '100' },
      expect.stringContaining('42'),
      'bot-token',
    );
  });

  it('rejects Telegram messages from users outside the allowlist', async () => {
    integrations.getChannelSettings.mockResolvedValue({
      status: 'active',
      config: { allowed_user_ids: '11, 22' },
      secret: 'bot-token',
      webhookSecret: 'hook-secret',
    });

    const result = await service.handleTelegramWebhook(ORG, 'hook-secret', {
      update_id: 2,
      message: {
        message_id: 11,
        text: 'Hola',
        chat: { id: 100, type: 'private' },
        from: { id: 42 },
      },
    });

    expect(result).toMatchObject({ ok: false, ignored: true, reason: 'telegram_user_not_allowed' });
    expect(tasks.createTask).not.toHaveBeenCalled();
  });

  it('uses the per-org bot token when dispatching Telegram messages', async () => {
    integrations.getChannelSettings.mockResolvedValue({
      status: 'active',
      config: {},
      secret: 'org-bot-token',
      webhookSecret: null,
    });

    await service.sendMessage({
      orgId: ORG,
      userId: USER,
      channel: 'telegram',
      target: { chat_id: '100' },
      text: 'Hola',
    });

    expect(telegram.sendMessage).toHaveBeenCalledWith({ chat_id: '100' }, 'Hola', 'org-bot-token');
  });

  it('refuses to dispatch through a disabled channel', async () => {
    integrations.getChannelSettings.mockResolvedValue({
      status: 'disabled',
      config: {},
      secret: 'org-bot-token',
      webhookSecret: null,
    });

    const result = await service.sendMessage({
      orgId: ORG,
      userId: USER,
      channel: 'telegram',
      target: { chat_id: '100' },
      text: 'Hola',
    });

    expect(result.notification.status).toBe('failed');
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('records universal outbound messages as notifications and messages', async () => {
    const result = await service.sendMessage({
      orgId: ORG,
      userId: USER,
      channel: 'telegram',
      target: { chat_id: '100' },
      text: 'Estado actualizado',
      notificationType: 'status_update',
    });

    expect(result.notification.status).toBe('sent');
    expect(repo.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      channel: 'telegram',
      notificationType: 'status_update',
      status: 'sent',
    }));
    expect(repo.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      channel: 'telegram',
      direction: 'outbound',
      externalMessageId: '200',
    }));
  });

  describe('onApplicationBootstrap — Telegram response delivery', () => {
    let resultHandler: (event: EvaEvent) => Promise<void>;
    let mediaHandler: (event: EvaEvent) => Promise<void>;
    let sayHandler: (event: EvaEvent) => Promise<void>;

    beforeEach(() => {
      service.onApplicationBootstrap();
      const calls = (events.on as jest.Mock).mock.calls as [string, (e: EvaEvent) => Promise<void>][];
      resultHandler = calls.find(([type]) => type === 'task.result')![1];
      mediaHandler = calls.find(([type]) => type === 'task.media')![1];
      sayHandler = calls.find(([type]) => type === 'task.say')![1];
    });

    it('forwards task.result text to Telegram when task source is telegram', async () => {
      integrations.getChannelSettings.mockResolvedValue({
        status: 'active',
        config: {},
        secret: 'bot-token',
        webhookSecret: 'secret',
      });

      await resultHandler({
        type: 'task.result',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Tu bandeja tiene 5 correos', model: 'gpt-4o', latency_ms: 400 },
        ts: Date.now(),
      });

      expect(tasks.getTask).toHaveBeenCalledWith(TASK, ORG);
      expect(telegram.sendMessage).toHaveBeenCalledWith(
        { chat_id: '100' },
        'Tu bandeja tiene 5 correos',
        'bot-token',
      );
    });

    it('skips task.result forwarding when model is media:image (photo delivered separately)', async () => {
      integrations.getChannelSettings.mockResolvedValue({
        status: 'active',
        config: {},
        secret: 'bot-token',
        webhookSecret: 'secret',
      });

      await resultHandler({
        type: 'task.result',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Listo, generé la imagen: https://example.com/img.png', model: 'media:image', latency_ms: 800 },
        ts: Date.now(),
      });

      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('skips delivery when task source is not telegram', async () => {
      tasks.getTask.mockResolvedValue({
        ...telegramTask,
        metadata: { source: 'browser' },
      });

      await resultHandler({
        type: 'task.result',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Respuesta web', model: 'gpt-4o', latency_ms: 200 },
        ts: Date.now(),
      });

      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('skips delivery when Telegram channel is disabled', async () => {
      integrations.getChannelSettings.mockResolvedValue({
        status: 'disabled',
        config: {},
        secret: 'bot-token',
        webhookSecret: null,
      });

      await resultHandler({
        type: 'task.result',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Respuesta', model: 'gpt-4o', latency_ms: 200 },
        ts: Date.now(),
      });

      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('forwards task.media images to Telegram as photos', async () => {
      integrations.getChannelSettings.mockResolvedValue({
        status: 'active',
        config: {},
        secret: 'bot-token',
        webhookSecret: 'secret',
      });

      await mediaHandler({
        type: 'task.media',
        orgId: ORG,
        taskId: TASK,
        payload: { kind: 'image', url: 'https://storage.example.com/img.png', content_type: 'image/png' },
        ts: Date.now(),
      });

      expect(tasks.getTask).toHaveBeenCalledWith(TASK, ORG);
      expect(telegram.sendPhoto).toHaveBeenCalledWith(
        { chat_id: '100' },
        'https://storage.example.com/img.png',
        expect.any(String),
        'bot-token',
      );
    });

    it('ignores task.media events with kind != image', async () => {
      await mediaHandler({
        type: 'task.media',
        orgId: ORG,
        taskId: TASK,
        payload: { kind: 'audio', url: 'https://storage.example.com/audio.mp3', content_type: 'audio/mpeg' },
        ts: Date.now(),
      });

      expect(telegram.sendPhoto).not.toHaveBeenCalled();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('does not throw when task.result handler encounters a missing task', async () => {
      tasks.getTask.mockRejectedValue(new Error('not found'));

      await expect(resultHandler({
        type: 'task.result',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Respuesta', model: 'gpt-4o', latency_ms: 200 },
        ts: Date.now(),
      })).resolves.not.toThrow();
    });

    it('forwards task.say progress acks to Telegram so the user hears EVA immediately', async () => {
      integrations.getChannelSettings.mockResolvedValue({
        status: 'active',
        config: {},
        secret: 'bot-token',
        webhookSecret: 'secret',
      });

      await sayHandler({
        type: 'task.say',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Va para largo, así que ya lo estoy ejecutando en segundo plano 🛠️.' },
        ts: Date.now(),
      });

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        { chat_id: '100' },
        'Va para largo, así que ya lo estoy ejecutando en segundo plano 🛠️.',
        'bot-token',
      );
    });

    it('skips task.say forwarding when the task did not originate on Telegram', async () => {
      tasks.getTask.mockResolvedValue({
        ...telegramTask,
        metadata: { source: 'wearos' },
      });

      await sayHandler({
        type: 'task.say',
        orgId: ORG,
        taskId: TASK,
        payload: { text: 'Enseguida, ya estoy en ello ⚙️' },
        ts: Date.now(),
      });

      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('registers task.result, task.media and task.say handlers on bootstrap', () => {
      const calls = (events.on as jest.Mock).mock.calls as [string, unknown][];
      const types = calls.map(([type]) => type);
      expect(types).toContain('task.result');
      expect(types).toContain('task.media');
      expect(types).toContain('task.say');
    });
  });
});
