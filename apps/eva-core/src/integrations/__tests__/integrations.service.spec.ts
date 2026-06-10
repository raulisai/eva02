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
});
