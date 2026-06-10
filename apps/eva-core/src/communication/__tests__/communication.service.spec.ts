import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventBusService } from '../../events/event-bus.service';
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
          } satisfies Partial<TasksService>,
        },
        {
          provide: EventBusService,
          useValue: { publish: jest.fn().mockResolvedValue('0-1') } satisfies Partial<EventBusService>,
        },
        {
          provide: TelegramAdapter,
          useValue: {
            verifyWebhookSecret: jest.fn().mockReturnValue(true),
            sendMessage: jest.fn().mockResolvedValue({ ok: true, externalMessageId: '200' }),
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

  it('creates a task from a linked Telegram webhook and sends an acknowledgement', async () => {
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
    expect(telegram.sendMessage).toHaveBeenCalledWith({ chat_id: '100' }, expect.stringContaining('Tarea creada'), undefined);
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
});
