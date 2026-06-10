import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SecretCipher } from '../common/secret-cipher';
import { IntegrationsRepository } from './integrations.repository';
import {
  ChannelSettings,
  GoogleCredential,
  IntegrationKind,
  IntegrationView,
  McpConnection,
  McpConnectionView,
  OrgIntegration,
} from './integrations.types';
import { WEAR_COMMANDS, WEAR_DEFAULT_ENABLED } from './wear-catalog';

const KNOWN_MODEL_PROVIDERS = ['anthropic', 'openai', 'google', 'groq', 'openrouter'];
const KNOWN_CHANNEL_PROVIDERS = ['wear', 'telegram', 'discord', 'slack', 'whatsapp', 'email', 'sms'];
const KNOWN_CREDENTIAL_PROVIDERS = ['google', 'uber', 'github', 'amazon', 'custom'];

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

  /**
   * Live connectivity test for a model provider using the org-stored key
   * (env fallback). Returns round-trip latency so the dashboard can show
   * how fast the provider responds.
   */
  async testModelProvider(orgId: string, provider: string): Promise<{
    ok: boolean; latency_ms?: number; detail?: string; error?: string;
  }> {
    this.assertKnownProvider('model', provider);
    const key = (await this.getSecret(orgId, 'model', provider))
      ?? this.envKeyFor(provider);
    if (!key) return { ok: false, error: 'No API key configured for this provider' };

    const probes: Record<string, { url: string; headers: Record<string, string> }> = {
      anthropic:  { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
      openai:     { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } },
      google:     { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, headers: {} },
      groq:       { url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${key}` } },
      openrouter: { url: 'https://openrouter.ai/api/v1/models', headers: { Authorization: `Bearer ${key}` } },
    };
    const probe = probes[provider];

    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(probe.url, { headers: probe.headers, signal: controller.signal });
      clearTimeout(timer);
      const latency = Date.now() - started;

      if (!res.ok) {
        const body = await res.text();
        return { ok: false, latency_ms: latency, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const body = (await res.json().catch(() => ({}))) as { data?: unknown[]; models?: unknown[] };
      const count = body.data?.length ?? body.models?.length;
      return {
        ok: true,
        latency_ms: latency,
        detail: count !== undefined ? `${count} models available` : 'connected',
      };
    } catch (error) {
      return { ok: false, latency_ms: Date.now() - started, error: (error as Error).message };
    }
  }

  private envKeyFor(provider: string): string | undefined {
    const map: Record<string, string | undefined> = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      google: process.env.GOOGLE_API_KEY,
      groq: process.env.GROQ_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
    };
    return map[provider];
  }

  /**
   * Wear channel overview: registered devices, the full command catalog and
   * which commands the org has enabled — everything the watch app needs.
   */
  async getWearOverview(orgId: string) {
    const [integration, devices] = await Promise.all([
      this.repo.findIntegration(orgId, 'channel', 'wear'),
      this.repo.listWearDevices(orgId),
    ]);

    const enabled = Array.isArray(integration?.config?.['enabled_commands'])
      ? (integration!.config['enabled_commands'] as string[])
      : WEAR_DEFAULT_ENABLED;

    return {
      status: integration?.status ?? 'disabled',
      enabled_commands: enabled,
      commands: WEAR_COMMANDS,
      devices,
      endpoints: {
        websocket: '/eva (Socket.io, auth: { token })',
        fast_path: 'POST /wear-fast-path/request',
        pairing: 'POST /wear-fast-path/token { device_id }',
        directives: 'wear_directives table → delivered flag',
        consents: 'wear_sensor_consents (heart_rate, location, notifications)',
      },
    };
  }

  async registerWearDevice(input: { orgId: string; userId: string; label: string }) {
    const device = await this.repo.createWearDevice(input);
    // Enabling the channel on first device keeps the setup one-click.
    const integration = await this.repo.findIntegration(input.orgId, 'channel', 'wear');
    if (!integration) {
      await this.repo.upsertIntegration({
        orgId: input.orgId,
        kind: 'channel',
        provider: 'wear',
        status: 'active',
        config: { enabled_commands: WEAR_DEFAULT_ENABLED },
      });
    }
    return device;
  }

  /**
   * Validates the stored Google credential end-to-end: refresh-token grant,
   * then Gmail profile. Returns the connected account + granted scopes.
   */
  async testGoogle(orgId: string): Promise<{ ok: boolean; email?: string; scopes?: string[]; error?: string }> {
    const secret = await this.getSecret(orgId, 'credential', 'google');
    if (!secret) return { ok: false, error: 'No Google credential configured' };

    let credential: GoogleCredential;
    try {
      credential = JSON.parse(secret) as GoogleCredential;
    } catch {
      return { ok: false, error: 'Stored Google credential is not valid JSON' };
    }
    if (!credential.client_id || !credential.client_secret || !credential.refresh_token) {
      return { ok: false, error: 'Credential must include client_id, client_secret and refresh_token' };
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: credential.client_id,
          client_secret: credential.client_secret,
          refresh_token: credential.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const tokenBody = (await tokenRes.json()) as {
        access_token?: string; scope?: string; error_description?: string; error?: string;
      };
      if (!tokenBody.access_token) {
        return { ok: false, error: tokenBody.error_description ?? tokenBody.error ?? 'Token exchange failed' };
      }

      const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      });
      const profile = (await profileRes.json()) as { emailAddress?: string; error?: { message?: string } };
      if (!profileRes.ok) {
        return { ok: false, scopes: tokenBody.scope?.split(' '), error: profile.error?.message ?? 'Gmail profile failed' };
      }

      return { ok: true, email: profile.emailAddress, scopes: tokenBody.scope?.split(' ') ?? [] };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private assertKnownProvider(kind: IntegrationKind, provider: string) {
    const known = kind === 'model'
      ? KNOWN_MODEL_PROVIDERS
      : kind === 'channel' ? KNOWN_CHANNEL_PROVIDERS : KNOWN_CREDENTIAL_PROVIDERS;
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
