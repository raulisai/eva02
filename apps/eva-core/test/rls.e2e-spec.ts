/**
 * RLS isolation test — verifies that org A cannot read tasks belonging to org B.
 *
 * Layer 1 (application): TasksRepository always appends .eq('org_id', orgId).
 *   → Tested here with the NestJS mock layer.
 *
 * Layer 2 (database): Supabase RLS policies (014_rls_policies.sql) enforce the
 *   same constraint at the Postgres level. To run the DB-layer test, point
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY at a real instance with migrations
 *   applied and set RLS_TEST=true.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { EventBusService } from '../src/events/event-bus.service';

const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ??
  'super-secret-jwt-token-with-at-least-32-characters-long';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const TASK_OF_ORG_B = 'b0000000-0000-0000-0000-000000000001';

function makeJwt(userId: string, orgId: string) {
  return jwt.sign(
    { sub: userId, role: 'authenticated', aud: 'authenticated', app_metadata: { org_id: orgId } },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('RLS isolation (cross-org access)', () => {
  let app: INestApplication;

  // Simulates the DB: org_b task is NOT visible to org_a.
  // eqCalls resets on each `from()` call to isolate query chains.
  const dbMockFactory = () => {
    let eqCalls: Array<{ col: string; val: unknown }> = [];

    const TASK_ROW = {
      id: TASK_OF_ORG_B,
      org_id: ORG_B,
      created_by: USER_B,
      title: 'Secret task of org B',
      status: 'pending',
      metadata: {},
      result: null,
      error: null,
      started_at: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const resolveForOrg = () => {
      const orgFilter = eqCalls.find((c) => c.col === 'org_id');
      // Return data only when the query's org_id filter matches the task's org
      if (!orgFilter || orgFilter.val !== ORG_B) {
        return { data: null, error: null };
      }
      return { data: TASK_ROW, error: null };
    };

    const proxy: any = {
      from: () => {
        eqCalls = [];   // fresh query chain
        return proxy;
      },
      select: () => proxy,
      insert: () => proxy,
      update: () => proxy,
      eq: (col: string, val: unknown) => {
        eqCalls.push({ col, val });
        return proxy;
      },
      single: async () => resolveForOrg(),
      maybeSingle: async () => resolveForOrg(),
      // SupabaseJwtStrategy validates tokens via admin.auth.getUser()
      auth: {
        getUser: async (token: string) => {
          const payload = jwt.decode(token) as { sub?: string; app_metadata?: Record<string, unknown> } | null;
          if (!payload?.sub) return { data: { user: null }, error: { message: 'invalid token' } };
          return { data: { user: { id: payload.sub, app_metadata: payload.app_metadata ?? {} } }, error: null };
        },
      },
    };

    return {
      admin: proxy,
      setAdminClient: jest.fn(),
      forUser: jest.fn(),
    };
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useFactory({ factory: dbMockFactory })
      .overrideProvider(EventBusService)
      .useValue({ publish: jest.fn().mockResolvedValue('0-1'), on: jest.fn() })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());

  it('org A cannot read a task that belongs to org B (application layer)', async () => {
    const tokenA = makeJwt(USER_A, ORG_A);

    // User A tries to GET org B's task
    const res = await request(app.getHttpServer())
      .get(`/tasks/${TASK_OF_ORG_B}`)
      .set('Authorization', `Bearer ${tokenA}`);

    // Must return 404 — not 403, to avoid leaking existence of the resource
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('org_id', ORG_B);
  });

  it('org B CAN read its own task', async () => {
    const tokenB = makeJwt(USER_B, ORG_B);

    const res = await request(app.getHttpServer())
      .get(`/tasks/${TASK_OF_ORG_B}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    expect(res.body.org_id).toBe(ORG_B);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Database-layer RLS test (requires real Supabase + migrations applied)
// Run with: RLS_TEST=true npm run test:e2e
// ────────────────────────────────────────────────────────────────────────────
const runDbTest = process.env.RLS_TEST === 'true';

(runDbTest ? describe : describe.skip)('RLS isolation (Supabase DB layer)', () => {
  it('supabase client with user-A JWT returns empty for org-B task', async () => {
    const { createClient } = await import('@supabase/supabase-js');

    const tokenA = makeJwt(USER_A, ORG_A);
    const clientA = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${tokenA}` } } },
    );

    const { data, error } = await clientA
      .from('tasks')
      .select('*')
      .eq('id', TASK_OF_ORG_B)
      .maybeSingle();

    // RLS must return nothing — not an error, just empty
    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});
