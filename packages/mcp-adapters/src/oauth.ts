import { randomBytes, randomUUID } from 'node:crypto';
import { McpServerConfig } from './types';

export interface OAuthSession {
  state: string;
  server_id: string;
  authorization_url: string;
  scopes: string[];
  created_at: string;
}

export interface OAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  revoked_at?: string;
}

export class McpOAuthManager {
  private readonly pending = new Map<string, OAuthSession>();
  private readonly tokens = new Map<string, OAuthToken>();

  start(server: McpServerConfig, redirectUri: string): OAuthSession {
    if (server.auth.type !== 'oauth2' || !server.auth.oauth) {
      throw new Error(`MCP server ${server.id} does not use OAuth`);
    }
    const state = randomUUID();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: server.auth.oauth.client_id_env ?? server.id,
      redirect_uri: server.auth.oauth.redirect_uri ?? redirectUri,
      scope: server.auth.oauth.scopes.join(' '),
      state,
    });
    const session = {
      state,
      server_id: server.id,
      authorization_url: `${server.auth.oauth.auth_url}?${params.toString()}`,
      scopes: server.auth.oauth.scopes,
      created_at: new Date().toISOString(),
    };
    this.pending.set(state, session);
    return session;
  }

  complete(state: string, code: string): OAuthToken {
    const session = this.pending.get(state);
    if (!session) throw new Error('Unknown OAuth state');
    this.pending.delete(state);
    const token = {
      access_token: `mock_${randomBytes(12).toString('hex')}_${code}`,
      refresh_token: `mock_refresh_${randomBytes(8).toString('hex')}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    this.tokens.set(session.server_id, token);
    return token;
  }

  tokenFor(serverId: string): OAuthToken | null {
    return this.tokens.get(serverId) ?? null;
  }

  revoke(serverId: string): OAuthToken {
    const token = this.tokens.get(serverId);
    if (!token) throw new Error(`No OAuth token for ${serverId}`);
    const revoked = { ...token, revoked_at: new Date().toISOString() };
    this.tokens.set(serverId, revoked);
    return revoked;
  }
}
