import * as childProcess from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { BrowserProfileCrypto, BrowserRuntime } from '@eva/browser-runtime';
import { ApprovalsService } from '../approvals/approvals.service';
import { EventBusService } from '../events/event-bus.service';
import { BrowserRepository } from './browser.repository';
import { BROWSER_RUNTIME } from './browser.types';
import { OpenBrowserDto, PrepareBrowserActionDto } from './dto/browser-action.dto';

export interface OpenManualProfileDto {
  service: string;
  url: string;
}

export interface ManualProfileOpenResult {
  ok: true;
  service: string;
  url: string;
  app: string;
  profile_id: string;
  closed_automated_session: boolean;
  text: string;
}

@Injectable()
export class BrowserService {
  private readonly logger = new Logger(BrowserService.name);
  private readonly profileCrypto = new BrowserProfileCrypto();

  constructor(
    private readonly repo: BrowserRepository,
    private readonly events: EventBusService,
    private readonly approvals: ApprovalsService,
    @Inject(BROWSER_RUNTIME) private readonly runtime: BrowserRuntime,
  ) {}

  async open(dto: OpenBrowserDto, orgId: string) {
    const profile = await this.repo.getOrCreateProfile(orgId, dto.service);
    const session = dto.reuse_open
      ? await this.repo.findLatestOpenSessionForProfile(profile.id, orgId)
        ?? await this.repo.createSession({
          orgId,
          profileId: profile.id,
          taskId: dto.task_id,
          metadata: dto.metadata,
        })
      : await this.repo.createSession({
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

  async openManualProfile(dto: OpenManualProfileDto, orgId: string): Promise<ManualProfileOpenResult> {
    const target = this.parseManualUrl(dto.url);
    const profile = await this.repo.getOrCreateProfile(orgId, dto.service);
    const closedAutomatedSession = await this.closeLatestOpenSessionForProfile(profile.id, orgId);
    const profileDir = this.profileDir(profile.id);
    await mkdir(profileDir, { recursive: true });

    const launch = this.manualBrowserCommand(profileDir, target.toString());
    try {
      await this.spawnDetached(launch.command, launch.args);
    } catch (error) {
      this.logger.error(`Manual browser launch failed: ${(error as Error).message}`);
      throw new InternalServerErrorException(
        `Could not open ${launch.app}. Set BROWSER_MANUAL_APP to an installed browser and try again.`,
      );
    }

    return {
      ok: true,
      service: dto.service,
      url: target.toString(),
      app: launch.app,
      profile_id: profile.id,
      closed_automated_session: closedAutomatedSession,
      text: `${launch.app} opened with EVA's ${dto.service} browser profile. Finish the login there, close that browser window, then retry the action in EVA.`,
    };
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

  async evaluate<T = unknown, A = unknown>(
    sessionId: string,
    orgId: string,
    pageFunction: (arg: A) => T | Promise<T>,
    arg?: A,
  ): Promise<T> {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    return this.runtime.evaluate<T, A>(sessionId, pageFunction, arg);
  }

  async wait(sessionId: string, orgId: string, ms: number) {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.wait(sessionId, ms);
    return { sessionId, waited_ms: ms };
  }

  async clickNow(sessionId: string, orgId: string, selector: string) {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.click(sessionId, selector);
    return { sessionId, selector };
  }

  async typeNow(sessionId: string, orgId: string, selector: string, text: string) {
    await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.type(sessionId, selector, text);
    return { sessionId, selector };
  }

  async getOrCreateProfile(orgId: string, service: string) {
    return this.repo.getOrCreateProfile(orgId, service);
  }

  async findLatestOpenSession(profileId: string, orgId: string) {
    return this.repo.findLatestOpenSessionForProfile(profileId, orgId);
  }

  async openWithStorageState(
    input: { sessionId: string; profileId: string; url: string; storageState: unknown },
    orgId: string,
  ) {
    const result = await this.runtime.openWithStorageState(input);
    const session = await this.repo.createSession({
      orgId,
      profileId: input.profileId,
      taskId: undefined,
      metadata: { purpose: 'session-import' },
    });
    return { ...session, ...result };
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

  private parseManualUrl(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Manual browser URL must be a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Manual browser URL must be http or https');
    }
    return parsed;
  }

  private async closeLatestOpenSessionForProfile(profileId: string, orgId: string): Promise<boolean> {
    const existing = await this.repo.findLatestOpenSessionForProfile(profileId, orgId);
    if (!existing) return false;

    try {
      await this.close(existing.id, orgId);
    } catch (error) {
      this.logger.warn(`Could not close automated browser session before manual handoff: ${(error as Error).message}`);
      await this.repo.updateSession(existing.id, orgId, {
        status: 'closed',
        metadata: {
          ...existing.metadata,
          manual_handoff_closed_stale_session: true,
        },
      });
    }
    return true;
  }

  private profileDir(profileId: string): string {
    return join(process.env.BROWSER_PROFILES_DIR ?? join(tmpdir(), 'eva-browser-profiles'), profileId);
  }

  private manualBrowserCommand(profileDir: string, url: string): { command: string; args: string[]; app: string } {
    const configured = process.env.BROWSER_MANUAL_APP?.trim();
    if (process.platform === 'darwin') {
      const app = configured || 'Google Chrome';
      return {
        command: 'open',
        args: [
          '-na',
          app,
          '--args',
          `--user-data-dir=${profileDir}`,
          '--profile-directory=Default',
          '--new-window',
          url,
        ],
        app,
      };
    }

    const app = configured || (process.platform === 'win32' ? 'chrome.exe' : 'google-chrome');
    return {
      command: app,
      args: [
        `--user-data-dir=${profileDir}`,
        '--profile-directory=Default',
        '--new-window',
        url,
      ],
      app,
    };
  }

  private spawnDetached(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}
