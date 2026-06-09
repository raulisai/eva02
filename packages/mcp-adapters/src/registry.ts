import { McpServerConfig } from './types';

export class McpServerRegistry {
  private readonly servers = new Map<string, McpServerConfig>();

  register(server: McpServerConfig): McpServerConfig {
    if (this.servers.has(server.id)) throw new Error(`MCP server ${server.id} is already registered`);
    this.servers.set(server.id, { ...server, revoked: server.revoked ?? false });
    return this.get(server.id)!;
  }

  list(): McpServerConfig[] {
    return [...this.servers.values()];
  }

  get(serverId: string): McpServerConfig | null {
    return this.servers.get(serverId) ?? null;
  }

  revoke(serverId: string): McpServerConfig {
    const server = this.get(serverId);
    if (!server) throw new Error(`MCP server ${serverId} not found`);
    const revoked = { ...server, revoked: true };
    this.servers.set(serverId, revoked);
    return revoked;
  }
}
