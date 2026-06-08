import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Approval, ApprovalStatus } from './approval.types';

@Injectable()
export class ApprovalsRepository {
  private readonly logger = new Logger(ApprovalsRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async create(input: Omit<Approval, 'id' | 'created_at' | 'reviewed_by' | 'reviewed_by_2' | 'reviewed_at' | 'nonce_used_at'>): Promise<Approval> {
    const { data, error } = await this.db.admin
      .from('approvals')
      .insert({
        org_id: input.org_id,
        task_id: input.task_id,
        level: input.level,
        action_type: input.action_type,
        action_hash: input.action_hash,
        nonce: input.nonce,
        status: input.status,
        payload: input.payload,
        summary: input.summary,
        screenshot_ref: input.screenshot_ref,
        source: input.source,
        requested_by: input.requested_by,
        expires_at: input.expires_at,
      })
      .select()
      .single();

    if (error) this.fail('approvals.create', error);
    return data as Approval;
  }

  async findById(approvalId: string, orgId: string): Promise<Approval | null> {
    const { data, error } = await this.db.admin
      .from('approvals')
      .select('*')
      .eq('id', approvalId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('approvals.findById', error);
    return data as Approval | null;
  }

  async findByIdOrThrow(approvalId: string, orgId: string): Promise<Approval> {
    const approval = await this.findById(approvalId, orgId);
    if (!approval) throw new NotFoundException(`Approval ${approvalId} not found`);
    return approval;
  }

  async update(approvalId: string, orgId: string, patch: Partial<Approval>): Promise<Approval> {
    const { data, error } = await this.db.admin
      .from('approvals')
      .update(patch)
      .eq('id', approvalId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) this.fail('approvals.update', error);
    return data as Approval;
  }

  async markStatus(approvalId: string, orgId: string, status: ApprovalStatus): Promise<Approval> {
    return this.update(approvalId, orgId, { status });
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Failed to write ${scope}`);
  }
}
