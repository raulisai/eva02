import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventBusService } from '../../events/event-bus.service';
import { CoreFallbackManager } from '../core-fallback.manager';
import { FastPathCostGuard } from '../fast-path-cost.guard';
import { FastPathPolicyManager } from '../fast-path-policy.manager';
import { WearRealtimeTokenProvider } from '../wear-realtime-token.provider';
import { WearFastPathRepository } from '../wear-fast-path.repository';
import { WearFastPathService } from '../wear-fast-path.service';
import {
  DEFAULT_FAST_PATH_POLICY,
  FastPathPolicy,
  WearSessionRecord,
  WearTokenRecord,
  WEAR_FAST_PATH_SCOPE,
} from '../wear-fast-path.types';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SESSION = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TOKEN = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const DEVICE = 'galaxy-watch-7';
const now = new Date().toISOString();

const defaultPolicy: FastPathPolicy = {
  id: 'policy-1',
  org_id: ORG,
  created_at: now,
  updated_at: now,
  ...DEFAULT_FAST_PATH_POLICY,
};

const session: WearSessionRecord = {
  id: SESSION,
  org_id: ORG,
  user_id: USER,
  device_id: DEVICE,
  started_at: now,
  ended_at: null,
};

function makeToken(overrides: Partial<WearTokenRecord> = {}): WearTokenRecord {
  return {
    id: TOKEN,
    org_id: ORG,
    user_id: USER,
    device_id: DEVICE,
    session_id: SESSION,
    scope: WEAR_FAST_PATH_SCOPE,
    model: 'gpt-realtime',
    max_tokens: 500,
    token_hash: 'a'.repeat(64),
    realtime_session_id: 'rt-1',
    realtime_expires_at: new Date(Date.now() + 300_000).toISOString(),
    tools: [],
    memory_access: false,
    actions_allowed: false,
    used: false,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    created_at: now,
    ...overrides,
  };
}

describe('WearFastPathService', () => {
  let service: WearFastPathService;
  let repo: jest.Mocked<WearFastPathRepository>;
  let tokenProvider: jest.Mocked<WearRealtimeTokenProvider>;
  let fallback: jest.Mocked<CoreFallbackManager>;
  let events: jest.Mocked<EventBusService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WearFastPathService,
        FastPathPolicyManager,
        FastPathCostGuard,
        {
          provide: WearFastPathRepository,
          useValue: {
            createSession: jest.fn().mockResolvedValue(session),
            createToken: jest.fn().mockImplementation(async (input) => makeToken({
              token_hash: input.tokenHash,
              expires_at: input.expiresAt,
              realtime_session_id: input.realtimeSessionId,
              realtime_expires_at: input.realtimeExpiresAt,
            })),
            findTokenById: jest.fn(),
            getPolicy: jest.fn().mockResolvedValue(defaultPolicy),
            getUsageTotals: jest.fn().mockResolvedValue({
              sessionCostUsd: 0,
              dayCostUsd: 0,
              sessionTokens: 0,
              dayTokens: 0,
            }),
            logUsage: jest.fn().mockImplementation(async (input) => ({
              id: 1,
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
              created_at: now,
            })),
            upsertPolicy: jest.fn(),
          } satisfies Partial<WearFastPathRepository>,
        },
        {
          provide: WearRealtimeTokenProvider,
          useValue: {
            createEphemeralKey: jest.fn().mockResolvedValue({
              value: 'ek_test_wear',
              expiresAt: Math.floor(Date.now() / 1000) + 300,
              sessionId: 'rt-1',
            }),
          } satisfies Partial<WearRealtimeTokenProvider>,
        },
        {
          provide: CoreFallbackManager,
          useValue: {
            forward: jest.fn().mockResolvedValue({
              id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
              title: 'Wear fallback: uber',
            }),
          } satisfies Partial<CoreFallbackManager>,
        },
        {
          provide: EventBusService,
          useValue: { publish: jest.fn().mockResolvedValue('0-1') } satisfies Partial<EventBusService>,
        },
      ],
    }).compile();

    service = module.get(WearFastPathService);
    repo = module.get(WearFastPathRepository);
    tokenProvider = module.get(WearRealtimeTokenProvider);
    fallback = module.get(CoreFallbackManager);
    events = module.get(EventBusService);
  });

  it('emits a 300s Wear Fast Path token with no tools, memory, or actions', async () => {
    const result = await service.issueToken({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
    });

    expect(tokenProvider.createEphemeralKey).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      model: 'gpt-realtime',
    }));
    expect(repo.createToken).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      sessionId: SESSION,
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(result).toEqual(expect.objectContaining({
      scope: 'wear_fast_path',
      expires_in: 300,
      max_tokens: 500,
      tools: [],
      memory_access: false,
      actions_allowed: false,
      ephemeral_key: 'ek_test_wear',
    }));
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'wear.token.created', orgId: ORG }));
  });

  it('rejects expired Wear tokens', async () => {
    repo.findTokenById.mockResolvedValue(makeToken({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));

    await expect(service.assertTokenUsable(TOKEN, ORG)).rejects.toThrow(ForbiddenException);
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'wear.token.expired', orgId: ORG }));
  });

  it('falls back to Core Path when request type is not allowed', async () => {
    const result = await service.handleRequest({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      requestType: 'uber',
      text: 'EVA, pide un Uber a casa',
      estimatedTokens: 20,
      estimatedCostUsd: 0.001,
    });

    expect(result.decision).toBe('core_fallback');
    expect(result.reason).toBe('request_type_or_text_disallowed');
    expect(fallback.forward).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      reason: 'request_type_or_text_disallowed',
    }));
    expect(repo.logUsage).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      fellBack: true,
      fallbackReason: 'request_type_or_text_disallowed',
    }));
  });

  it('falls back to Core Path for current-location questions even when simple_question is allowed', async () => {
    const metadata = {
      request_context: {
        source: 'wear_os',
        location: { source: 'wear_os', latitude: 19.4326, longitude: -99.1332, accuracy_m: 12 },
      },
    };

    const result = await service.handleRequest({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      sessionId: SESSION,
      requestType: 'simple_question',
      text: 'donde estoy en este momento?',
      estimatedTokens: 12,
      estimatedCostUsd: 0.001,
      metadata,
    });

    expect(result.decision).toBe('core_fallback');
    expect(result.reason).toBe('request_location_requires_core');
    expect(fallback.forward).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      reason: 'request_location_requires_core',
      metadata,
    }));
  });

  it('falls back to Core Path when session cost limit is exceeded', async () => {
    repo.getUsageTotals.mockResolvedValue({
      sessionCostUsd: 0.049,
      dayCostUsd: 0.049,
      sessionTokens: 30,
      dayTokens: 30,
    });

    const result = await service.handleRequest({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      sessionId: SESSION,
      requestType: 'simple_question',
      text: 'Que hora es en Tokio?',
      estimatedTokens: 20,
      estimatedCostUsd: 0.002,
    });

    expect(result.decision).toBe('core_fallback');
    expect(result.reason).toBe('session_cost_limit_exceeded');
    expect(fallback.forward).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'session_cost_limit_exceeded',
    }));
  });

  it('logs allowed Fast Path usage without invoking fallback', async () => {
    const result = await service.handleRequest({
      orgId: ORG,
      userId: USER,
      deviceId: DEVICE,
      sessionId: SESSION,
      requestType: 'simple_question',
      text: 'Que es EVA?',
      estimatedTokens: 10,
      estimatedCostUsd: 0.001,
    });

    expect(result.decision).toBe('fast_path');
    expect(fallback.forward).not.toHaveBeenCalled();
    expect(repo.logUsage).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      deviceId: DEVICE,
      fellBack: false,
    }));
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'wear.fast_path.completed', orgId: ORG }));
  });
});
