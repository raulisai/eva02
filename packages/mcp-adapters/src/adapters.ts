import { McpServerConfig } from './types';

const readOnlySandbox = { read_only: true, network: ['https://*'], filesystem: [] };
const writeSandbox = { read_only: false, network: ['https://*'], filesystem: [] };

export const initialMcpServers: McpServerConfig[] = [
  {
    id: 'github',
    name: 'GitHub MCP',
    kind: 'github',
    transport: 'http',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    auth: {
      type: 'oauth2',
      oauth: {
        auth_url: 'https://github.com/login/oauth/authorize',
        token_url: 'https://github.com/login/oauth/access_token',
        client_id_env: 'GITHUB_OAUTH_CLIENT_ID',
        scopes: ['repo', 'read:org'],
      },
    },
    tools: [
      tool('github.search_repositories', 'Search repositories', ['github.read'], 0, readOnlySandbox),
      tool('github.create_issue', 'Create an issue', ['github.write'], 1, writeSandbox),
      tool('github.merge_pr', 'Merge a pull request', ['github.write', 'production'], 2, writeSandbox),
    ],
  },
  {
    id: 'supabase',
    name: 'Supabase MCP',
    kind: 'supabase',
    transport: 'http',
    endpoint: 'https://mcp.supabase.com/mcp',
    auth: {
      type: 'oauth2',
      oauth: {
        auth_url: 'https://api.supabase.com/v1/oauth/authorize',
        token_url: 'https://api.supabase.com/v1/oauth/token',
        scopes: ['database.read', 'database.write', 'projects.read'],
      },
    },
    tools: [
      tool('supabase.list_projects', 'List Supabase projects', ['supabase.read'], 0, readOnlySandbox),
      tool('supabase.execute_sql', 'Execute SQL in a project', ['supabase.sql'], 2, writeSandbox),
      tool('supabase.apply_migration', 'Apply a migration', ['supabase.migrations'], 3, writeSandbox),
    ],
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL MCP',
    kind: 'postgresql',
    transport: 'stdio',
    command: 'postgres-mcp',
    auth: { type: 'service_account', secret_ref: 'DATABASE_URL' },
    tools: [
      tool('postgresql.query', 'Run a read-only query', ['postgresql.read'], 0, readOnlySandbox),
      tool('postgresql.execute', 'Run a write query', ['postgresql.write'], 2, writeSandbox),
    ],
  },
  {
    id: 'google',
    name: 'Google MCP',
    kind: 'google',
    transport: 'http',
    endpoint: 'https://mcp.google.example',
    auth: {
      type: 'oauth2',
      oauth: {
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: 'https://oauth2.googleapis.com/token',
        client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
        scopes: ['drive.readonly', 'gmail.readonly', 'calendar.readonly'],
      },
    },
    tools: [
      tool('google.drive_search', 'Search Google Drive', ['google.drive.read'], 0, readOnlySandbox),
      tool('google.gmail_search', 'Search Gmail', ['google.gmail.read'], 0, readOnlySandbox),
      tool('google.calendar_create_event', 'Create a calendar event', ['google.calendar.write'], 1, writeSandbox),
    ],
  },
  {
    id: 'aws',
    name: 'AWS MCP',
    kind: 'aws',
    transport: 'stdio',
    command: 'aws-mcp',
    auth: { type: 'service_account', secret_ref: 'AWS_ROLE_ARN' },
    tools: [
      tool('aws.cost_explorer', 'Read AWS cost data', ['aws.billing.read'], 0, readOnlySandbox),
      tool('aws.list_resources', 'List AWS resources', ['aws.read'], 0, readOnlySandbox),
      tool('aws.delete_resource', 'Delete an AWS resource', ['aws.write', 'production'], 3, writeSandbox),
    ],
  },
];

function tool(
  name: string,
  description: string,
  scopes: string[],
  approvalLevel: 0 | 1 | 2 | 3,
  sandbox: { read_only: boolean; network?: string[]; filesystem?: string[] },
) {
  return {
    name,
    description,
    input_schema: {},
    scopes,
    approval_level: approvalLevel,
    sandbox,
  };
}
