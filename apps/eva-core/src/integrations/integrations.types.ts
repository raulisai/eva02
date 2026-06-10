export type IntegrationKind = 'model' | 'channel';
export type IntegrationStatus = 'active' | 'disabled' | 'error';

export interface OrgIntegration {
  id: string;
  org_id: string;
  kind: IntegrationKind;
  provider: string;
  label: string | null;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  secret_ciphertext: string | null;
  secret_hint: string | null;
  webhook_secret_ciphertext: string | null;
  created_at: string;
  updated_at: string;
}

/** Safe projection: what controllers return (no ciphertext, ever). */
export interface IntegrationView {
  id: string;
  kind: IntegrationKind;
  provider: string;
  label: string | null;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  secret_hint: string | null;
  has_secret: boolean;
  updated_at: string;
}

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpStatus = 'disconnected' | 'connected' | 'error';

export interface McpConnection {
  id: string;
  org_id: string;
  name: string;
  transport: McpTransport;
  endpoint: string;
  enabled: boolean;
  status: McpStatus;
  auth_ciphertext: string | null;
  tools: Array<Record<string, unknown>>;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpConnectionView {
  id: string;
  name: string;
  transport: McpTransport;
  endpoint: string;
  enabled: boolean;
  status: McpStatus;
  tools: Array<Record<string, unknown>>;
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string;
}

/** Decrypted channel settings consumed internally (never serialized to clients). */
export interface ChannelSettings {
  status: IntegrationStatus;
  config: Record<string, unknown>;
  secret: string | null;
  webhookSecret: string | null;
}
