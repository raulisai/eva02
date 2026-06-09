import { McpPermissionGrant, McpPrincipal, McpServerConfig, McpToolDefinition } from './types';

export class McpPermissionLayer {
  assertCanUse(principal: McpPrincipal, server: McpServerConfig, tool: McpToolDefinition): void {
    if (server.revoked) throw new Error(`MCP server ${server.id} is revoked`);
    const grant = this.findGrant(principal, server.id);
    if (!grant) throw new Error(`No MCP grant for ${server.id}`);
    if (!grant.tools.includes('*') && !grant.tools.includes(tool.name)) {
      throw new Error(`Tool ${tool.name} is not permitted for ${server.id}`);
    }
    const missingScope = tool.scopes.find((scope) => !grant.scopes.includes('*') && !grant.scopes.includes(scope));
    if (missingScope) throw new Error(`Missing MCP scope ${missingScope}`);
    if (tool.approval_level > grant.max_approval_level) {
      throw new Error(`Tool ${tool.name} requires approval level ${tool.approval_level}`);
    }
    if (!tool.sandbox.read_only && !grant.allow_write) {
      throw new Error(`Write access denied for ${tool.name}`);
    }
  }

  private findGrant(principal: McpPrincipal, serverId: string): McpPermissionGrant | null {
    return principal.grants.find((grant) => grant.server_id === serverId) ?? null;
  }
}
