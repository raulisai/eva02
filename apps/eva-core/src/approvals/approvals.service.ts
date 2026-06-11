import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventBusService } from '../events/event-bus.service';
import { CommunicationService } from '../communication/communication.service';
import { ApprovalClassifierService } from './approval-classifier.service';
import { hashApprovalAction } from './approval-hash';
import { ApprovalsRepository } from './approvals.repository';
import { Approval, ApprovalDecision } from './approval.types';
import { RequestApprovalDto } from './dto/request-approval.dto';

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly repo: ApprovalsRepository,
    private readonly classifier: ApprovalClassifierService,
    private readonly events: EventBusService,
    @Optional() private readonly communication?: CommunicationService,
  ) {}

  async request(dto: RequestApprovalDto, orgId: string, userId: string): Promise<Approval> {
    const source = dto.source ?? 'core_path';
    const classified = this.classifier.classify(dto.action_type, dto.payload);
    const level = dto.level ?? classified;

    if (source === 'fast_path' && level > 0) {
      throw new ForbiddenException('Fast Path cannot request or execute sensitive actions');
    }

    const expiresAt = dto.expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const nonce = randomUUID();
    const actionHash = hashApprovalAction({
      actionType: dto.action_type,
      payload: dto.payload,
      nonce,
      expiresAt,
    });

    const approval = await this.repo.create({
      org_id: orgId,
      task_id: dto.task_id ?? null,
      level,
      action_type: dto.action_type,
      action_hash: actionHash,
      nonce,
      status: level === 0 ? 'approved' : 'pending',
      payload: dto.payload,
      summary: dto.summary ?? null,
      screenshot_ref: dto.screenshot_ref ?? null,
      source,
      requested_by: userId,
      expires_at: expiresAt,
    });

    if (level > 0) {
      await this.events.publish({
        type: 'approval.requested',
        orgId,
        taskId: approval.task_id ?? undefined,
        payload: { approvalId: approval.id, level, action_hash: approval.action_hash },
      });
      await this.communication?.sendApprovalRequest(approval, orgId);
    }

    return approval;
  }

  async approve(approvalId: string, orgId: string, userId: string): Promise<ApprovalDecision> {
    const approval = await this.repo.findByIdOrThrow(approvalId, orgId);
    this.assertPendingAndFresh(approval);

    if (approval.level === 3) {
      if (!approval.reviewed_by) {
        const updated = await this.repo.update(approvalId, orgId, { reviewed_by: userId });
        return { approval: updated, completed: false };
      }
      if (approval.reviewed_by === userId) {
        throw new ConflictException('Level 3 approvals require two distinct approvers');
      }
      const updated = await this.repo.update(approvalId, orgId, {
        reviewed_by_2: userId,
        reviewed_at: new Date().toISOString(),
        status: 'approved',
      });
      await this.publishResolved(updated, orgId);
      return { approval: updated, completed: true };
    }

    const updated = await this.repo.update(approvalId, orgId, {
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      status: 'approved',
    });
    await this.publishResolved(updated, orgId);
    return { approval: updated, completed: true };
  }

  async reject(approvalId: string, orgId: string, userId: string, reason?: string): Promise<Approval> {
    const approval = await this.repo.findByIdOrThrow(approvalId, orgId);
    this.assertPendingAndFresh(approval);
    const updated = await this.repo.update(approvalId, orgId, {
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      status: 'rejected',
      summary: reason ? `${approval.summary ?? ''}\nRejected: ${reason}`.trim() : approval.summary,
    });
    await this.publishResolved(updated, orgId);
    return updated;
  }

  async validateForExecution(approvalId: string, orgId: string, payload: Record<string, unknown>) {
    const approval = await this.repo.findByIdOrThrow(approvalId, orgId);
    if (approval.status !== 'approved') throw new ForbiddenException('Approval is not approved');
    if (approval.nonce_used_at) throw new ConflictException('Approval nonce has already been used');
    if (this.isExpired(approval)) {
      await this.repo.markStatus(approval.id, orgId, 'expired');
      throw new ForbiddenException('Approval is expired');
    }

    const hash = hashApprovalAction({
      actionType: approval.action_type,
      payload,
      nonce: approval.nonce,
      expiresAt: approval.expires_at,
    });
    if (hash !== approval.action_hash) {
      throw new ForbiddenException('Approval payload hash mismatch');
    }

    const updated = await this.repo.update(approvalId, orgId, { nonce_used_at: new Date().toISOString() });
    return { ok: true, approvalId: updated.id, action_hash: updated.action_hash };
  }

  /**
   * Atomically validates and consumes an approved action for internal execution.
   * Marks nonce_used_at so the action cannot run twice.
   * Throws ForbiddenException / ConflictException on invalid state.
   */
  async consumeApproved(approvalId: string, orgId: string): Promise<Approval> {
    const approval = await this.repo.findByIdOrThrow(approvalId, orgId);
    if (approval.status !== 'approved') throw new Error(`Approval ${approvalId} is ${approval.status}`);
    if (approval.nonce_used_at) throw new Error(`Approval ${approvalId} has already been executed`);
    if (this.isExpired(approval)) throw new Error(`Approval ${approvalId} has expired`);
    return this.repo.update(approvalId, orgId, { nonce_used_at: new Date().toISOString() });
  }

  async requestForPreparedAction(input: {
    orgId: string;
    userId: string;
    taskId: string;
    actionType: string;
    payload: Record<string, unknown>;
    summary?: string;
    screenshotRef?: string;
    source?: 'browser' | 'dev_manager' | 'core_path' | 'system';
  }): Promise<Approval> {
    return this.request({
      task_id: input.taskId,
      action_type: input.actionType,
      payload: input.payload,
      summary: input.summary,
      screenshot_ref: input.screenshotRef,
      source: input.source ?? 'core_path',
    }, input.orgId, input.userId);
  }

  private assertPendingAndFresh(approval: Approval) {
    if (approval.status !== 'pending') throw new BadRequestException(`Approval is ${approval.status}`);
    if (this.isExpired(approval)) throw new ForbiddenException('Approval is expired');
  }

  private isExpired(approval: Approval): boolean {
    return new Date(approval.expires_at).getTime() <= Date.now();
  }

  private publishResolved(approval: Approval, orgId: string) {
    return this.events.publish({
      type: 'approval.resolved',
      orgId,
      taskId: approval.task_id ?? undefined,
      payload: { approvalId: approval.id, status: approval.status },
    });
  }
}
