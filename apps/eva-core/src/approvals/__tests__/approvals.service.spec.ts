import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventBusService } from '../../events/event-bus.service';
import { CommunicationService } from '../../communication/communication.service';
import { ApprovalClassifierService } from '../approval-classifier.service';
import { hashApprovalAction } from '../approval-hash';
import { Approval } from '../approval.types';
import { ApprovalsRepository } from '../approvals.repository';
import { ApprovalsService } from '../approvals.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TASK = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const APPROVAL = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const now = new Date().toISOString();

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  const expires_at = overrides.expires_at ?? new Date(Date.now() + 60_000).toISOString();
  const payload = overrides.payload ?? { amount: 10, currency: 'USD' };
  const action_type = overrides.action_type ?? 'payment.charge';
  const nonce = overrides.nonce ?? 'nonce-1';
  return {
    id: APPROVAL,
    org_id: ORG,
    task_id: TASK,
    level: 2,
    action_type,
    action_hash: hashApprovalAction({ actionType: action_type, payload, nonce, expiresAt: expires_at }),
    nonce,
    status: 'pending',
    payload,
    summary: null,
    screenshot_ref: null,
    source: 'core_path',
    requested_by: USER_A,
    reviewed_by: null,
    reviewed_by_2: null,
    reviewed_at: null,
    nonce_used_at: null,
    expires_at,
    created_at: now,
    ...overrides,
  };
}

describe('ApprovalsService', () => {
  let service: ApprovalsService;
  let repo: jest.Mocked<ApprovalsRepository>;
  let events: jest.Mocked<EventBusService>;
  let communication: jest.Mocked<CommunicationService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalsService,
        ApprovalClassifierService,
        {
          provide: ApprovalsRepository,
          useValue: {
            create: jest.fn(),
            findByIdOrThrow: jest.fn(),
            update: jest.fn(),
            markStatus: jest.fn(),
          } satisfies Partial<ApprovalsRepository>,
        },
        {
          provide: EventBusService,
          useValue: { publish: jest.fn().mockResolvedValue('0-1') } satisfies Partial<EventBusService>,
        },
        {
          provide: CommunicationService,
          useValue: { sendApprovalRequest: jest.fn().mockResolvedValue({}) } satisfies Partial<CommunicationService>,
        },
      ],
    }).compile();

    service = module.get(ApprovalsService);
    repo = module.get(ApprovalsRepository);
    events = module.get(EventBusService);
    communication = module.get(CommunicationService);
  });

  it('blocks sensitive actions requested from Fast Path', async () => {
    await expect(service.request({
      task_id: TASK,
      action_type: 'deploy.production',
      payload: { target: 'prod' },
      source: 'fast_path',
    }, ORG, USER_A)).rejects.toThrow(ForbiddenException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects TOCTOU payload changes during executor validation', async () => {
    const approved = makeApproval({ status: 'approved' });
    repo.findByIdOrThrow.mockResolvedValue(approved);

    await expect(
      service.validateForExecution(APPROVAL, ORG, { amount: 999, currency: 'USD' }),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects expired approvals and marks them expired', async () => {
    const expired = makeApproval({
      status: 'approved',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    repo.findByIdOrThrow.mockResolvedValue(expired);
    repo.markStatus.mockResolvedValue({ ...expired, status: 'expired' });

    await expect(
      service.validateForExecution(APPROVAL, ORG, expired.payload),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.markStatus).toHaveBeenCalledWith(APPROVAL, ORG, 'expired');
  });

  it('rejects approval replay after nonce was used', async () => {
    const approved = makeApproval({ status: 'approved', nonce_used_at: now });
    repo.findByIdOrThrow.mockResolvedValue(approved);

    await expect(
      service.validateForExecution(APPROVAL, ORG, approved.payload),
    ).rejects.toThrow(ConflictException);
  });

  it('requires two distinct approvers for level 3', async () => {
    const pending = makeApproval({ level: 3 });
    repo.findByIdOrThrow.mockResolvedValueOnce(pending);
    repo.update.mockResolvedValueOnce({ ...pending, reviewed_by: USER_A });

    const first = await service.approve(APPROVAL, ORG, USER_A);
    expect(first.completed).toBe(false);
    expect(first.approval.status).toBe('pending');

    repo.findByIdOrThrow.mockResolvedValueOnce({ ...pending, reviewed_by: USER_A });
    await expect(service.approve(APPROVAL, ORG, USER_A)).rejects.toThrow(ConflictException);

    repo.findByIdOrThrow.mockResolvedValueOnce({ ...pending, reviewed_by: USER_A });
    repo.update.mockResolvedValueOnce({
      ...pending,
      reviewed_by: USER_A,
      reviewed_by_2: USER_B,
      status: 'approved',
    });
    const second = await service.approve(APPROVAL, ORG, USER_B);
    expect(second.completed).toBe(true);
    expect(second.approval.status).toBe('approved');
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.resolved' }));
  });

  it('notifies Communication Hub for pending approvals', async () => {
    const approval = makeApproval({ level: 1, status: 'pending' });
    repo.create.mockResolvedValue(approval);

    await service.request({
      task_id: TASK,
      action_type: 'telegram.send_message',
      payload: { chat_id: '100', text: 'hola' },
      level: 1,
    }, ORG, USER_A);

    expect(communication.sendApprovalRequest).toHaveBeenCalledWith(approval, ORG);
  });

  it('rejects resolving non-pending approvals', async () => {
    repo.findByIdOrThrow.mockResolvedValue(makeApproval({ status: 'approved' }));
    await expect(service.reject(APPROVAL, ORG, USER_A)).rejects.toThrow(BadRequestException);
  });

  it('supports editable approvals: updates payload and recomputes action_hash', async () => {
    const pending = makeApproval({ level: 1 });
    repo.findByIdOrThrow.mockResolvedValueOnce(pending);
    repo.update.mockImplementationOnce((id, org, update) => Promise.resolve({
      ...pending,
      ...update,
    }) as any);

    const updatedPayload = { amount: 50, currency: 'USD' };
    const res = await service.approve(APPROVAL, ORG, USER_A, updatedPayload);

    expect(res.completed).toBe(true);
    expect(res.approval.payload).toEqual(updatedPayload);
    expect(res.approval.action_hash).not.toBe(pending.action_hash);
  });

  it('escalates level and requires Level 3 multi-approver workflow if updatedPayload increases risk', async () => {
    const pending = makeApproval({ level: 1, action_type: 'payment.charge', payload: { amount: 10 } });
    repo.findByIdOrThrow.mockResolvedValueOnce(pending);
    repo.update.mockImplementationOnce((id, org, update) => Promise.resolve({
      ...pending,
      ...update,
    }) as any);

    // Escalates from amount=10 (level 1) to amount=25000 (level 3)
    const escalatedPayload = { amount: 25000 };
    const res = await service.approve(APPROVAL, ORG, USER_A, escalatedPayload);

    expect(res.completed).toBe(false); // level 3 needs 2 approvers
    expect(res.approval.level).toBe(3);
    expect(res.approval.payload).toEqual(escalatedPayload);
  });
});
