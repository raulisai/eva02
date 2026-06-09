import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  FastPathPolicy,
  FastPathUsageLog,
  FastPathTotals,
  WearSessionRecord,
  WearTokenRecord,
} from './wear-fast-path.types';

@Injectable()
export class WearFastPathRepository {
  private readonly logger = new Logger(WearFastPathRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async createSession(input: {
    orgId: string;
    userId: string;
    deviceId: string;
  }): Promise<WearSessionRecord> {
    const { data, error } = await this.db.admin
      .from('wear_sessions')
      .insert({
        org_id: input.orgId,
        user_id: input.userId,
        device_id: input.deviceId,
      })
      .select()
      .single();

    if (error) this.fail('wear_sessions.create', error);
    return data as WearSessionRecord;
  }

  async createToken(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    sessionId?: string | null;
    model: string;
    tokenHash: string;
    realtimeSessionId?: string | null;
    realtimeExpiresAt?: string | null;
    expiresAt: string;
  }): Promise<WearTokenRecord> {
    const { data, error } = await this.db.admin
      .from('wear_tokens')
      .insert({
        org_id: input.orgId,
        user_id: input.userId,
        device_id: input.deviceId,
        session_id: input.sessionId ?? null,
        model: input.model,
        token_hash: input.tokenHash,
        realtime_session_id: input.realtimeSessionId ?? null,
        realtime_expires_at: input.realtimeExpiresAt ?? null,
        expires_at: input.expiresAt,
      })
      .select()
      .single();

    if (error) this.fail('wear_tokens.create', error);
    return data as WearTokenRecord;
  }

  async findTokenById(tokenId: string, orgId: string): Promise<WearTokenRecord | null> {
    const { data, error } = await this.db.admin
      .from('wear_tokens')
      .select('*')
      .eq('id', tokenId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('wear_tokens.findById', error);
    return data as WearTokenRecord | null;
  }

  async markTokenUsed(tokenId: string, orgId: string): Promise<WearTokenRecord> {
    const { data, error } = await this.db.admin
      .from('wear_tokens')
      .update({ used: true })
      .eq('id', tokenId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) this.fail('wear_tokens.markUsed', error);
    return data as WearTokenRecord;
  }

  async getPolicy(orgId: string): Promise<FastPathPolicy | null> {
    const { data, error } = await this.db.admin
      .from('fast_path_policies')
      .select('*')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('fast_path_policies.get', error);
    return data as FastPathPolicy | null;
  }

  async upsertPolicy(orgId: string, patch: Partial<FastPathPolicy>): Promise<FastPathPolicy> {
    const { data, error } = await this.db.admin
      .from('fast_path_policies')
      .upsert({
        org_id: orgId,
        allowed: patch.allowed,
        disallowed: patch.disallowed,
        per_session_limit: patch.per_session_limit,
        per_day_limit: patch.per_day_limit,
        per_session_cost_limit_usd: patch.per_session_cost_limit_usd,
        per_day_cost_limit_usd: patch.per_day_cost_limit_usd,
      }, { onConflict: 'org_id' })
      .select()
      .single();

    if (error) this.fail('fast_path_policies.upsert', error);
    return data as FastPathPolicy;
  }

  async logUsage(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    sessionId?: string | null;
    requestType: string;
    model: string;
    latencyMs: number;
    tokensUsed: number;
    costUsd: number;
    fellBack: boolean;
    fallbackReason?: string | null;
  }): Promise<FastPathUsageLog> {
    const { data, error } = await this.db.admin
      .from('wear_fast_path_logs')
      .insert({
        org_id: input.orgId,
        user_id: input.userId,
        device_id: input.deviceId,
        session_id: input.sessionId ?? null,
        request_type: input.requestType,
        model: input.model,
        latency_ms: input.latencyMs,
        tokens_used: input.tokensUsed,
        cost_usd: input.costUsd,
        fell_back: input.fellBack,
        fallback_reason: input.fallbackReason ?? null,
      })
      .select()
      .single();

    if (error) this.fail('wear_fast_path_logs.insert', error);
    return data as FastPathUsageLog;
  }

  async getUsageTotals(input: {
    orgId: string;
    deviceId: string;
    sessionId?: string | null;
    since: string;
  }): Promise<FastPathTotals> {
    let sessionQuery = this.db.admin
      .from('wear_fast_path_logs')
      .select('tokens_used,cost_usd')
      .eq('org_id', input.orgId)
      .eq('device_id', input.deviceId);

    if (input.sessionId) {
      sessionQuery = sessionQuery.eq('session_id', input.sessionId);
    } else {
      sessionQuery = sessionQuery.is('session_id', null);
    }

    const dayQuery = this.db.admin
      .from('wear_fast_path_logs')
      .select('tokens_used,cost_usd')
      .eq('org_id', input.orgId)
      .eq('device_id', input.deviceId)
      .gte('created_at', input.since);

    const [sessionResult, dayResult] = await Promise.all([sessionQuery, dayQuery]);
    if (sessionResult.error) this.fail('wear_fast_path_logs.sessionTotals', sessionResult.error);
    if (dayResult.error) this.fail('wear_fast_path_logs.dayTotals', dayResult.error);

    const sum = (rows: Array<{ tokens_used?: number | null; cost_usd?: number | string | null }> = []) => ({
      tokens: rows.reduce((total, row) => total + Number(row.tokens_used ?? 0), 0),
      cost: rows.reduce((total, row) => total + Number(row.cost_usd ?? 0), 0),
    });
    const session = sum(sessionResult.data ?? []);
    const day = sum(dayResult.data ?? []);

    return {
      sessionCostUsd: session.cost,
      dayCostUsd: day.cost,
      sessionTokens: session.tokens,
      dayTokens: day.tokens,
    };
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Failed to write ${scope}`);
  }
}
