import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SecretCipher } from '../common/secret-cipher';
import { IntegrationsRepository } from './integrations.repository';
import {
  ChannelSettings,
  IntegrationKind,
  IntegrationView,
  McpConnection,
  McpConnectionView,
  OrgIntegration,
} from './integrations.types';

const KNOWN_MODEL_PROVIDERS = ['anthropic', 'openai', 'google', 'groq', 'openrouter'];
const KNOWN_CHANNEL_PROVIDERS = ['telegram', 'discord', 'slack', 'whatsapp', 'email', 'sms'];

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private readonly repo: IntegrationsRepository) {}

  async list(orgId: string, kind?: IntegrationKind): Promise<IntegrationView[]> {
    const rows = await this.repo.listIntegrations(orgId, kind);
    return rows.map((row) => this.toView(row));
  }

  async upsert(input: {
    orgId: string;
    kind: IntegrationKind;
    provider: string;
    secret?: string;
    config?: Record<string, unknown>;
    status?: 'active' | 'disabled';
    label?: string;
  }): Promise<IntegrationView> {
    this.assertKnownProvider(input.kind, input.provider);

    let secretCiphertext: string | undefined;
    let secretHint: string | undefined;
    let webhookSecretCiphertext: string | undefined;

    if (input.secret) {
      secretCiphertext = SecretCipher.encrypt(input.secret);
      secretHint = SecretCipher.hint(input.secret);
      // Channels that receive webhooks get a per-org webhook secret rotated
      // together with the credential.
      if (input.kind === 'channel' && input.provider === 'telegram') {
        webhookSecretCiphertext = SecretCipher.encrypt(randomBytes(24).toString('hex'));
      }
    }

    const row = await this.repo.upsertIntegration({
      orgId: input.orgId,
      kind: input.kind,
      provider: input.provider,
      label: input.label,
      status: input.status,
      config: input.config,
      secretCiphertext,
      secretHint,
      webhookSecretCiphertext,
    });
    return this.toView(row);
  }

  async remove(orgId: string, kind: IntegrationKind, provider: string): Promise<{ ok: true }> {
    await this.repo.deleteIntegration(orgId, kind, provider);
    return { ok: true };
  }

  /** Decrypted credential for internal use only (model routing, channel adapters). */
  async getSecret(orgId: string, kind: IntegrationKind, provider: string): Promise<string | null> {
    const row = await this.repo.findIntegration(orgId, kind, provider);
    if (!row?.secret_ciphertext) return null;
    return SecretCipher.decrypt(row.secret_ciphertext);
  }

  /** Channel settings (decrypted) consumed by the Communication Hub. */
  async getChannelSettings(orgId: string, provider: string): Promise<ChannelSettings | null> {
    const row = await this.repo.findIntegration(orgId, 'channel', provider);
    if (!row) return null;
    return {
      status: row.status,
      config: row.config ?? {},
      secret: row.secret_ciphertext ? SecretCipher.decrypt(row.secret_ciphertext) : null,
      webhookSecret: row.webhook_secret_ciphertext
        ? SecretCipher.decrypt(row.webhook_secret_ciphertext)
        : null,
    };
  }

  /** Validates the stored Telegram token against the Bot API (getMe). */
  async testTelegram(orgId: string): Promise<{ ok: boolean; bot?: string; error?: string }> {
    const settings = await this.getChannelSettings(orgId, 'telegram');
    const token = settings?.secret ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { ok: false, error: 'No bot token configured' };

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const body = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string };
      if (!body.ok) return { ok: false, error: body.description ?? 'Telegram rejected the token' };
      return { ok: true, bot: body.result?.username };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /**
   * Registers the org-scoped webhook with Telegram using the rotated
   * per-org webhook secret. Requires PUBLIC_WEBHOOK_URL.
   */
  async registerTelegramWebhook(orgId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const base = process.env.PUBLIC_WEBHOOK_URL;
    if (!base) return { ok: false, error: 'PUBLIC_WEBHOOK_URL is not set' };

    const settings = await this.getChannelSettings(orgId, 'telegram');
    if (!settings?.secret) return { ok: false, error: 'No bot token configured' };
    if (!settings.webhookSecret) return { ok: false, error: 'No webhook secret stored — re-save the bot token' };

    const url = `${base.replace(/\/$/, '')}/communication/webhooks/telegram/${orgId}`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${settings.secret}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: settings.webhookSecret }),
      });
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (!body.ok) return { ok: false, error: body.description ?? 'setWebhook failed' };
      return { ok: true, url };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async listMcp(orgId: string): Promise<McpConnectionView[]> {
    const rows = await this.repo.listMcpConnections(orgId);
    return rows.map((row) => this.toMcpView(row));
  }

  async createMcp(input: {
    orgId: string;
    name: string;
    transport: 'http' | 'sse' | 'stdio';
    endpoint: string;
    authToken?: string;
    enabled?: boolean;
  }): Promise<McpConnectionView> {
    const row = await this.repo.createMcpConnection({
      orgId: input.orgId,
      name: input.name,
      transport: input.transport,
      endpoint: input.endpoint,
      enabled: input.enabled ?? true,
      authCiphertext: input.authToken ? SecretCipher.encrypt(input.authToken) : null,
    });
    return this.toMcpView(row);
  }

  async updateMcp(
    orgId: string,
    id: string,
    patch: { enabled?: boolean; endpoint?: string; authToken?: string },
  ): Promise<McpConnectionView> {
    const update: Record<string, unknown> = {};
    if (patch.enabled !== undefined) update.enabled = patch.enabled;
    if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
    if (patch.authToken !== undefined) {
      update.auth_ciphertext = patch.authToken ? SecretCipher.encrypt(patch.authToken) : null;
    }
    const row = await this.repo.updateMcpConnection(orgId, id, update);
    return this.toMcpView(row);
  }

  async deleteMcp(orgId: string, id: string): Promise<{ ok: true }> {
    await this.repo.deleteMcpConnection(orgId, id);
    return { ok: true };
  }

  /**
   * Probes an MCP HTTP/SSE endpoint with an `initialize` handshake and stores
   * the resulting status + advertised tools.
   */
  async testMcp(orgId: string, id: string): Promise<McpConnectionView> {
    const conn = await this.repo.findMcpConnection(orgId, id);
    if (!conn) throw new NotFoundException('MCP connection not found');
    if (conn.transport === 'stdio') {
      throw new BadRequestException('stdio connections can only be tested from the runner node');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (conn.auth_ciphertext) {
      headers.Authorization = `Bearer ${SecretCipher.decrypt(conn.auth_ciphertext)}`;
    }

    let status: 'connected' | 'error' = 'error';
    let lastError: string | null = null;
    let tools: Array<Record<string, unknown>> = conn.tools ?? [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(conn.endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'eva-core', version: '0.1.0' },
          },
        }),
      });
      clearTimeout(timer);

      if (res.ok) {
        status = 'connected';
        const body = (await res.json().catch(() => null)) as
          | { result?: { capabilities?: { tools?: Record<string, unknown> } } }
          | null;
        if (body?.result?.capabilities?.tools) {
          tools = [{ advertised: true }];
        }
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    const updated = await this.repo.updateMcpConnection(orgId, id, {
      status,
      tools,
      last_checked_at: new Date().toISOString(),
      last_error: lastError,
    });
    return this.toMcpView(updated);
  }

  private assertKnownProvider(kind: IntegrationKind, provider: string) {
    const known = kind === 'model' ? KNOWN_MODEL_PROVIDERS : KNOWN_CHANNEL_PROVIDERS;
    if (!known.includes(provider)) {
      throw new BadRequestException(`Unknown ${kind} provider: ${provider}`);
    }
  }

  private toView(row: OrgIntegration): IntegrationView {
    return {
      id: row.id,
      kind: row.kind,
      provider: row.provider,
      label: row.label,
      status: row.status,
      config: row.config ?? {},
      secret_hint: row.secret_hint,
      has_secret: Boolean(row.secret_ciphertext),
      updated_at: row.updated_at,
    };
  }

  private toMcpView(row: McpConnection): McpConnectionView {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      endpoint: row.endpoint,
      enabled: row.enabled,
      status: row.status,
      tools: row.tools ?? [],
      last_checked_at: row.last_checked_at,
      last_error: row.last_error,
      updated_at: row.updated_at,
    };
  }
}
