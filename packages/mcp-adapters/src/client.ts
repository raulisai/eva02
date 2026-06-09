import { McpServerConfig, McpToolDefinition, McpTransportClient } from './types';

export class McpClient {
  constructor(private readonly transport: McpTransportClient) {}

  listTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
    return this.transport.listTools(server);
  }

  callTool(server: McpServerConfig, toolName: string, input: Record<string, unknown>): Promise<unknown> {
    return this.transport.callTool(server, toolName, input);
  }
}

export class StaticMcpTransport implements McpTransportClient {
  async listTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
    return server.tools;
  }

  async callTool(server: McpServerConfig, toolName: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = server.tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);
    return { server_id: server.id, tool_name: toolName, input, ok: true };
  }
}
