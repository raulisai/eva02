import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpClient } from '@/components/mcp/mcp-client';
import type { McpConnection } from '@/lib/types';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }),
    },
  }),
}));

function mcpConnection(overrides: Partial<McpConnection>): McpConnection {
  return {
    id: 'mcp-1',
    name: 'GitHub MCP',
    transport: 'http',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    enabled: true,
    status: 'disconnected',
    tools: [],
    last_checked_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('McpClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockImplementation(async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return {
        ok: true,
        json: async () => mcpConnection({
          id: 'created-github',
          name: body.name,
          transport: body.transport,
          endpoint: body.endpoint,
        }),
        text: async () => '',
      };
    }) as jest.Mock;
  });

  it('renders a bundled MCP repository', () => {
    render(<McpClient initialConnections={[]} />);

    expect(screen.getByText('MCP repository')).toBeInTheDocument();
    expect(screen.getByText('GitHub MCP')).toBeInTheDocument();
    expect(screen.getByText('Supabase MCP')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL MCP')).toBeInTheDocument();
    expect(screen.getByText('AWS MCP')).toBeInTheDocument();
  });

  it('connects a catalog preset through eva-core with the optional token', async () => {
    render(<McpClient initialConnections={[]} />);

    fireEvent.change(screen.getByLabelText('GitHub MCP token'), { target: { value: 'ghp_test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub MCP' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/mcp/connections'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      name: 'GitHub MCP',
      transport: 'http',
      endpoint: 'https://api.githubcopilot.com/mcp/',
      auth_token: 'ghp_test',
      enabled: true,
    });
    expect(await screen.findByRole('button', { name: 'GitHub MCP connected' })).toBeDisabled();
  });

  it('marks matching existing presets as already connected', () => {
    render(<McpClient initialConnections={[mcpConnection({ id: 'existing-supabase', name: 'Supabase MCP', endpoint: 'https://mcp.supabase.com/mcp' })]} />);

    expect(screen.getByRole('button', { name: 'Supabase MCP connected' })).toBeDisabled();
  });
});
