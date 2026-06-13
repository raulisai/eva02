import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { EventBusService } from '../events/event-bus.service';
import { Task } from './task.types';

const MOCK_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MOCK_USER_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const MOCK_TASK_ID = 'cccccccc-0000-0000-0000-000000000001';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: MOCK_TASK_ID,
    org_id: MOCK_ORG_ID,
    created_by: MOCK_USER_ID,
    title: 'Test task',
    description: null,
    status: 'pending',
    metadata: {},
    result: null,
    error: null,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('TasksService', () => {
  let service: TasksService;
  let repo: jest.Mocked<TasksRepository>;
  let events: jest.Mocked<EventBusService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        {
          provide: TasksRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            findByIdOrThrow: jest.fn(),
            updateStatus: jest.fn(),
          } satisfies Partial<TasksRepository>,
        },
        {
          provide: EventBusService,
          useValue: {
            publish: jest.fn().mockResolvedValue('0-1'),
          } satisfies Partial<EventBusService>,
        },
      ],
    }).compile();

    service = module.get(TasksService);
    repo = module.get(TasksRepository);
    events = module.get(EventBusService);
  });

  // ── createTask ────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task and emits task.created', async () => {
      const task = makeTask();
      repo.create.mockResolvedValue(task);

      const result = await service.createTask(
        { title: 'Test task' },
        MOCK_USER_ID,
        MOCK_ORG_ID,
      );

      expect(repo.create).toHaveBeenCalledWith(
        { title: 'Test task' },
        MOCK_USER_ID,
        MOCK_ORG_ID,
      );
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.created', orgId: MOCK_ORG_ID }),
      );
      expect(result.id).toBe(MOCK_TASK_ID);
    });
  });

  // ── getTask ───────────────────────────────────────────────────────────────

  describe('getTask', () => {
    it('returns task when found', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask());
      const task = await service.getTask(MOCK_TASK_ID, MOCK_ORG_ID);
      expect(task.id).toBe(MOCK_TASK_ID);
    });

    it('throws NotFoundException when not found', async () => {
      repo.findByIdOrThrow.mockRejectedValue(new NotFoundException());
      await expect(service.getTask('nonexistent', MOCK_ORG_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── transition ────────────────────────────────────────────────────────────

  describe('transition', () => {
    it('pending → planning is valid', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'pending' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'planning' }));

      const result = await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'planning');
      expect(result.status).toBe('planning');
      // No event expected for planning transition
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('pending → running emits task.started', async () => {
      // pending → planning → running (two steps); for direct test, bypass with planning seed
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'planning' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'running' }));

      await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'running');

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.started' }),
      );
    });

    it('running → completed emits task.completed', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'running' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'completed' }));

      await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'completed');

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.completed' }),
      );
    });

    it('running → failed emits task.failed', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'running' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'failed' }));

      await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'failed');

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.failed' }),
      );
    });

    it('running → waiting_for_input emits task.waiting_input', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'running' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'waiting_for_input' }));

      await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'waiting_for_input');

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.waiting_input' }),
      );
    });

    it('rejects invalid transition (completed → running)', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'completed' }));

      await expect(
        service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'running'),
      ).rejects.toThrow(BadRequestException);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('allows transition from failed to pending and resets fields', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'failed', started_at: 'yes', completed_at: 'yes', error: 'error text' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'pending', title: 'Test task' }));

      const result = await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'pending');
      expect(result.status).toBe('pending');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        MOCK_TASK_ID,
        MOCK_ORG_ID,
        'pending',
        { started_at: null, completed_at: null, error: null, result: null }
      );
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.created', orgId: MOCK_ORG_ID, taskId: MOCK_TASK_ID })
      );
    });

    it('allows transition from cancelled to pending and resets fields', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'cancelled', started_at: 'yes', completed_at: 'yes' }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'pending', title: 'Test task' }));

      const result = await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'pending');
      expect(result.status).toBe('pending');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        MOCK_TASK_ID,
        MOCK_ORG_ID,
        'pending',
        { started_at: null, completed_at: null, error: null, result: null }
      );
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.created', orgId: MOCK_ORG_ID, taskId: MOCK_TASK_ID })
      );
    });

    it('allows transition from completed to pending and resets fields', async () => {
      repo.findByIdOrThrow.mockResolvedValue(makeTask({ status: 'completed', started_at: 'yes', completed_at: 'yes', result: { text: 'ok' } }));
      repo.updateStatus.mockResolvedValue(makeTask({ status: 'pending', title: 'Test task' }));

      const result = await service.transition(MOCK_TASK_ID, MOCK_ORG_ID, 'pending');
      expect(result.status).toBe('pending');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        MOCK_TASK_ID,
        MOCK_ORG_ID,
        'pending',
        { started_at: null, completed_at: null, error: null, result: null }
      );
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.created', orgId: MOCK_ORG_ID, taskId: MOCK_TASK_ID })
      );
    });
  });
});
