import { SecretCipher } from '../../common/secret-cipher';
import { DatabaseService } from '../../database/database.service';
import { SoulContextService } from '../soul-context.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function dbMock(row: Record<string, unknown> | null = null) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }),
    upsert: jest.fn().mockReturnThis(),
  };
  return {
    query,
    db: {
      admin: {
        from: jest.fn().mockReturnValue(query),
      },
    } as unknown as DatabaseService,
  };
}

describe('SoulContextService', () => {
  beforeEach(() => {
    process.env.EVA_SECRETS_KEY = 'test-secret-key';
  });

  it('prefers separated persona_context over legacy model_prefs', async () => {
    const { db } = dbMock({
      model_prefs: {
        personal_profile: { full_name: 'Legacy Name' },
        cowork_context: { projects: 'legacy projects' },
      },
      persona_context: {
        personal_profile: { full_name: 'Diego', current_location: 'CDMX' },
        cowork_context: { projects: 'EVA' },
      },
      goals: [],
    });
    const service = new SoulContextService(db);

    await expect(service.getAgentContext(ORG)).resolves.toMatchObject({
      personal_profile: { full_name: 'Diego', current_location: 'CDMX' },
      cowork_context: { projects: 'EVA' },
    });
  });

  it('normalizes relationship aliases for family/contact references', async () => {
    const { db } = dbMock({
      model_prefs: {},
      goals: [],
      persona_context: {
        relationship_map: [
          {
            id: 'mom',
            display_name: 'Maria Lopez',
            relation: 'Mamá',
            aliases: ['Madre'],
          },
        ],
      },
    });
    const service = new SoulContextService(db);

    const context = await service.getAgentContext(ORG);

    expect(context.persona_context.relationship_map?.[0]).toMatchObject({
      display_name: 'Maria Lopez',
      relation: 'mama',
      aliases: expect.arrayContaining(['mama', 'madre', 'mi mama']),
    });
  });

  it('decrypts private context only inside core service context', async () => {
    const private_context_ciphertext = SecretCipher.encrypt(JSON.stringify({
      text: 'Mi dato privado',
      updated_at: '2026-06-12T00:00:00.000Z',
    }));
    const { db } = dbMock({
      model_prefs: {},
      persona_context: {},
      goals: [],
      private_context_ciphertext,
      private_context_hint: '3 words stored encrypted',
    });
    const service = new SoulContextService(db);

    await expect(service.getAgentContext(ORG)).resolves.toMatchObject({
      private_context: { text: 'Mi dato privado' },
      private_context_hint: '3 words stored encrypted',
    });
  });

  it('stores private context encrypted with a safe hint', async () => {
    const { db, query } = dbMock();
    const service = new SoulContextService(db);

    await expect(service.savePrivateUserContext(ORG, 'uno dos tres cuatro')).resolves.toEqual({
      private_context_hint: '4 words stored encrypted',
    });

    const payload = query.upsert.mock.calls[0][0];
    expect(payload.org_id).toBe(ORG);
    expect(payload.private_context_hint).toBe('4 words stored encrypted');
    expect(payload.private_context_ciphertext).not.toContain('uno dos');
    expect(JSON.parse(SecretCipher.decrypt(payload.private_context_ciphertext)).text).toBe('uno dos tres cuatro');
  });
});
