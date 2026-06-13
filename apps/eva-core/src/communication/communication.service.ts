import { ForbiddenException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EvaEvent, EventBusService } from '../events/event-bus.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { TasksService } from '../tasks/tasks.service';
import { Approval } from '../approvals/approval.types';
import { SkillLibraryService, UserFeedbackReaction } from '../agent/skill-library.service';
import { CommunicationRepository } from './communication.repository';
import { TelegramAdapter } from './telegram.adapter';
import {
  ChannelSendResult,
  CommunicationChannel,
  SendMessageInput,
  TelegramWebhookUpdate,
} from './communication.types';

const INBOUND_MEDIA_BUCKET = 'eva-media';
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

interface TelegramInboundAttachment {
  kind: 'image' | 'audio';
  fileId: string;
  fileName: string;
  contentType: string;
  url?: string;
  transcript?: string;
  error?: string;
}

@Injectable()
export class CommunicationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommunicationService.name);
  private inboundBucketReady = false;

  constructor(
    private readonly repo: CommunicationRepository,
    private readonly tasks: TasksService,
    private readonly events: EventBusService,
    private readonly telegram: TelegramAdapter,
    private readonly integrations: IntegrationsService,
    private readonly db: DatabaseService,
    private readonly skillLibrary: SkillLibraryService,
  ) {}

  onApplicationBootstrap() {
    if (typeof this.events.on !== 'function') return;

    // Forward completed task results back to the originating channel (Telegram, WearOS, Playground) and to any
    // explicitly requested cross-channel target (e.g. user asked from Playground: "mándalo por telegram").
    this.events.on('task.result', async (event: EvaEvent) => {
      const { orgId, taskId, payload } = event;
      if (!taskId) return;
      const p = payload as Record<string, unknown>;
      // Pure image tasks are delivered via task.media (sendPhoto) — skip text here.
      if (p['model'] === 'media:image') return;
      const text = String(p['text'] ?? '');

      // 1. Same-channel reply (task originated from Telegram / WearOS / Playground).
      await this.deliverToOriginatingChannel(orgId, taskId, text, true);

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
    // originating channel (Telegram / WearOS / Playground) so the user hears EVA immediately.
    this.events.on('task.say', async (event: EvaEvent) => {
      const { orgId, taskId, payload } = event;
      if (!taskId) return;
      const text = String((payload as Record<string, unknown>)['text'] ?? '');
      await this.deliverToOriginatingChannel(orgId, taskId, text, false);
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

    // ── Inline keyboard callback (approval tap) ──────────────────────────────
    if (update.callback_query) {
      return this.handleApprovalCallback(orgId, update.callback_query, settings?.secret);
    }

    const message = update.message;
    const text = this.telegramMessageText(message);
    const externalUserId = message?.from?.id ? String(message.from.id) : null;
    const chatId = message?.chat?.id ? String(message.chat.id) : null;

    if (!message || !externalUserId || !chatId) {
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
        body: text || this.telegramAttachmentFallbackText(message),
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

    const inbound = await this.buildTelegramInboundMessage(orgId, message, settings?.secret);
    if (!inbound.description) {
      return { ok: true, ignored: true, reason: 'unsupported_telegram_update' };
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
      messageType: inbound.messageType,
      body: inbound.description,
      externalMessageId: String(message.message_id),
      payload: {
        ...(update as unknown as Record<string, unknown>),
        eva_attachments: inbound.attachments,
      },
    });

    const inferredFeedback = this.inferUserFeedback(inbound.description);
    if (inferredFeedback) {
      const lastOutbound = await this.repo.findLatestOutboundTaskMessage({
        orgId,
        conversationId: conversation.id,
        channel: 'telegram',
      });
      if (lastOutbound?.task_id) {
        const result = await this.skillLibrary.recordUserFeedback(orgId, {
          taskId: lastOutbound.task_id,
          userId: account.user_id,
          reaction: inferredFeedback.reaction,
          rating: inferredFeedback.rating,
          comment: inbound.description,
        });
        await this.events.publish({
          type: 'agent.feedback.inferred',
          orgId,
          taskId: lastOutbound.task_id,
          payload: { channel: 'telegram', conversationId: conversation.id, ...result },
        });
        return { ok: true, feedback: result, conversation };
      }
    }

    const task = await this.tasks.createTask({
      title: this.titleFromTelegram(inbound.title),
      description: inbound.description,
      metadata: {
        source: 'telegram',
        conversation_id: conversation.id,
        external_chat_id: chatId,
        update_id: update.update_id,
        telegram_message_id: message.message_id,
        inbound_media: inbound.attachments,
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
    const description = this.describeApprovalAction(approval);
    const text = `🛡️ Necesito tu aprobación para: ${description}`;

    const account = approval.requested_by
      ? await this.findPreferredTelegramAccount(orgId, approval.requested_by)
      : null;

    if (!account?.external_chat_id) {
      return this.sendMessage({
        orgId,
        userId: approval.requested_by,
        channel: 'dashboard',
        target: { route: '/approvals', approval_id: approval.id },
        text: `${text}\n\nResponde "sí" para ejecutarlo o "no" para cancelar.`,
        notificationType: 'approval.requested',
        payload: { approval_id: approval.id },
      });
    }

    const settings = await this.integrations.getChannelSettings(orgId, 'telegram');
    await this.telegram.sendMessageWithInlineKeyboard(
      { chat_id: account.external_chat_id },
      text,
      [
        { text: '✅ Aprobar', callbackData: `approval:approve:${approval.id}` },
        { text: '❌ Cancelar', callbackData: `approval:reject:${approval.id}` },
      ],
      settings?.secret,
    );

    return this.repo.createNotification({
      orgId,
      channel: 'telegram',
      notificationType: 'approval.requested',
      title: 'Aprobación enviada por Telegram',
      body: text,
      target: { chat_id: account.external_chat_id },
      status: 'sent',
      payload: { approval_id: approval.id },
    });
  }

  /**
   * Describe en lenguaje natural la acción que la approval va a ejecutar.
   * Prioriza el summary (ya viene humano desde quien la creó); si no hay,
   * arma una descripción a partir del action_type + payload conocido.
   */
  private describeApprovalAction(approval: Approval): string {
    if (approval.summary?.trim()) return approval.summary.trim();
    const p = (approval.payload ?? {}) as Record<string, unknown>;
    switch (approval.action_type) {
      case 'whatsapp.message.send':
        return `enviar un WhatsApp a ${p['contact']}: "${p['text']}"`;
      case 'gmail.send':
        return `enviar un correo a ${p['to']} con asunto "${p['subject'] ?? '(sin asunto)'}"`;
      case 'gmail.reply':
        return 'responder un correo';
      case 'calendar.create':
        return `crear el evento "${p['summary']}" en tu calendario`;
      case 'calendar.delete':
        return `eliminar el evento "${p['summary'] ?? p['event_id']}" de tu calendario`;
      case 'sandbox.network_exec':
        return 'ejecutar código con acceso a red';
      default:
        return `ejecutar la acción ${approval.action_type}`;
    }
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

  private async deliverToOriginatingChannel(
    orgId: string,
    taskId: string,
    text: string,
    isResult: boolean,
  ): Promise<void> {
    if (!text) return;
    try {
      const task = await this.tasks.getTask(taskId, orgId);
      if (!task) return;
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      const source = meta['source'] as string | undefined;

      if (source === 'telegram') {
        await this.deliverToTelegram(orgId, taskId, text, isResult);
      } else if (source === 'wear_fast_path') {
        const deviceId = meta['device_id'] as string | undefined;
        if (deviceId) {
          const { error } = await this.db.admin
            .from('wear_directives')
            .insert({
              org_id: orgId,
              device_id: deviceId,
              task_id: taskId,
              action: 'wear.notify',
              payload: {
                title: isResult ? 'Tarea completada' : 'Tarea en curso',
                body: text,
              },
              delivered: false,
            });
          if (error) {
            this.logger.warn(`Failed to insert wear_directive for task ${taskId}: ${error.message}`);
          } else {
            this.logger.log(`Pushed wear.notify directive to device ${deviceId} for task ${taskId}`);
          }
        }
      } else if (source === 'playground' || source === 'dashboard') {
        await this.repo.createNotification({
          orgId,
          userId: task.created_by,
          channel: 'dashboard',
          notificationType: isResult ? 'task.completed' : 'task.progress',
          title: isResult ? 'Tarea completada' : 'Tarea en curso',
          body: text,
          target: { task_id: taskId },
          payload: { source_event: isResult ? 'task.result' : 'task.say' },
          status: 'pending',
        });
        this.logger.log(`Created dashboard notification for task ${taskId} (isResult: ${isResult})`);
      }
    } catch (err) {
      this.logger.warn(`deliverToOriginatingChannel failed for task ${taskId}: ${(err as Error).message}`);
    }
  }

  private async deliverToTelegram(orgId: string, taskId: string, text: string, recordFeedbackTarget = true): Promise<void> {
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
        return;
      }
      if (!recordFeedbackTarget) return;
      await this.repo.createMessage({
        orgId,
        conversationId: typeof meta['conversation_id'] === 'string' ? meta['conversation_id'] : null,
        taskId,
        userId: task.created_by,
        channel: 'telegram',
        direction: 'outbound',
        body: text,
        externalMessageId: result.externalMessageId ?? null,
        payload: { source_event: 'task.result' },
      });
    } catch (err) {
      this.logger.warn(`deliverToTelegram failed for task ${taskId}: ${(err as Error).message}`);
    }
  }

  private inferUserFeedback(text: string): { reaction: UserFeedbackReaction; rating: number } | null {
    const normalized = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized || normalized.length > 120) return null;

    const positive = [
      'gracias', 'perfecto', 'excelente', 'muy bien', 'bien hecho', 'funciono',
      'correcto', 'listo gracias', 'genial', 'me sirvio',
    ];
    const negative = [
      'eso esta mal', 'esta mal', 'incorrecto', 'no funciono', 'fallo',
      'te equivocaste', 'no era', 'mal hecho', 'no sirve', 'corrige',
    ];
    if (negative.some((phrase) => normalized.includes(phrase))) {
      return { reaction: 'negative', rating: 1 };
    }
    if (positive.some((phrase) => normalized.includes(phrase))) {
      return { reaction: 'positive', rating: 5 };
    }
    return null;
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

  private async buildTelegramInboundMessage(
    orgId: string,
    message: NonNullable<TelegramWebhookUpdate['message']>,
    botToken?: string | null,
  ): Promise<{
    title: string;
    description: string;
    messageType: string;
    attachments: TelegramInboundAttachment[];
  }> {
    const text = this.telegramMessageText(message);
    const attachments = await this.processTelegramAttachments(orgId, message, botToken);
    const parts: string[] = [];
    if (text) parts.push(text);

    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        if (attachment.url) {
          parts.push(
            `Imagen recibida por Telegram: ${attachment.url}\n`
            + 'Analiza la imagen con image_analyze antes de responder; describe lo que ves y usa el texto del usuario como contexto.',
          );
        } else {
          parts.push(`Imagen recibida por Telegram, pero no se pudo preparar para analisis: ${attachment.error ?? 'error desconocido'}.`);
        }
      }

      if (attachment.kind === 'audio') {
        if (attachment.transcript) {
          parts.push(`Transcripcion del audio recibido por Telegram:\n${attachment.transcript}`);
        } else if (attachment.url) {
          parts.push(
            `Audio recibido por Telegram: ${attachment.url}\n`
            + `No se pudo transcribir automaticamente: ${attachment.error ?? 'no hay transcriptor configurado'}. `
            + 'Pide una version en texto si necesitas el contenido exacto.',
          );
        } else {
          parts.push(`Audio recibido por Telegram, pero no se pudo preparar: ${attachment.error ?? 'error desconocido'}.`);
        }
      }
    }

    const description = parts.join('\n\n').trim();
    const title = text || attachments.map((attachment) => attachment.kind).join(' + ') || 'Mensaje de Telegram';
    const messageType = attachments.length
      ? Array.from(new Set(attachments.map((attachment) => attachment.kind))).join('+')
      : 'text';

    return { title, description, messageType, attachments };
  }

  private async processTelegramAttachments(
    orgId: string,
    message: NonNullable<TelegramWebhookUpdate['message']>,
    botToken?: string | null,
  ): Promise<TelegramInboundAttachment[]> {
    const candidates = this.telegramAttachmentCandidates(message);
    const attachments: TelegramInboundAttachment[] = [];

    for (const candidate of candidates) {
      const attachment: TelegramInboundAttachment = {
        kind: candidate.kind,
        fileId: candidate.fileId,
        fileName: candidate.fileName,
        contentType: candidate.contentType,
      };
      attachments.push(attachment);

      if (candidate.fileSize && candidate.fileSize > MAX_TELEGRAM_FILE_BYTES) {
        attachment.error = `archivo demasiado grande (${candidate.fileSize} bytes)`;
        continue;
      }

      const downloaded = await this.telegram.downloadFile(candidate.fileId, botToken);
      if (!downloaded.ok || !downloaded.data) {
        attachment.error = downloaded.error ?? 'no se pudo descargar desde Telegram';
        continue;
      }

      const contentType = candidate.contentType || downloaded.contentType || this.contentTypeFromPath(downloaded.filePath);
      attachment.contentType = contentType;
      attachment.fileName = candidate.fileName || this.fileNameFromPath(downloaded.filePath, candidate.kind, contentType);
      attachment.url = await this.uploadInboundTelegramMedia(
        orgId,
        message.message_id,
        attachment.fileName,
        downloaded.data,
        contentType,
      ) ?? undefined;

      if (!attachment.url) {
        attachment.error = 'no se pudo subir a eva-media';
      }

      if (candidate.kind === 'audio') {
        attachment.transcript = await this.transcribeTelegramAudio(orgId, downloaded.data, attachment.fileName, contentType);
        if (!attachment.transcript && !attachment.error) {
          attachment.error = 'transcripcion no disponible';
        }
      }
    }

    return attachments;
  }

  private telegramAttachmentCandidates(message: NonNullable<TelegramWebhookUpdate['message']>): Array<{
    kind: 'image' | 'audio';
    fileId: string;
    fileName: string;
    contentType: string;
    fileSize?: number;
  }> {
    const candidates: Array<{
      kind: 'image' | 'audio';
      fileId: string;
      fileName: string;
      contentType: string;
      fileSize?: number;
    }> = [];

    const photo = [...(message.photo ?? [])].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    if (photo) {
      candidates.push({
        kind: 'image',
        fileId: photo.file_id,
        fileName: `telegram-photo-${message.message_id}.jpg`,
        contentType: 'image/jpeg',
        fileSize: photo.file_size,
      });
    }

    const document = message.document;
    if (document?.file_id && this.isSupportedImageContentType(document.mime_type)) {
      candidates.push({
        kind: 'image',
        fileId: document.file_id,
        fileName: document.file_name ?? `telegram-image-${message.message_id}.${this.extensionForContentType(document.mime_type ?? 'image/jpeg')}`,
        contentType: document.mime_type ?? 'image/jpeg',
        fileSize: document.file_size,
      });
    }

    const voice = message.voice;
    if (voice?.file_id) {
      candidates.push({
        kind: 'audio',
        fileId: voice.file_id,
        fileName: `telegram-voice-${message.message_id}.ogg`,
        contentType: voice.mime_type ?? 'audio/ogg',
        fileSize: voice.file_size,
      });
    }

    const audio = message.audio;
    if (audio?.file_id) {
      candidates.push({
        kind: 'audio',
        fileId: audio.file_id,
        fileName: audio.file_name ?? `telegram-audio-${message.message_id}.${this.extensionForContentType(audio.mime_type ?? 'audio/mpeg')}`,
        contentType: audio.mime_type ?? 'audio/mpeg',
        fileSize: audio.file_size,
      });
    }

    return candidates;
  }

  private telegramMessageText(message?: TelegramWebhookUpdate['message']): string {
    return String(message?.text ?? message?.caption ?? '').trim();
  }

  private telegramAttachmentFallbackText(message: NonNullable<TelegramWebhookUpdate['message']>): string {
    const kinds = this.telegramAttachmentCandidates(message).map((candidate) => candidate.kind);
    return kinds.length ? `[${Array.from(new Set(kinds)).join('+')} recibido por Telegram]` : '';
  }

  private async uploadInboundTelegramMedia(
    orgId: string,
    telegramMessageId: number,
    filename: string,
    data: Buffer,
    contentType: string,
  ): Promise<string | null> {
    await this.ensureInboundMediaBucket();
    const safeName = filename.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'telegram-media';
    const path = `${orgId}/telegram/${telegramMessageId}/${Date.now()}-${safeName}`;
    const { error } = await this.db.admin.storage.from(INBOUND_MEDIA_BUCKET).upload(path, data, {
      contentType,
      upsert: true,
    });
    if (error) {
      this.logger.warn(`telegram inbound media upload failed: ${error.message}`);
      return null;
    }
    const { data: pub } = this.db.admin.storage.from(INBOUND_MEDIA_BUCKET).getPublicUrl(path);
    return pub.publicUrl;
  }

  private async ensureInboundMediaBucket(): Promise<void> {
    if (this.inboundBucketReady) return;
    try {
      const { data } = await this.db.admin.storage.getBucket(INBOUND_MEDIA_BUCKET);
      if (!data) {
        await this.db.admin.storage.createBucket(INBOUND_MEDIA_BUCKET, { public: true });
      }
    } catch {
      await this.db.admin.storage.createBucket(INBOUND_MEDIA_BUCKET, { public: true }).catch(() => undefined);
    }
    this.inboundBucketReady = true;
  }

  private async transcribeTelegramAudio(
    orgId: string,
    data: Buffer,
    filename: string,
    contentType: string,
  ): Promise<string | undefined> {
    const key = (await this.integrations.getSecret(orgId, 'model', 'openai').catch(() => null))
      ?? process.env.OPENAI_API_KEY;
    if (!key) return undefined;

    try {
      const form = new FormData();
      const fileBytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe');
      form.append('file', new Blob([fileBytes], { type: contentType }), filename);
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) {
        this.logger.warn(`telegram audio transcription failed: HTTP ${res.status}`);
        return undefined;
      }
      const body = (await res.json()) as { text?: string };
      return body.text?.trim() || undefined;
    } catch (error) {
      this.logger.warn(`telegram audio transcription failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  private isSupportedImageContentType(contentType?: string): boolean {
    return /^image\/(png|jpe?g|webp|gif)$/i.test(contentType ?? '');
  }

  private contentTypeFromPath(path?: string): string {
    if (!path) return 'application/octet-stream';
    const lower = path.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.ogg')) return 'audio/ogg';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.wav')) return 'audio/wav';
    return 'application/octet-stream';
  }

  private fileNameFromPath(path: string | undefined, kind: 'image' | 'audio', contentType: string): string {
    const fromPath = path?.split('/').pop();
    if (fromPath) return fromPath;
    return `telegram-${kind}.${this.extensionForContentType(contentType)}`;
  }

  private extensionForContentType(contentType: string): string {
    if (/jpeg|jpg/i.test(contentType)) return 'jpg';
    if (/png/i.test(contentType)) return 'png';
    if (/webp/i.test(contentType)) return 'webp';
    if (/gif/i.test(contentType)) return 'gif';
    if (/ogg/i.test(contentType)) return 'ogg';
    if (/mp4|m4a/i.test(contentType)) return 'm4a';
    if (/wav/i.test(contentType)) return 'wav';
    if (/mpeg|mp3/i.test(contentType)) return 'mp3';
    return 'bin';
  }

  /**
   * Handle an inline keyboard tap for approval resolution.
   * callback_data format: "approval:approve|reject:<approval_id>"
   * Uses DB directly to avoid circular dependency with ApprovalsService.
   */
  private async handleApprovalCallback(
    orgId: string,
    cbq: NonNullable<TelegramWebhookUpdate['callback_query']>,
    botToken?: string | null,
  ): Promise<{ ok: boolean; handled?: string }> {
    const data = cbq.data ?? '';
    const match = /^approval:(approve|reject):(.+)$/.exec(data);

    if (!match) {
      await this.telegram.answerCallbackQuery(cbq.id, undefined, botToken);
      return { ok: true, handled: 'unknown_callback' };
    }

    const [, action, approvalId] = match;
    const externalUserId = String(cbq.from.id);

    // Resolve the EVA user from their Telegram ID
    const account = await this.repo.findAccount({ orgId, channel: 'telegram', externalUserId });
    const userId = account?.user_id;

    const { data: approval, error } = await this.db.admin
      .from('approvals')
      .select('*')
      .eq('org_id', orgId)
      .eq('id', approvalId)
      .eq('status', 'pending')
      .single();

    if (error || !approval) {
      await this.telegram.answerCallbackQuery(cbq.id, '⚠️ Esta aprobación ya no está activa.', botToken);
      return { ok: false, handled: 'approval_not_found' };
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await this.db.admin
      .from('approvals')
      .update({
        status: newStatus,
        reviewed_by: userId ?? null,
        reviewed_at: new Date().toISOString(),
        ...(action === 'reject' ? { summary: 'Cancelado desde Telegram' } : {}),
      })
      .eq('org_id', orgId)
      .eq('id', approvalId);

    await this.events.publish({
      type: 'approval.resolved',
      orgId,
      taskId: (approval as Record<string, unknown>)['task_id'] as string | undefined,
      payload: { approvalId, status: newStatus },
    });

    const ackText = action === 'approve' ? '✅ Aprobado — ejecutando acción.' : '❌ Cancelado.';
    await this.telegram.answerCallbackQuery(cbq.id, ackText, botToken);

    const chatId = cbq.message?.chat?.id ? String(cbq.message.chat.id) : null;
    if (chatId) {
      await this.telegram.sendMessage({ chat_id: chatId }, ackText, botToken);
    }

    return { ok: true, handled: newStatus };
  }
}
