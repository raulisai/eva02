import {
  initialMcpServers,
  McpAuditLog,
  McpClient,
  McpManager,
  McpOAuthManager,
  McpPermissionLayer,
  McpPrincipal,
  McpSandbox,
  McpServerConfig,
  McpServerRegistry,
  McpTransportClient,
  StaticMcpTransport,
  ToolCallLogger,
} from '../src';

const principal: McpPrincipal = {
  org_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  grants: [
    {
      server_id: 'mock',
      tools: ['mock.echo', 'mock.read'],
      scopes: ['mock.read', 'mock.write'],
      max_approval_level: 1,
      allow_write: true,
    },
    {
      server_id: 'github',
      tools: ['github.search_repositories'],
      scopes: ['github.read'],
      max_approval_level: 0,
      allow_write: false,
    },
    {
      server_id: 'supabase',
      tools: ['supabase.list_projects'],
      scopes: ['supabase.read'],
      max_approval_level: 0,
      allow_write: false,
    },
  ],
};

const mockServer: McpServerConfig = {
  id: 'mock',
  name: 'Mock MCP',
  kind: 'custom',
  transport: 'mock',
  auth: {
    type: 'oauth2',
    oauth: {
      auth_url: 'https://auth.example/authorize',
      token_url: 'https://auth.example/token',
      client_id_env: 'MOCK_CLIENT_ID',
      scopes: ['mock.read', 'mock.write'],
    },
  },
  tools: [
    {
      name: 'mock.read',
      description: 'Read data',
      input_schema: {},
      scopes: ['mock.read'],
      approval_level: 0,
      sandbox: { read_only: true, network: [], filesystem: [] },
    },
    {
      name: 'mock.echo',
      description: 'Echo data',
      input_schema: {},
      scopes: ['mock.write'],
      approval_level: 1,
      sandbox: { read_only: false, network: [], filesystem: [] },
    },
  ],
};

class MockTransport implements McpTransportClient {
  calls: Array<{ serverId: string; toolName: string; input: Record<string, unknown> }> = [];

  async listTools(server: McpServerConfig) {
    return server.tools;
  }

  async callTool(server: McpServerConfig, toolName: string, input: Record<string, unknown>) {
    this.calls.push({ serverId: server.id, toolName, input });
    return { ok: true, echo: input };
  }
}

function makeManager(transport: McpTransportClient = new MockTransport()) {
  const registry = new McpServerRegistry();
  const audit = new McpAuditLog();
  const toolCalls = new ToolCallLogger();
  const manager = new McpManager(
    registry,
    new McpClient(transport),
    new McpPermissionLayer(),
    new McpSandbox(),
    new McpOAuthManager(),
    audit,
    toolCalls,
  );
  return { manager, registry, audit, toolCalls, transport };
}

describe('MCP Manager', () => {
  it('registers initial adapters and discovers tools from a mock server', async () => {
    const { manager } = makeManager();
    for (const server of initialMcpServers) manager.registerServer(server, principal);
    manager.registerServer(mockServer, principal);

    const tools = await manager.discoverTools('mock', principal);

    expect(tools.map((tool) => tool.name)).toEqual(['mock.read', 'mock.echo']);
    expect(manager.audit.byType('mcp.tools.discovered')).toHaveLength(1);
    expect(manager.registry.get('github')?.kind).toBe('github');
    expect(manager.registry.get('supabase')?.endpoint).toBe('https://mcp.supabase.com/mcp');
  });

  it('enforces permissions and logs blocked tool calls', async () => {
    const { manager, toolCalls, audit } = makeManager();
    manager.registerServer(mockServer, principal);

    await expect(manager.callTool({
      serverId: 'mock',
      toolName: 'mock.unknown',
      payload: {},
      principal,
    })).rejects.toThrow(/not found/);

    await expect(manager.callTool({
      serverId: 'mock',
      toolName: 'mock.echo',
      payload: { text: 'ok' },
      principal: { ...principal, grants: [] },
    })).rejects.toThrow(/No MCP grant/);

    expect(toolCalls.list()).toHaveLength(1);
    expect(toolCalls.list()[0].status).toBe('blocked');
    expect(audit.byType('mcp.tool.blocked')).toHaveLength(1);
  });

  it('blocks destructive input in read-only sandbox', async () => {
    const { manager, toolCalls } = makeManager();
    manager.registerServer(mockServer, principal);

    await expect(manager.callTool({
      serverId: 'mock',
      toolName: 'mock.read',
      payload: { sql: 'drop table users' },
      principal,
    })).rejects.toThrow(/Sandbox blocked/);

    expect(toolCalls.list()[0]).toEqual(expect.objectContaining({
      server_id: 'mock',
      tool_name: 'mock.read',
      status: 'blocked',
    }));
  });

  it('calls an allowed tool and records audit plus tool_call logs', async () => {
    const { manager, toolCalls, audit, transport } = makeManager();
    manager.registerServer(mockServer, principal);

    const output = await manager.callTool({
      serverId: 'mock',
      toolName: 'mock.echo',
      payload: { text: 'hello' },
      principal,
      taskId: 'task-1',
    });

    expect(output).toEqual({ ok: true, echo: { text: 'hello' } });
    expect((transport as MockTransport).calls).toHaveLength(1);
    expect(toolCalls.list()[0]).toEqual(expect.objectContaining({
      org_id: principal.org_id,
      task_id: 'task-1',
      status: 'completed',
    }));
    expect(audit.byType('mcp.tool.called')).toHaveLength(1);
  });

  it('supports OAuth start/complete/revoke and server revocation', () => {
    const { manager } = makeManager(new StaticMcpTransport());
    manager.registerServer(mockServer, principal);

    const session = manager.startOAuth('mock', principal, 'http://localhost/oauth/callback');
    expect(session.authorization_url).toContain('state=');
    const token = manager.completeOAuth('mock', principal, session.state, 'code-123');
    expect(token.access_token).toContain('code-123');
    const revokedToken = manager.revokeOAuth('mock', principal);
    expect(revokedToken.revoked_at).toBeDefined();

    manager.revokeServer('mock', principal);
    expect(manager.registry.get('mock')?.revoked).toBe(true);
  });
});
