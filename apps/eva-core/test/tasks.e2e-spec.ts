/**
 * E2E tests for POST /tasks, GET /tasks/:id, state transitions.
 *
 * These tests wire the real NestJS application but replace:
 *  - DatabaseService → mock returning controlled data
 *  - EventBusService → jest mock (no Redis needed)
 *
 * Set SUPABASE_JWT_SECRET to the actual secret (or the default local one)
 * so the JWT guard accepts the test tokens we generate here.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { EventBusService } from '../src/events/event-bus.service';

const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ??
  'super-secret-jwt-token-with-at-least-32-characters-long';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_A = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const TASK_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeJwt(userId: string, orgId: string) {
  return jwt.sign(
    {
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      app_metadata: { org_id: orgId },
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const MOCK_TASK = {
  id: TASK_ID,
  org_id: ORG_A,
  created_by: USER_A,
  title: 'E2E task',
  description: null,
  status: 'pending',
  metadata: {},
  result: null,
  error: null,
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('Tasks (e2e)', () => {
  let app: INestApplication;
  let dbMock: jest.Mocked<DatabaseService>;
  let eventsMock: jest.Mocked<EventBusService>;

  const supabaseMock = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: MOCK_TASK, error: null }),
    maybeSingle: jest.fn().mockResolvedValue({ data: MOCK_TASK, error: null }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EventBusService)
      .useValue({
        publish: jest.fn().mockResolvedValue('0-1'),
        on: jest.fn(),
        startConsuming: jest.fn(),
      } satisfies Partial<EventBusService>)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    // Inject supabase mock into DatabaseService after init
    dbMock = app.get(DatabaseService);
    dbMock.setAdminClient(supabaseMock as any);

    // Also mock the org_members lookup inside strategy (returns a single org)
    supabaseMock.from.mockImplementation(() => supabaseMock);
    supabaseMock.eq.mockReturnThis();

    eventsMock = app.get(EventBusService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    supabaseMock.from.mockReturnThis();
    supabaseMock.select.mockReturnThis();
    supabaseMock.insert.mockReturnThis();
    supabaseMock.update.mockReturnThis();
    supabaseMock.eq.mockReturnThis();
    supabaseMock.single.mockResolvedValue({ data: MOCK_TASK, error: null });
    supabaseMock.maybeSingle.mockResolvedValue({ data: MOCK_TASK, error: null });
  });

  describe('GET /health', () => {
    it('returns 200 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('POST /tasks', () => {
    it('creates a task and returns 201', async () => {
      const token = makeJwt(USER_A, ORG_A);

      const res = await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'E2E task' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(TASK_ID);
      expect(res.body.status).toBe('pending');
    });

    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer())
        .post('/tasks')
        .send({ title: 'fail' });
      expect(res.status).toBe(401);
    });

    it('returns 400 for missing title', async () => {
      const token = makeJwt(USER_A, ORG_A);
      const res = await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /tasks/:id', () => {
    it('returns the task', async () => {
      const token = makeJwt(USER_A, ORG_A);
      const res = await request(app.getHttpServer())
        .get(`/tasks/${TASK_ID}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(TASK_ID);
    });

    it('returns 404 for unknown task', async () => {
      supabaseMock.maybeSingle.mockResolvedValue({ data: null, error: null });
      const token = makeJwt(USER_A, ORG_A);
      const unknownId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app.getHttpServer())
        .get(`/tasks/${unknownId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /tasks/:id/status', () => {
    it('transitions pending → planning', async () => {
      const planningTask = { ...MOCK_TASK, status: 'planning' };
      supabaseMock.single.mockResolvedValueOnce({ data: planningTask, error: null });

      const token = makeJwt(USER_A, ORG_A);
      const res = await request(app.getHttpServer())
        .patch(`/tasks/${TASK_ID}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'planning' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('planning');
    });

    it('rejects invalid transition (completed → running)', async () => {
      supabaseMock.maybeSingle.mockResolvedValue({
        data: { ...MOCK_TASK, status: 'completed' },
        error: null,
      });

      const token = makeJwt(USER_A, ORG_A);
      const res = await request(app.getHttpServer())
        .patch(`/tasks/${TASK_ID}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'running' });

      expect(res.status).toBe(400);
    });
  });

  describe('Event emission', () => {
    it('emits task.created on POST /tasks', async () => {
      const token = makeJwt(USER_A, ORG_A);
      await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'event test' });

      expect(eventsMock.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.created', orgId: ORG_A }),
      );
    });
  });
});
