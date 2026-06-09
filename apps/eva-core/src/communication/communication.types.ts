export type CommunicationChannel = 'telegram' | 'discord' | 'email' | 'push' | 'dashboard';
export type MessageDirection = 'inbound' | 'outbound';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface CommunicationAccount {
  id: string;
  org_id: string;
  user_id: string;
  channel: CommunicationChannel;
  external_user_id: string;
  external_chat_id: string | null;
  display_name: string | null;
  status: 'active' | 'revoked';
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  org_id: string;
  channel: CommunicationChannel;
  external_conversation_id: string;
  user_id: string | null;
  status: 'open' | 'closed';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CommunicationMessage {
  id: string;
  org_id: string;
  conversation_id: string | null;
  task_id: string | null;
  user_id: string | null;
  channel: CommunicationChannel;
  direction: MessageDirection;
  message_type: string;
  body: string | null;
  external_message_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CommunicationNotification {
  id: string;
  org_id: string;
  user_id: string | null;
  channel: CommunicationChannel;
  notification_type: string;
  title: string;
  body: string | null;
  status: NotificationStatus;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

export interface SendMessageInput {
  orgId: string;
  userId?: string | null;
  channel: CommunicationChannel;
  target: Record<string, unknown>;
  text: string;
  notificationType?: string;
  payload?: Record<string, unknown>;
}

export interface ChannelSendResult {
  ok: boolean;
  externalMessageId?: string | null;
  skipped?: boolean;
  error?: string;
}

export interface TelegramWebhookUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string; type: string };
    from?: {
      id: number | string;
      first_name?: string;
      username?: string;
    };
  };
}
