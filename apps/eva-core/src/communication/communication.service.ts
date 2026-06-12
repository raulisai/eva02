import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EvaEvent, EventBusService } from '../events/event-bus.service';
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
export class CommunicationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    private readonly repo: CommunicationRepository,
    private readonly tasks: TasksService,
    private readonly events: EventBusService,
    private readonly telegram: TelegramAdapter,
    private readonly integrations: IntegrationsService,
  ) {}

  onApplicationBootstrap() {
    if (typeof this.events.on !== 'function') return;

    // Forward completed task results back to the originating channel (Telegram) and to any
    // explicitly requested cross-channel target (e.g. user asked from Playground: "mándalo por telegram").
    this.events.on('task.result', async (event: EvaEvent) => {
      const { orgId, taskId, payload } = event;
      if (!taskId) return;
      const p = payload as Record<string, unknown>;
      // Pure image tasks are delivered via task.media (sendPhoto) — skip text here.
      if (p['model'] === 'media:image') return;
      const text = String(p['text'] ?? '');

      // 1. Same-channel reply (task originated from Telegram).
      await this.deliverToTelegram(orgId, taskId, text);

      // 2. Cross-channel delivery requested from Playground / wearOS.
      const crossTarget = p['cross_channel_target'] as string | undefined;
      const crossUserId = p['cross_channel_user_id'] as string | undefined;
      if (crossTarget && crossUserId && text) {
        await this.deliverCrossChannel(orgId, crossUserId, crossTarget as CommunicationChannel, text);
      }
    });

    // Forward generated images to Telegram as photos.
    this.events.on('task.media', async (event: EvaEvent) => {
      const { orgId, taskId, payload } = event;
      if (!taskId) return;
      const p = payload as Record<string, unknown>;
      if (p['kind'] !== 'image') return;
      const url = String(p['url'] ?? '');
      if (!url) return;
      await this.deliverPhotoToTelegram(orgId, taskId, url);
    });

    // Forward progress acks ("lo estoy ejecutando en segundo plano…") to the
    // originating channel, so Telegram users hear EVA immediately instead of
    // waiting in silence until the final result. The dashboard/wearOS already
    // receive task.say through the WebSocket events bridge.
    this.events.on('task.say', async (event: EvaEvent) => {
      const { orgId, taskId, payload } = event;
      if (!taskId) return;
      const text = String((payload as Record<string, unknown>)['text'] ?? '');
      await this.deliverToTelegram(orgId, taskId, text);
    });

    this.logger.log('CommunicationService subscribed to task.result, task.media and task.say');
  }

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
      // Tell the user their Telegram ID so they can link from the dashboard.
      if (settings?.secret && chatId) {
        await this.telegram.sendMessage(
          { chat_id: chatId },
          `👋 Hola! EVA recibió tu mensaje, pero tu cuenta de Telegram no está vinculada aún.\n\nTu *Telegram ID* es: \`${externalUserId}\`\n\nVe al dashboard de EVA → Integraciones → Telegram → *Vincular cuenta* e ingresa ese ID para empezar.`,
          settings.secret,
        );
      }
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

  /**
   * Returns which channels have an active integration for the org.
   * Used by the agent to tell the user which cross-channel targets are available.
   */
  async listActiveChannels(orgId: string): Promise<CommunicationChannel[]> {
    const active: CommunicationChannel[] = ['dashboard'];
    const telegram = await this.integrations.getChannelSettings(orgId, 'telegram');
    if (telegram?.status === 'active') active.push('telegram');
    return active;
  }

  /**
   * Deliver a message to a channel other than the one the task originated from.
   * Looks up the user's linked account on the target channel.
   * Returns ok=false with a human-readable reason if delivery can't proceed.
   */
  async deliverCrossChannel(
    orgId: string,
    userId: string,
    channel: CommunicationChannel,
    text: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      if (channel === 'telegram') {
        const settings = await this.integrations.getChannelSettings(orgId, 'telegram');
        if (!settings || settings.status !== 'active') {
          return { ok: false, reason: 'telegram_channel_inactive' };
        }
        // Try the user's own linked account first, then the org-wide fallback.
        let chatId: string | null = null;
        const userAccount = await this.repo.findAccountByUserId(orgId, userId, 'telegram');
        if (userAccount?.external_chat_id) {
          chatId = userAccount.external_chat_id;
        } else {
          // Fallback: env-var default account (for single-user orgs).
          const fallbackAccount = await this.findPreferredTelegramAccount(orgId, userId);
          chatId = fallbackAccount?.external_chat_id ?? null;
        }
        if (!chatId) {
          return { ok: false, reason: 'no_telegram_account_linked' };
        }
        const result = await this.telegram.sendMessage({ chat_id: chatId }, text, settings.secret);
        return result.ok ? { ok: true } : { ok: false, reason: result.error };
      }
      return { ok: false, reason: `channel_not_implemented:${channel}` };
    } catch (err) {
      this.logger.warn(`deliverCrossChannel(${channel}) failed: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    }
  }

  private async deliverToTelegram(orgId: string, taskId: string, text: string): Promise<void> {
    if (!text) return;
    try {
      const task = await this.tasks.getTask(taskId, orgId);
      const meta = task.metadata as Record<string, unknown>;
      if (meta['source'] !== 'telegram') return;
      const chatId = String(meta['external_chat_id'] ?? '');
      if (!chatId) return;

      const settings = await this.integrations.getChannelSettings(orgId, 'telegram');
      if (settings && settings.status !== 'active') return;

      const result = await this.telegram.sendMessage({ chat_id: chatId }, text, settings?.secret);
      if (!result.ok) {
        this.logger.warn(`deliverToTelegram failed for task ${taskId}: ${result.error ?? 'unknown Telegram error'}`);
      }
    } catch (err) {
      this.logger.warn(`deliverToTelegram failed for task ${taskId}: ${(err as Error).message}`);
    }
  }

  private async deliverPhotoToTelegram(orgId: string, taskId: string, photoUrl: string): Promise<void> {
    try {
      const task = await this.tasks.getTask(taskId, orgId);
      const meta = task.metadata as Record<string, unknown>;
      if (meta['source'] !== 'telegram') return;
      const chatId = String(meta['external_chat_id'] ?? '');
      if (!chatId) return;

      const settings = await this.integrations.getChannelSettings(orgId, 'telegram');
      if (settings && settings.status !== 'active') return;

      const result = await this.telegram.sendPhoto({ chat_id: chatId }, photoUrl, 'Imagen generada', settings?.secret);
      if (!result.ok) {
        this.logger.warn(`deliverPhotoToTelegram failed for task ${taskId}: ${result.error ?? 'unknown Telegram error'}`);
      }
    } catch (err) {
      this.logger.warn(`deliverPhotoToTelegram failed for task ${taskId}: ${(err as Error).message}`);
    }
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
