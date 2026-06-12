import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  CommunicationAccount,
  CommunicationChannel,
  CommunicationMessage,
  CommunicationNotification,
  Conversation,
  NotificationStatus,
} from './communication.types';

@Injectable()
export class CommunicationRepository {
  private readonly logger = new Logger(CommunicationRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async linkAccount(input: {
    orgId: string;
    userId: string;
    channel: CommunicationChannel;
    externalUserId: string;
    externalChatId?: string | null;
    displayName?: string | null;
  }): Promise<CommunicationAccount> {
    const { data, error } = await this.db.admin
      .from('communication_accounts')
      .upsert({
        org_id: input.orgId,
        user_id: input.userId,
        channel: input.channel,
        external_user_id: input.externalUserId,
        external_chat_id: input.externalChatId ?? null,
        display_name: input.displayName ?? null,
        status: 'active',
      }, { onConflict: 'org_id,channel,external_user_id' })
      .select()
      .single();

    if (error) this.fail('communication_accounts.link', error);
    return data as CommunicationAccount;
  }

  async findAccount(input: {
    orgId: string;
    channel: CommunicationChannel;
    externalUserId: string;
  }): Promise<CommunicationAccount | null> {
    const { data, error } = await this.db.admin
      .from('communication_accounts')
      .select('*')
      .eq('org_id', input.orgId)
      .eq('channel', input.channel)
      .eq('external_user_id', input.externalUserId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) this.fail('communication_accounts.find', error);
    return data as CommunicationAccount | null;
  }

  /** Find the active account for a given internal userId + channel (used for cross-channel delivery). */
  async findAccountByUserId(
    orgId: string,
    userId: string,
    channel: CommunicationChannel,
  ): Promise<CommunicationAccount | null> {
    const { data, error } = await this.db.admin
      .from('communication_accounts')
      .select('*')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('channel', channel)
      .eq('status', 'active')
      .maybeSingle();

    if (error) this.fail('communication_accounts.findByUserId', error);
    return data as CommunicationAccount | null;
  }

  async getOrCreateConversation(input: {
    orgId: string;
    channel: CommunicationChannel;
    externalConversationId: string;
    userId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<Conversation> {
    const { data, error } = await this.db.admin
      .from('conversations')
      .upsert({
        org_id: input.orgId,
        channel: input.channel,
        external_conversation_id: input.externalConversationId,
        user_id: input.userId ?? null,
        metadata: input.metadata ?? {},
        status: 'open',
      }, { onConflict: 'org_id,channel,external_conversation_id' })
      .select()
      .single();

    if (error) this.fail('conversations.upsert', error);
    return data as Conversation;
  }

  async createMessage(input: {
    orgId: string;
    conversationId?: string | null;
    taskId?: string | null;
    userId?: string | null;
    channel: CommunicationChannel;
    direction: 'inbound' | 'outbound';
    messageType?: string;
    body?: string | null;
    externalMessageId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<CommunicationMessage> {
    const { data, error } = await this.db.admin
      .from('messages')
      .insert({
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
      })
      .select()
      .single();

    if (error) this.fail('messages.create', error);
    return data as CommunicationMessage;
  }

  async findLatestOutboundTaskMessage(input: {
    orgId: string;
    conversationId: string;
    channel: CommunicationChannel;
  }): Promise<CommunicationMessage | null> {
    const { data, error } = await this.db.admin
      .from('messages')
      .select('*')
      .eq('org_id', input.orgId)
      .eq('conversation_id', input.conversationId)
      .eq('channel', input.channel)
      .eq('direction', 'outbound')
      .not('task_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) this.fail('messages.findLatestOutboundTask', error);
    return data as CommunicationMessage | null;
  }

  async createNotification(input: {
    orgId: string;
    userId?: string | null;
    channel: CommunicationChannel;
    notificationType: string;
    title: string;
    body?: string | null;
    target?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    status?: NotificationStatus;
    error?: string | null;
    sentAt?: string | null;
  }): Promise<CommunicationNotification> {
    const { data, error: dbError } = await this.db.admin
      .from('notifications')
      .insert({
        org_id: input.orgId,
        user_id: input.userId ?? null,
        channel: input.channel,
        notification_type: input.notificationType,
        title: input.title,
        body: input.body ?? null,
        target: input.target ?? {},
        payload: input.payload ?? {},
        status: input.status ?? 'pending',
        error: input.error ?? null,
        sent_at: input.sentAt ?? null,
      })
      .select()
      .single();

    if (dbError) this.fail('notifications.create', dbError);
    return data as CommunicationNotification;
  }

  async findRecentNotifications(orgId: string, limit = 20): Promise<CommunicationNotification[]> {
    const { data, error } = await this.db.admin
      .from('notifications')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) this.fail('notifications.findRecent', error);
    return (data ?? []) as CommunicationNotification[];
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Failed to write ${scope}`);
  }
}
