import { McpAuditLog, ToolCallLogger } from './audit';
import { McpClient } from './client';
import { McpOAuthManager } from './oauth';
import { McpPermissionLayer } from './permissions';
import { McpServerRegistry } from './registry';
import { McpSandbox } from './sandbox';
import { McpPrincipal, McpServerConfig, McpToolDefinition } from './types';

export class McpManager {
  constructor(
    readonly registry: McpServerRegistry,
    private readonly client: McpClient,
    private readonly permissions: McpPermissionLayer,
    private readonly sandbox: McpSandbox,
    readonly oauth: McpOAuthManager,
    readonly audit: McpAuditLog,
    readonly toolCalls: ToolCallLogger,
  ) {}

  registerServer(server: McpServerConfig, principal: McpPrincipal): McpServerConfig {
    const registered = this.registry.register(server);
    this.audit.record({
      org_id: principal.org_id,
      user_id: principal.user_id,
      type: 'mcp.server.registered',
      server_id: registered.id,
      payload: { kind: registered.kind, transport: registered.transport },
    });
    return registered;
  }

  revokeServer(serverId: string, principal: McpPrincipal): McpServerConfig {
    const revoked = this.registry.revoke(serverId);
    this.audit.record({
      org_id: principal.org_id,
      user_id: principal.user_id,
      type: 'mcp.server.revoked',
      server_id: serverId,
      payload: {},
    });
    return revoked;
  }

  async discoverTools(serverId: string, principal: McpPrincipal): Promise<McpToolDefinition[]> {
    const server = this.requireServer(serverId);
    if (server.revoked) throw new Error(`MCP server ${serverId} is revoked`);
    const tools = await this.client.listTools(server);
    this.audit.record({
      org_id: principal.org_id,
      user_id: principal.user_id,
      type: 'mcp.tools.discovered',
      server_id: serverId,
      payload: { count: tools.length },
    });
    return tools;
  }

  async callTool(input: {
    serverId: string;
    toolName: string;
    payload: Record<string, unknown>;
    principal: McpPrincipal;
    taskId?: string;
  }): Promise<unknown> {
    const server = this.requireServer(input.serverId);
    const tool = server.tools.find((candidate) => candidate.name === input.toolName);
    if (!tool) throw new Error(`MCP tool ${input.toolName} not found`);

    try {
      this.permissions.assertCanUse(input.principal, server, tool);
      this.sandbox.assertAllowed(tool, input.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP tool blocked';
      this.audit.record({
        org_id: input.principal.org_id,
        user_id: input.principal.user_id,
        type: 'mcp.tool.blocked',
        server_id: input.serverId,
        tool_name: input.toolName,
        payload: { reason: message },
      });
      this.toolCalls.record({
        org_id: input.principal.org_id,
        task_id: input.taskId,
        server_id: input.serverId,
        tool_name: input.toolName,
        status: 'blocked',
        input: input.payload,
        error: message,
      });
      throw error;
    }

    try {
      const output = await this.client.callTool(server, input.toolName, input.payload);
      this.audit.record({
        org_id: input.principal.org_id,
        user_id: input.principal.user_id,
        type: 'mcp.tool.called',
        server_id: input.serverId,
        tool_name: input.toolName,
        payload: { taskId: input.taskId ?? null },
      });
      this.toolCalls.record({
        org_id: input.principal.org_id,
        task_id: input.taskId,
        server_id: input.serverId,
        tool_name: input.toolName,
        status: 'completed',
        input: input.payload,
        output,
      });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP tool failed';
      this.toolCalls.record({
        org_id: input.principal.org_id,
        task_id: input.taskId,
        server_id: input.serverId,
        tool_name: input.toolName,
        status: 'failed',
        input: input.payload,
        error: message,
      });
      throw error;
    }
  }

  startOAuth(serverId: string, principal: McpPrincipal, redirectUri: string) {
    const server = this.requireServer(serverId);
    const session = this.oauth.start(server, redirectUri);
    this.audit.record({
      org_id: principal.org_id,
      user_id: principal.user_id,
      type: 'mcp.oauth.started',
      server_id: serverId,
      payload: { state: session.state, scopes: session.scopes },
    });
    return session;
  }

  completeOAuth(serverId: string, principal: McpPrincipal, state: string, code: string) {
    const token = this.oauth.complete(state, code);
    this.audit.record({
      org_id: principal.org_id,
      user_id: principal.user_id,
      type: 'mcp.oauth.completed',
      server_id: serverId,
      payload: { expires_at: token.expires_at ?? null },
    });
    return token;
  }

  revokeOAuth(serverId: string, principal: McpPrincipal) {
    const token = this.oauth.revoke(serverId);
    this.audit.record({
      org_id: principal.org_id,
      user_id: principal.user_id,
      type: 'mcp.oauth.revoked',
      server_id: serverId,
      payload: { revoked_at: token.revoked_at },
    });
    return token;
  }

  private requireServer(serverId: string): McpServerConfig {
    const server = this.registry.get(serverId);
    if (!server) throw new Error(`MCP server ${serverId} not found`);
    return server;
  }
}
