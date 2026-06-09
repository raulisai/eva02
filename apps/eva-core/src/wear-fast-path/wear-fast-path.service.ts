import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventBusService } from '../events/event-bus.service';
import { FastPathCostGuard } from './fast-path-cost.guard';
import { FastPathPolicyManager } from './fast-path-policy.manager';
import { CoreFallbackManager } from './core-fallback.manager';
import { WearRealtimeTokenProvider } from './wear-realtime-token.provider';
import { WearFastPathRepository } from './wear-fast-path.repository';
import {
  DEFAULT_FAST_PATH_POLICY,
  FastPathDecision,
  FastPathPolicy,
  WEAR_DEFAULT_MODEL,
  WEAR_FAST_PATH_SCOPE,
  WEAR_MAX_TOKENS,
  WEAR_TOKEN_TTL_SECONDS,
} from './wear-fast-path.types';

@Injectable()
export class WearFastPathService {
  constructor(
    private readonly repo: WearFastPathRepository,
    private readonly realtimeTokens: WearRealtimeTokenProvider,
    private readonly policies: FastPathPolicyManager,
    private readonly costGuard: FastPathCostGuard,
    private readonly fallback: CoreFallbackManager,
    private readonly events: EventBusService,
  ) {}

  async issueToken(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    model?: string;
  }) {
    const model = input.model ?? WEAR_DEFAULT_MODEL;
    const session = await this.repo.createSession({
      orgId: input.orgId,
      userId: input.userId,
      deviceId: input.deviceId,
    });
    const ephemeral = await this.realtimeTokens.createEphemeralKey({
      orgId: input.orgId,
      userId: input.userId,
      deviceId: input.deviceId,
      model,
    });

    const expiresAt = new Date(Date.now() + WEAR_TOKEN_TTL_SECONDS * 1000).toISOString();
    const token = await this.repo.createToken({
      orgId: input.orgId,
      userId: input.userId,
      deviceId: input.deviceId,
      sessionId: session.id,
      model,
      tokenHash: this.hashToken(ephemeral.value),
      realtimeSessionId: ephemeral.sessionId,
      realtimeExpiresAt: new Date(ephemeral.expiresAt * 1000).toISOString(),
      expiresAt,
    });

    await this.events.publish({
      type: 'wear.token.created',
      orgId: input.orgId,
      payload: {
        tokenId: token.id,
        sessionId: session.id,
        deviceId: input.deviceId,
        expiresAt,
      },
    });

    return {
      token_id: token.id,
      session_id: session.id,
      scope: WEAR_FAST_PATH_SCOPE,
      expires_in: WEAR_TOKEN_TTL_SECONDS,
      expires_at: expiresAt,
      max_tokens: WEAR_MAX_TOKENS,
      model,
      tools: [],
      memory_access: false,
      actions_allowed: false,
      ephemeral_key: ephemeral.value,
      realtime_session_id: ephemeral.sessionId,
    };
  }

  async assertTokenUsable(tokenId: string, orgId: string) {
    const token = await this.repo.findTokenById(tokenId, orgId);
    if (!token) throw new NotFoundException(`Wear token ${tokenId} not found`);
    if (token.scope !== WEAR_FAST_PATH_SCOPE) throw new ForbiddenException('Invalid wear token scope');
    if (token.used) throw new ForbiddenException('Wear token has already been used');
    if (new Date(token.expires_at).getTime() <= Date.now()) {
      await this.events.publish({
        type: 'wear.token.expired',
        orgId,
        payload: { tokenId },
      });
      throw new ForbiddenException('Wear token is expired');
    }
    if (token.actions_allowed || token.memory_access || token.tools.length > 0 || token.max_tokens > WEAR_MAX_TOKENS) {
      throw new ForbiddenException('Wear token exceeds Fast Path capability limits');
    }
    return token;
  }

  async handleRequest(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    sessionId?: string;
    requestType: string;
    text: string;
    model?: string;
    estimatedTokens?: number;
    estimatedCostUsd?: number;
    latencyMs?: number;
    metadata?: Record<string, unknown>;
  }) {
    const policy = await this.getPolicy(input.orgId);
    const model = input.model ?? WEAR_DEFAULT_MODEL;
    const estimatedTokens = Math.min(input.estimatedTokens ?? this.estimateTokens(input.text), WEAR_MAX_TOKENS);
    const estimatedCostUsd = input.estimatedCostUsd ?? this.estimateCostUsd(estimatedTokens);
    const latencyMs = input.latencyMs ?? 0;

    await this.events.publish({
      type: 'wear.fast_path.started',
      orgId: input.orgId,
      payload: {
        deviceId: input.deviceId,
        sessionId: input.sessionId ?? null,
        requestType: input.requestType,
      },
    });

    const policyDecision = this.policies.evaluate({
      policy,
      requestType: input.requestType,
      text: input.text,
    });

    if (!policyDecision.allowed) {
      return this.fallbackAndLog({
        ...input,
        model,
        latencyMs,
        tokensUsed: estimatedTokens,
        costUsd: estimatedCostUsd,
        reason: policyDecision.reason,
      });
    }

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const totals = await this.repo.getUsageTotals({
      orgId: input.orgId,
      deviceId: input.deviceId,
      sessionId: input.sessionId ?? null,
      since: since.toISOString(),
    });
    const costDecision = this.costGuard.evaluate({
      policy,
      totals,
      estimatedTokens,
      estimatedCostUsd,
    });

    if (!costDecision.allowed) {
      return this.fallbackAndLog({
        ...input,
        model,
        latencyMs,
        tokensUsed: estimatedTokens,
        costUsd: estimatedCostUsd,
        reason: costDecision.reason,
      });
    }

    const log = await this.repo.logUsage({
      orgId: input.orgId,
      userId: input.userId,
      deviceId: input.deviceId,
      sessionId: input.sessionId ?? null,
      requestType: input.requestType,
      model,
      latencyMs,
      tokensUsed: estimatedTokens,
      costUsd: estimatedCostUsd,
      fellBack: false,
    });

    await this.events.publish({
      type: 'wear.fast_path.completed',
      orgId: input.orgId,
      payload: {
        logId: log.id,
        deviceId: input.deviceId,
        requestType: input.requestType,
      },
    });

    return {
      decision: 'fast_path' as FastPathDecision,
      reason: 'allowed_by_policy_and_cost_guard',
      log,
      response_constraints: {
        max_tokens: WEAR_MAX_TOKENS,
        tools: [],
        memory_access: false,
        actions_allowed: false,
      },
    };
  }

  async getPolicy(orgId: string): Promise<FastPathPolicy> {
    return (await this.repo.getPolicy(orgId)) ?? this.policies.defaultPolicy(orgId);
  }

  async updatePolicy(orgId: string, patch: Partial<FastPathPolicy>) {
    const merged = {
      ...DEFAULT_FAST_PATH_POLICY,
      ...patch,
    };
    return this.repo.upsertPolicy(orgId, merged);
  }

  private async fallbackAndLog(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    sessionId?: string;
    requestType: string;
    text: string;
    model: string;
    latencyMs: number;
    tokensUsed: number;
    costUsd: number;
    reason: string;
    metadata?: Record<string, unknown>;
  }) {
    const task = await this.fallback.forward(input);
    const log = await this.repo.logUsage({
      orgId: input.orgId,
      userId: input.userId,
      deviceId: input.deviceId,
      sessionId: input.sessionId ?? null,
      requestType: input.requestType,
      model: input.model,
      latencyMs: input.latencyMs,
      tokensUsed: input.tokensUsed,
      costUsd: input.costUsd,
      fellBack: true,
      fallbackReason: input.reason,
    });

    return {
      decision: 'core_fallback' as FastPathDecision,
      reason: input.reason,
      task,
      log,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private estimateTokens(text: string): number {
    return Math.min(Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.4) || 1, WEAR_MAX_TOKENS);
  }

  private estimateCostUsd(tokens: number): number {
    return Number((tokens * 0.0000006).toFixed(8));
  }
}
