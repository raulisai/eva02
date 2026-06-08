import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { BrowserActionPreparation, BrowserProfile, BrowserScreenshot, BrowserSession } from './browser.types';

@Injectable()
export class BrowserRepository {
  private readonly logger = new Logger(BrowserRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async getOrCreateProfile(orgId: string, service: string): Promise<BrowserProfile> {
    const existing = await this.findProfile(orgId, service);
    if (existing) return existing;

    const { data, error } = await this.db.admin
      .from('browser_profiles')
      .insert({
        org_id: orgId,
        service,
        label: service,
        kms_key_ref: process.env.EVA_KMS_KEY_REF ?? 'dev-kms-mock',
      })
      .select()
      .single();

    if (error) this.fail('browser_profiles.create', error);
    return data as BrowserProfile;
  }

  async saveEncryptedProfileState(profileId: string, orgId: string, encryptedState: string): Promise<void> {
    const { error } = await this.db.admin
      .from('browser_profiles')
      .update({ encrypted_state: encryptedState })
      .eq('id', profileId)
      .eq('org_id', orgId);

    if (error) this.fail('browser_profiles.saveState', error);
  }

  async createSession(input: {
    orgId: string;
    profileId: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<BrowserSession> {
    const { data, error } = await this.db.admin
      .from('browser_sessions')
      .insert({
        org_id: input.orgId,
        profile_id: input.profileId,
        task_id: input.taskId ?? null,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();

    if (error) this.fail('browser_sessions.create', error);
    return data as BrowserSession;
  }

  async findSessionOrThrow(sessionId: string, orgId: string): Promise<BrowserSession> {
    const { data, error } = await this.db.admin
      .from('browser_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) this.fail('browser_sessions.find', error);
    if (!data) throw new NotFoundException(`Browser session ${sessionId} not found`);
    return data as BrowserSession;
  }

  async updateSession(sessionId: string, orgId: string, patch: Partial<Pick<BrowserSession, 'status' | 'current_url' | 'metadata'>>): Promise<BrowserSession> {
    const { data, error } = await this.db.admin
      .from('browser_sessions')
      .update(patch)
      .eq('id', sessionId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) this.fail('browser_sessions.update', error);
    return data as BrowserSession;
  }

  async createScreenshot(input: {
    orgId: string;
    sessionId: string;
    taskId?: string | null;
    imageBase64: string;
  }): Promise<BrowserScreenshot> {
    const { data, error } = await this.db.admin
      .from('browser_screenshots')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        task_id: input.taskId ?? null,
        image_base64: input.imageBase64,
      })
      .select()
      .single();

    if (error) this.fail('browser_screenshots.create', error);
    return data as BrowserScreenshot;
  }

  async createPreparation(input: {
    orgId: string;
    sessionId: string;
    taskId: string;
    userId: string;
    approvalId: string;
    screenshotId: string;
    actionType: string;
    actionHash: string;
    nonce: string;
    payload: Record<string, unknown>;
  }): Promise<BrowserActionPreparation> {
    const { data, error } = await this.db.admin
      .from('browser_action_preparations')
      .insert({
        org_id: input.orgId,
        session_id: input.sessionId,
        task_id: input.taskId,
        created_by: input.userId,
        approval_id: input.approvalId,
        screenshot_id: input.screenshotId,
        action_type: input.actionType,
        action_hash: input.actionHash,
        nonce: input.nonce,
        payload: input.payload,
      })
      .select()
      .single();

    if (error) this.fail('browser_preparations.create', error);
    return data as BrowserActionPreparation;
  }

  private async findProfile(orgId: string, service: string): Promise<BrowserProfile | null> {
    const { data, error } = await this.db.admin
      .from('browser_profiles')
      .select('*')
      .eq('org_id', orgId)
      .eq('service', service)
      .maybeSingle();

    if (error) this.fail('browser_profiles.find', error);
    return data as BrowserProfile | null;
  }

  private fail(scope: string, error: unknown): never {
    this.logger.error(scope, error as any);
    throw new InternalServerErrorException(`Failed to write ${scope}`);
  }
}
