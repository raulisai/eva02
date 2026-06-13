import { SecretCipher } from '../../common/secret-cipher';
import { DatabaseService } from '../../database/database.service';
import { ProfileFactsService } from '../profile-facts.service';
import { SensitivityClassifierService } from '../sensitivity-classifier.service';
import { SoulContextService } from '../soul-context.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function dbMock() {
  const inserts: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  const rows: Record<string, Record<string, unknown> | null> = {};
  const makeQuery = (table: string) => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: jest.fn().mockImplementation(async () => ({ data: rows[table] ?? null, error: null })),
      single: jest.fn().mockImplementation(async () => ({ data: inserts[table]?.at(-1) ?? rows[table] ?? {}, error: null })),
      insert: jest.fn().mockImplementation((payload) => {
        inserts[table] = [...(inserts[table] ?? []), payload];
        return query;
      }),
      update: jest.fn().mockImplementation((payload) => {
        updates[table] = [...(updates[table] ?? []), payload];
        return query;
      }),
    };
    return query;
  };
  return {
    inserts,
    updates,
    rows,
    db: {
      admin: {
        from: jest.fn((table: string) => makeQuery(table)),
      },
    } as unknown as DatabaseService,
  };
}

describe('ProfileFactsService', () => {
  beforeEach(() => {
    process.env.EVA_SECRETS_KEY = 'test-profile-secret';
  });

  it('stores sensitive facts as masked rows plus encrypted private items', async () => {
    const { db, inserts } = dbMock();
    const soul = {
      getPersonalProfile: jest.fn(),
      updatePersonalProfile: jest.fn(),
    } as unknown as SoulContextService;
    const service = new ProfileFactsService(db, new SensitivityClassifierService(), soul);

    await service.applyFact(ORG, USER, {
      type: 'note',
      payload: { content: 'mi password es abc123', confidence: 0.95 },
      source: 'digester',
    });

    expect(inserts.profile_notes[0]).toMatchObject({
      org_id: ORG,
      content: 'Credencial privada',
      sensitivity: 'sensitive',
      source: 'digester',
      created_by: USER,
    });
    const privateItem = inserts.profile_private_items[0] as Record<string, string>;
    expect(privateItem.org_id).toBe(ORG);
    expect(privateItem.ciphertext).not.toContain('abc123');
    expect(SecretCipher.decrypt(privateItem.ciphertext)).toContain('abc123');
  });

  it('sends low-confidence facts to the suggestion inbox', async () => {
    const { db, inserts } = dbMock();
    const service = new ProfileFactsService(
      db,
      new SensitivityClassifierService(),
      {} as SoulContextService,
    );

    await service.applyFact(ORG, USER, {
      type: 'todo',
      payload: { title: 'Comprar medicina', confidence: 0.4 },
      source: 'digester',
    });

    expect(inserts.profile_suggestions[0]).toMatchObject({
      org_id: ORG,
      fact_type: 'todo',
      reason: 'needs_user_confirmation',
    });
    expect(inserts.profile_todos).toBeUndefined();
  });

  it('reveals private items only through core and writes an access log', async () => {
    const { db, rows, inserts } = dbMock();
    rows.profile_private_items = {
      id: 'private-1',
      hint: '2 words stored encrypted',
      ciphertext: SecretCipher.encrypt(JSON.stringify({ value: 'dato privado' })),
    };
    const service = new ProfileFactsService(
      db,
      new SensitivityClassifierService(),
      {} as SoulContextService,
    );

    await expect(service.revealPrivateItem(ORG, USER, 'private-1', 'manual check')).resolves.toEqual({
      id: 'private-1',
      value: 'dato privado',
      hint: '2 words stored encrypted',
    });
    expect(inserts.profile_private_access_logs[0]).toMatchObject({
      org_id: ORG,
      private_item_id: 'private-1',
      revealed_by: USER,
      reason: 'manual check',
    });
  });
});
