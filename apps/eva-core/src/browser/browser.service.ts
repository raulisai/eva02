import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { BrowserProfileCrypto, BrowserRuntime } from '@eva/browser-runtime';
import { ApprovalsService } from '../approvals/approvals.service';
import { EventBusService } from '../events/event-bus.service';
import { BrowserRepository } from './browser.repository';
import { BROWSER_RUNTIME } from './browser.types';
import { OpenBrowserDto, PrepareBrowserActionDto } from './dto/browser-action.dto';

@Injectable()
export class BrowserService {
  private readonly profileCrypto = new BrowserProfileCrypto();

  constructor(
    private readonly repo: BrowserRepository,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalsService,
    @Inject(BROWSER_RUNTIME) private readonly runtime: BrowserRuntime,
  ) {}

  async open(dto: OpenBrowserDto, orgId: string) {
    const profile = await this.repo.getOrCreateProfile(orgId, dto.service);
    const session = await this.repo.createSession({
      orgId,
      profileId: profile.id,
      taskId: dto.task_id,
      metadata: dto.metadata,
    });
    const result = await this.runtime.open({
      sessionId: session.id,
      profileId: profile.id,
      url: dto.url,
    });
    const updated = await this.repo.updateSession(session.id, orgId, {
      current_url: result.url,
      metadata: { ...session.metadata, title: result.title },
    });
    return { ...updated, title: result.title };
  }

  async screenshot(sessionId: string, orgId: string) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    const image = await this.runtime.screenshot(sessionId);
    const screenshot = await this.repo.createScreenshot({
      orgId,
      sessionId,
      taskId: session.task_id,
      imageBase64: image.toString('base64'),
    });
    await this.events.publish({
      type: 'browser.screenshot.created',
      orgId,
      taskId: session.task_id ?? undefined,
      payload: { sessionId, screenshotId: screenshot.id },
    });
    return screenshot;
  }

  async extractText(sessionId: string, orgId: string, selector?: string) {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    const text = await this.runtime.extractText(sessionId, selector);
    return {
      kind: 'browser.extracted_text',
      treatment: 'data',
      text,
    };
  }

  async extractTable(sessionId: string, orgId: string, selector?: string) {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    const table = await this.runtime.extractTable(sessionId, selector);
    return {
      kind: 'browser.extracted_table',
      treatment: 'data',
      table,
    };
  }

  async wait(sessionId: string, orgId: string, ms: number) {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.wait(sessionId, ms);
    return { sessionId, waited_ms: ms };
  }

  async close(sessionId: string, orgId: string) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    const state = await this.runtime.storageState(sessionId);
    await this.repo.saveEncryptedProfileState(
      session.profile_id,
      orgId,
      this.profileCrypto.encryptJson(state),
    );
    await this.runtime.close(sessionId);
    return this.repo.updateSession(sessionId, orgId, { status: 'closed' });
  }

  async prepareAction(sessionId: string, orgId: string, userId: string, dto: PrepareBrowserActionDto) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    if (session.status !== 'open') throw new BadRequestException('Browser session is not open');
    if (!['browser.click', 'browser.type'].includes(dto.action_type)) {
      throw new BadRequestException('Only browser.click and browser.type require preparation in this phase');
    }

    const screenshot = await this.screenshot(sessionId, orgId);
    const payload = {
      session_id: sessionId,
      task_id: dto.task_id,
      action_type: dto.action_type,
      payload: dto.payload,
      screenshot_id: screenshot.id,
    };
    const approval = await this.approvals.requestForPreparedAction({
      orgId,
      userId,
      taskId: dto.task_id,
      actionType: dto.action_type,
      payload,
      screenshotRef: screenshot.id,
      source: 'browser',
      summary: `Browser action prepared: ${dto.action_type}`,
    });
    const preparation = await this.repo.createPreparation({
      orgId,
      sessionId,
      taskId: dto.task_id,
      userId,
      approvalId: approval.id,
      screenshotId: screenshot.id,
      actionType: dto.action_type,
      actionHash: approval.action_hash,
      nonce: approval.nonce,
      payload: dto.payload,
    });

    return { preparation, approval, action_hash: approval.action_hash, nonce: approval.nonce };
  }
}
