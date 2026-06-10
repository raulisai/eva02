import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventBusService } from '../events/event-bus.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { TasksService } from '../tasks/tasks.service';
import { Approval } from '../approvals/approval.types';
import { CommunicationRepository } from './communication.repository';
import { TelegramAdapter } from './telegram.adapter';
import {
  ChannelSendResult,
  CommunicationChannel,
  SendMessageInput,
  TelegramWebhookUpdate,
} from './communication.types';

@Injectable()
export class CommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    private readonly repo: CommunicationRepository,
    private readonly tasks: TasksService,
    private readonly events: EventBusService,
    private readonly telegram: TelegramAdapter,
    private readonly integrations: IntegrationsService,
  ) {}

  linkTelegramAccount(input: {
    orgId: string;
    userId: string;
    telegramUserId: string;
    chatId: string;
    displayName?: string | null;
  }) {
    return this.repo.linkAccount({
      orgId: input.orgId,
      userId: input.userId,
      channel: 'telegram',
      externalUserId: input.telegramUserId,
      externalChatId: input.chatId,
      displayName: input.displayName,
    });
  }

  async handleTelegramWebhook(orgId: string, secret: string | undefined, update: TelegramWebhookUpdate) {
    const settings = await this.integrations.getChannelSettings(orgId, 'telegram');

    if (!this.telegram.verifyWebhookSecret(secret, settings?.webhookSecret)) {
      throw new ForbiddenException('Invalid Telegram webhook secret');
    }
    if (settings && settings.status !== 'active') {
      throw new ForbiddenException('Telegram channel is disabled for this organization');
    }

    const message = update.message;
    const text = message?.text?.trim();
    const externalUserId = message?.from?.id ? String(message.from.id) : null;
    const chatId = message?.chat?.id ? String(message.chat.id) : null;

    if (!message || !text || !externalUserId || !chatId) {
      return { ok: true, ignored: true, reason: 'unsupported_telegram_update' };
    }

    // Allowlist: when configured, only these Telegram user IDs may talk to the bot.
    const allowed = this.allowedTelegramUserIds(settings?.config);
    if (allowed.length > 0 && !allowed.includes(externalUserId)) {
      this.logger.warn(`Rejected Telegram message from non-allowed user ${externalUserId} (org ${orgId})`);
      return { ok: false, ignored: true, reason: 'telegram_user_not_allowed' };
    }

    const account = await this.repo.findAccount({
      orgId,
      channel: 'telegram',
      externalUserId,
    });
    if (!account) {
      await this.repo.createNotification({
        orgId,
        channel: 'dashboard',
        notificationType: 'communication.telegram_unlinked',
        title: 'Unlinked Telegram message',
        body: text,
        target: { external_user_id: externalUserId, chat_id: chatId },
        status: 'skipped',
      });
      return { ok: false, ignored: true, reason: 'telegram_account_not_linked' };
    }

    const conversation = await this.repo.getOrCreateConversation({
      orgId,
      channel: 'telegram',
      externalConversationId: chatId,
      userId: account.user_id,
      metadata: { chat_type: message.chat.type },
    });
    await this.repo.createMessage({
      orgId,
      conversationId: conversation.id,
      userId: account.user_id,
      channel: 'telegram',
      direction: 'inbound',
      body: text,
      externalMessageId: String(message.message_id),
      payload: update as unknown as Record<string, unknown>,
    });

    const task = await this.tasks.createTask({
      title: this.titleFromTelegram(text),
      description: text,
      metadata: {
        source: 'telegram',
        conversation_id: conversation.id,
        external_chat_id: chatId,
        update_id: update.update_id,
      },
    }, account.user_id, orgId);

    await this.sendMessage({
      orgId,
      userId: account.user_id,
      channel: 'telegram',
      target: { chat_id: chatId },
      text: `Tarea creada: ${task.title}\nID: ${task.id}`,
      notificationType: 'task.created',
      payload: { task_id: task.id },
    });

    await this.events.publish({
      type: 'communication.message.received',
      orgId,
      taskId: task.id,
      payload: { channel: 'telegram', conversationId: conversation.id, taskId: task.id },
    });

    return { ok: true, task, conversation };
  }

  async sendMessage(input: SendMessageInput) {
    const result = await this.dispatch(input.orgId, input.channel, input.target, input.text);
    const status = this.statusFromResult(result);
    const notification = await this.repo.createNotification({
      orgId: input.orgId,
      userId: input.userId,
      channel: input.channel,
      notificationType: input.notificationType ?? 'message',
      title: input.notificationType ?? 'Message',
      body: input.text,
      target: input.target,
      payload: input.payload,
      status,
      error: result.error ?? null,
      sentAt: status === 'sent' ? new Date().toISOString() : null,
    });

    await this.repo.createMessage({
      orgId: input.orgId,
      userId: input.userId,
      channel: input.channel,
      direction: 'outbound',
      body: input.text,
      externalMessageId: result.externalMessageId ?? null,
      payload: { notification_id: notification.id, ...(input.payload ?? {}) },
    });

    await this.events.publish({
      type: status === 'failed' ? 'communication.send.failed' : 'communication.message.sent',
      orgId: input.orgId,
      payload: {
        channel: input.channel,
        notificationId: notification.id,
        status,
      },
    });

    return { notification, result };
  }

  async sendApprovalRequest(approval: Approval, orgId: string) {
    const text = [
      `Aprobacion requerida L${approval.level}: ${approval.action_type}`,
      approval.summary ? `Resumen: ${approval.summary}` : undefined,
      `Hash: ${approval.action_hash}`,
      `Expira: ${approval.expires_at}`,
      approval.screenshot_ref ? `Screenshot: ${approval.screenshot_ref}` : undefined,
    ].filter(Boolean).join('\n');

    const account = approval.requested_by
      ? await this.findPreferredTelegramAccount(orgId, approval.requested_by)
      : null;

    if (!account?.external_chat_id) {
      return this.sendMessage({
        orgId,
        userId: approval.requested_by,
        channel: 'dashboard',
        target: { route: '/approvals', approval_id: approval.id },
        text,
        notificationType: 'approval.requested',
        payload: { approval_id: approval.id },
      });
    }

    return this.sendMessage({
      orgId,
      userId: approval.requested_by,
      channel: 'telegram',
      target: { chat_id: account.external_chat_id },
      text,
      notificationType: 'approval.requested',
      payload: { approval_id: approval.id },
    });
  }

  findRecentNotifications(orgId: string, limit = 20) {
    return this.repo.findRecentNotifications(orgId, Math.min(limit, 100));
  }

  private async findPreferredTelegramAccount(orgId: string, userId: string) {
    const fallbackExternalUserId = process.env.TELEGRAM_DEFAULT_USER_ID;
    if (!fallbackExternalUserId) return null;
    const account = await this.repo.findAccount({
      orgId,
      channel: 'telegram',
      externalUserId: fallbackExternalUserId,
    });
    if (account && account.user_id !== userId) {
      this.logger.warn('TELEGRAM_DEFAULT_USER_ID belongs to a different user; using dashboard notification');
      return null;
    }
    return account;
  }

  private async dispatch(
    orgId: string,
    channel: CommunicationChannel,
    target: Record<string, unknown>,
    text: string,
  ): Promise<ChannelSendResult> {
    if (channel === 'telegram') {
      const settings = await this.integrations.getChannelSettings(orgId, 'telegram');
      if (settings && settings.status !== 'active') {
        return { ok: false, error: 'Telegram channel is disabled for this organization' };
      }
      return this.telegram.sendMessage(target, text, settings?.secret);
    }
    if (channel === 'dashboard') return { ok: true, skipped: true };
    return { ok: true, skipped: true };
  }

  private allowedTelegramUserIds(config?: Record<string, unknown>): string[] {
    const raw = config?.['allowed_user_ids'];
    if (Array.isArray(raw)) return raw.map(String).map((id) => id.trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map((id) => id.trim()).filter(Boolean);
    return [];
  }

  private statusFromResult(result: ChannelSendResult) {
    if (!result.ok) return 'failed' as const;
    if (result.skipped) return 'skipped' as const;
    return 'sent' as const;
  }

  private titleFromTelegram(text: string) {
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
}
