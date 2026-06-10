import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SecretCipher } from '../../common/secret-cipher';
import { IntegrationsRepository } from '../integrations.repository';
import { IntegrationsService } from '../integrations.service';
import { OrgIntegration } from '../integrations.types';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const now = new Date().toISOString();

function row(overrides: Partial<OrgIntegration> = {}): OrgIntegration {
  return {
    id: 'int-1',
    org_id: ORG,
    kind: 'model',
    provider: 'anthropic',
    label: null,
    status: 'active',
    config: {},
    secret_ciphertext: null,
    secret_hint: null,
    webhook_secret_ciphertext: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('SecretCipher', () => {
  beforeAll(() => {
    process.env.EVA_SECRETS_KEY = 'test-master-key';
  });

  it('round-trips a secret', () => {
    const cipher = SecretCipher.encrypt('sk-ant-very-secret-1234');
    expect(cipher).not.toContain('sk-ant');
    expect(SecretCipher.decrypt(cipher)).toBe('sk-ant-very-secret-1234');
  });

  it('produces a display hint without leaking the secret', () => {
    expect(SecretCipher.hint('sk-ant-very-secret-1234')).toBe('••••1234');
  });

  it('compares strings in constant time semantics', () => {
    expect(SecretCipher.safeEqual('abc', 'abc')).toBe(true);
    expect(SecretCipher.safeEqual('abc', 'abd')).toBe(false);
    expect(SecretCipher.safeEqual(undefined, 'abc')).toBe(false);
    expect(SecretCipher.safeEqual('abc', undefined)).toBe(false);
  });

  it('throws when the master key is missing', () => {
    const saved = process.env.EVA_SECRETS_KEY;
    delete process.env.EVA_SECRETS_KEY;
    expect(() => SecretCipher.encrypt('x')).toThrow('EVA_SECRETS_KEY');
    process.env.EVA_SECRETS_KEY = saved;
  });
});

describe('IntegrationsService', () => {
  let service: IntegrationsService;
  let repo: jest.Mocked<IntegrationsRepository>;

  beforeAll(() => {
    process.env.EVA_SECRETS_KEY = 'test-master-key';
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntegrationsService,
        {
          provide: IntegrationsRepository,
          useValue: {
            listIntegrations: jest.fn().mockResolvedValue([]),
            findIntegration: jest.fn().mockResolvedValue(null),
            upsertIntegration: jest.fn().mockImplementation(async (input) => row({
              kind: input.kind,
              provider: input.provider,
              status: input.status ?? 'active',
              config: input.config ?? {},
              secret_ciphertext: input.secretCiphertext ?? null,
              secret_hint: input.secretHint ?? null,
              webhook_secret_ciphertext: input.webhookSecretCiphertext ?? null,
            })),
            deleteIntegration: jest.fn().mockResolvedValue(undefined),
            listMcpConnections: jest.fn().mockResolvedValue([]),
            findMcpConnection: jest.fn().mockResolvedValue(null),
            createMcpConnection: jest.fn(),
            updateMcpConnection: jest.fn(),
            deleteMcpConnection: jest.fn().mockResolvedValue(undefined),
            listWearDevices: jest.fn().mockResolvedValue([]),
            createWearDevice: jest.fn().mockImplementation(async (input) => ({
              id: 'dev-1',
              org_id: input.orgId,
              user_id: input.userId,
              kind: 'wear',
              label: input.label,
              status: 'pending_pairing',
              created_at: now,
            })),
          } satisfies Partial<IntegrationsRepository>,
        },
      ],
    }).compile();

    service = module.get(IntegrationsService);
    repo = module.get(IntegrationsRepository);
  });

  it('encrypts the secret on upsert and never returns it', async () => {
    const view = await service.upsert({
      orgId: ORG,
      kind: 'model',
      provider: 'anthropic',
      secret: 'sk-ant-very-secret-1234',
    });

    const call = repo.upsertIntegration.mock.calls[0][0];
    expect(call.secretCiphertext).toBeDefined();
    expect(call.secretCiphertext).not.toContain('sk-ant');
    expect(call.secretHint).toBe('••••1234');

    expect(view).not.toHaveProperty('secret_ciphertext');
    expect(view.has_secret).toBe(true);
    expect(view.secret_hint).toBe('••••1234');
  });

  it('rotates a webhook secret when saving a telegram bot token', async () => {
    await service.upsert({
      orgId: ORG,
      kind: 'channel',
      provider: 'telegram',
      secret: '123456:bot-token-abcd',
    });

    const call = repo.upsertIntegration.mock.calls[0][0];
    expect(call.webhookSecretCiphertext).toBeDefined();
    expect(SecretCipher.decrypt(call.webhookSecretCiphertext!)).toHaveLength(48);
  });

  it('rejects unknown providers', async () => {
    await expect(service.upsert({ orgId: ORG, kind: 'model', provider: 'skynet', secret: 'x'.repeat(10) }))
      .rejects.toThrow(BadRequestException);
  });

  it('decrypts channel settings for internal consumers', async () => {
    repo.findIntegration.mockResolvedValue(row({
      kind: 'channel',
      provider: 'telegram',
      status: 'active',
      config: { allowed_user_ids: '11,22' },
      secret_ciphertext: SecretCipher.encrypt('bot-token'),
      webhook_secret_ciphertext: SecretCipher.encrypt('hook-secret'),
    }));

    const settings = await service.getChannelSettings(ORG, 'telegram');
    expect(settings).toEqual({
      status: 'active',
      config: { allowed_user_ids: '11,22' },
      secret: 'bot-token',
      webhookSecret: 'hook-secret',
    });
  });

  it('masks integrations in list views', async () => {
    repo.listIntegrations.mockResolvedValue([
      row({ secret_ciphertext: SecretCipher.encrypt('topsecret'), secret_hint: '••••cret' }),
    ]);

    const [view] = await service.list(ORG);
    expect(view.has_secret).toBe(true);
    expect(JSON.stringify(view)).not.toContain('topsecret');
  });

  it('returns the wear overview with the command catalog and defaults', async () => {
    const overview = await service.getWearOverview(ORG);

    expect(overview.status).toBe('disabled');
    expect(overview.commands.length).toBeGreaterThan(10);
    expect(overview.commands.some((command) => command.id === 'wear.open_app')).toBe(true);
    expect(overview.enabled_commands).toContain('agent.ask');
    expect(overview.enabled_commands).not.toContain('wear.open_app'); // L1 default-off
    expect(overview.endpoints.fast_path).toContain('/wear-fast-path/request');
  });

  it('registers a wear device and auto-enables the wear channel', async () => {
    const device = await service.registerWearDevice({ orgId: ORG, userId: 'user-1', label: 'Galaxy Watch' });

    expect(device.status).toBe('pending_pairing');
    expect(repo.upsertIntegration).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'channel',
      provider: 'wear',
      status: 'active',
    }));
  });

  it('validates a Google credential end-to-end via refresh token + Gmail profile', async () => {
    repo.findIntegration.mockResolvedValue(row({
      kind: 'credential',
      provider: 'google',
      secret_ciphertext: SecretCipher.encrypt(JSON.stringify({
        client_id: 'cid',
        client_secret: 'csecret',
        refresh_token: 'rtoken',
      })),
    }));

    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at-123', scope: 'https://www.googleapis.com/auth/gmail.readonly' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ emailAddress: 'raulisai97@gmail.com' }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await service.testGoogle(ORG);

    expect(result).toEqual({
      ok: true,
      email: 'raulisai97@gmail.com',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('refresh_token=rtoken');
  });

  it('reports a clear error when no Google credential is stored', async () => {
    repo.findIntegration.mockResolvedValue(null);
    const result = await service.testGoogle(ORG);
    expect(result).toEqual({ ok: false, error: 'No Google credential configured' });
  });

  // ── testGoogleFull ────────────────────────────────────────────────────────

  function googleCredRow() {
    return row({
      kind: 'credential',
      provider: 'google',
      secret_ciphertext: SecretCipher.encrypt(JSON.stringify({
        client_id: 'cid',
        client_secret: 'csecret',
        refresh_token: 'rtoken',
      })),
    });
  }

  it('testGoogleFull: all three services pass when scopes cover gmail+calendar+drive', async () => {
    repo.findIntegration.mockResolvedValue(googleCredRow());

    const SCOPES = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.readonly',
    ].join(' ');

    global.fetch = jest.fn()
      // token exchange
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'at-abc', scope: SCOPES }) })
      // gmail probe
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      // calendar probe
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      // drive probe
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      // gmail profile (to get email)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ emailAddress: 'raulisai97@gmail.com' }) }) as unknown as typeof fetch;

    const result = await service.testGoogleFull(ORG);

    expect(result.ok).toBe(true);
    expect(result.email).toBe('raulisai97@gmail.com');
    expect(result.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(result.services.gmail.ok).toBe(true);
    expect(result.services.calendar.ok).toBe(true);
    expect(result.services.drive.ok).toBe(true);
  });

  it('testGoogleFull: reports Unauthorized for calendar+drive when only gmail scope granted', async () => {
    repo.findIntegration.mockResolvedValue(googleCredRow());

    global.fetch = jest.fn()
      // token exchange — only gmail scope
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'at-xyz', scope: 'https://www.googleapis.com/auth/gmail.readonly' }) })
      // gmail probe — ok
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      // calendar probe — 403
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: 'Request had insufficient authentication scopes.' } }) })
      // drive probe — 403
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: 'Request had insufficient authentication scopes.' } }) })
      // gmail profile
      .mockResolvedValueOnce({ ok: true, json: async () => ({ emailAddress: 'raulisai97@gmail.com' }) }) as unknown as typeof fetch;

    const result = await service.testGoogleFull(ORG);

    expect(result.ok).toBe(false);
    expect(result.services.gmail.ok).toBe(true);
    expect(result.services.calendar.ok).toBe(false);
    expect(result.services.calendar.error).toContain('insufficient');
    expect(result.services.drive.ok).toBe(false);
  });

  it('testGoogleFull: returns error when refresh token is rejected (invalid_grant)', async () => {
    repo.findIntegration.mockResolvedValue(googleCredRow());

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      }) as unknown as typeof fetch;

    const result = await service.testGoogleFull(ORG);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('expired or revoked');
    expect(result.services.gmail.ok).toBe(false);
    expect(result.services.calendar.ok).toBe(false);
    expect(result.services.drive.ok).toBe(false);
  });

  it('testGoogleFull: reports error when no credential is stored', async () => {
    repo.findIntegration.mockResolvedValue(null);
    const result = await service.testGoogleFull(ORG);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No Google credential');
    expect(result.scopes).toEqual([]);
  });
});
