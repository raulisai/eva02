import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  IntegrationKind,
  IntegrationStatus,
  McpConnection,
  McpStatus,
  OrgIntegration,
} from './integrations.types';

@Injectable()
export class IntegrationsRepository {
  private readonly logger = new Logger(IntegrationsRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async listIntegrations(orgId: string, kind?: IntegrationKind): Promise<OrgIntegration[]> {
    let query = this.db.admin
      .from('org_integrations')
      .select('*')
      .eq('org_id', orgId)
      .order('provider');
    if (kind) query = query.eq('kind', kind);

    const { data, error } = await query;
    if (error) this.fail('org_integrations.list', error);
    return (data ?? []) as OrgIntegration[];
  }

  async findIntegration(orgId: string, kind: IntegrationKind, provider: string): Promise<OrgIntegration | null> {
    const { data, error } = await this.db.admin
      .from('org_integrations')
      .select('*')
      .eq('org_id', orgId)
      .eq('kind', kind)
      .eq('provider', provider)
      .maybeSingle();

    if (error) this.fail('org_integrations.find', error);
    return data as OrgIntegration | null;
  }

  async upsertIntegration(input: {
    orgId: string;
    kind: IntegrationKind;
    provider: string;
    label?: string | null;
    status?: IntegrationStatus;
    config?: Record<string, unknown>;
    secretCiphertext?: string | null;
    secretHint?: string | null;
    webhookSecretCiphertext?: string | null;
  }): Promise<OrgIntegration> {
    const existing = await this.findIntegration(input.orgId, input.kind, input.provider);

    const row: Record<string, unknown> = {
      org_id: input.orgId,
      kind: input.kind,
      provider: input.provider,
      label: input.label ?? existing?.label ?? null,
      status: input.status ?? existing?.status ?? 'active',
      config: { ...(existing?.config ?? {}), ...(input.config ?? {}) },
      secret_ciphertext: input.secretCiphertext !== undefined ? input.secretCiphertext : existing?.secret_ciphertext ?? null,
      secret_hint: input.secretHint !== undefined ? input.secretHint : existing?.secret_hint ?? null,
      webhook_secret_ciphertext:
        input.webhookSecretCiphertext !== undefined
          ? input.webhookSecretCiphertext
          : existing?.webhook_secret_ciphertext ?? null,
    };

    const { data, error } = await this.db.admin
      .from('org_integrations')
      .upsert(row, { onConflict: 'org_id,kind,provider' })
      .select()
      .single();

    if (error) this.fail('org_integrations.upsert', error);
    return data as OrgIntegration;
  }

  async deleteIntegration(orgId: string, kind: IntegrationKind, provider: string): Promise<void> {
    const { error } = await this.db.admin
      .from('org_integrations')
      .delete()
      .eq('org_id', orgId)
      .eq('kind', kind)
      .eq('provider', provider);

    if (error) this.fail('org_integrations.delete', error);
  }

  async listMcpConnections(orgId: string): Promise<McpConnection[]> {
    const { data, error } = await this.db.admin
      .from('mcp_connections')
      .select('*')
      .eq('org_id', orgId)
      .order('name');

    if (error) this.fail('mcp_connections.list', error);
    return (data ?? []) as McpConnection[];
  }

  async findMcpConnection(orgId: string, id: string): Promise<McpConnection | null> {
    const { data, error } = await this.db.admin
      .from('mcp_connections')
      .select('*')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();

    if (error) this.fail('mcp_connections.find', error);
    return data as McpConnection | null;
  }

  async createMcpConnection(input: {
    orgId: string;
    name: string;
    transport: string;
    endpoint: string;
    enabled: boolean;
    authCiphertext: string | null;
  }): Promise<McpConnection> {
    const { data, error } = await this.db.admin
      .from('mcp_connections')
      .upsert({
        org_id: input.orgId,
        name: input.name,
        transport: input.transport,
        endpoint: input.endpoint,
        enabled: input.enabled,
        auth_ciphertext: input.authCiphertext,
      }, { onConflict: 'org_id,name' })
      .select()
      .single();

    if (error) this.fail('mcp_connections.create', error);
    return data as McpConnection;
  }

  async updateMcpConnection(
    orgId: string,
    id: string,
    patch: Partial<{
      enabled: boolean;
      endpoint: string;
      auth_ciphertext: string | null;
      status: McpStatus;
      tools: Array<Record<string, unknown>>;
      last_checked_at: string | null;
      last_error: string | null;
    }>,
  ): Promise<McpConnection> {
    const { data, error } = await this.db.admin
      .from('mcp_connections')
      .update(patch)
      .eq('org_id', orgId)
      .eq('id', id)
      .select()
      .single();

    if (error) this.fail('mcp_connections.update', error);
    return data as McpConnection;
  }

  async deleteMcpConnection(orgId: string, id: string): Promise<void> {
    const { error } = await this.db.admin
      .from('mcp_connections')
      .delete()
      .eq('org_id', orgId)
      .eq('id', id);

    if (error) this.fail('mcp_connections.delete', error);
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Failed integrations operation: ${scope}`);
  }
}
