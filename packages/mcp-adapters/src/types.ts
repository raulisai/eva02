export type McpAdapterKind = 'github' | 'supabase' | 'postgresql' | 'google' | 'aws' | 'custom';
export type McpTransport = 'stdio' | 'http' | 'sse' | 'mock';
export type McpAuthType = 'none' | 'oauth2' | 'pat' | 'service_account';
export type AuditEventType =
  | 'mcp.server.registered'
  | 'mcp.server.revoked'
  | 'mcp.oauth.started'
  | 'mcp.oauth.completed'
  | 'mcp.oauth.revoked'
  | 'mcp.tools.discovered'
  | 'mcp.tool.blocked'
  | 'mcp.tool.called';

export interface McpToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  scopes: string[];
  approval_level: 0 | 1 | 2 | 3;
  sandbox: {
    read_only: boolean;
    network?: string[];
    filesystem?: string[];
  };
}

export interface OAuthConfig {
  auth_url: string;
  token_url: string;
  client_id_env?: string;
  scopes: string[];
  redirect_uri?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  kind: McpAdapterKind;
  transport: McpTransport;
  endpoint?: string;
  command?: string;
  args?: string[];
  auth: {
    type: McpAuthType;
    oauth?: OAuthConfig;
    secret_ref?: string;
  };
  tools: McpToolDefinition[];
  revoked?: boolean;
  metadata?: Record<string, unknown>;
}

export interface McpPermissionGrant {
  server_id: string;
  tools: string[];
  scopes: string[];
  max_approval_level: 0 | 1 | 2 | 3;
  allow_write: boolean;
}

export interface McpPrincipal {
  org_id: string;
  user_id: string;
  grants: McpPermissionGrant[];
}

export interface McpAuditEvent {
  id: string;
  org_id: string;
  user_id: string;
  type: AuditEventType;
  server_id?: string;
  tool_name?: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ToolCallRecord {
  id: string;
  org_id: string;
  task_id?: string;
  server_id: string;
  tool_name: string;
  status: 'blocked' | 'completed' | 'failed';
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  created_at: string;
}

export interface McpTransportClient {
  listTools(server: McpServerConfig): Promise<McpToolDefinition[]>;
  callTool(server: McpServerConfig, toolName: string, input: Record<string, unknown>): Promise<unknown>;
}
