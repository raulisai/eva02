import * as childProcess from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
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

interface BrowserDebugInput {
  action: string;
  message: string;
  taskId?: string | null;
  sessionId?: string;
  profileId?: string;
  level?: 'debug' | 'error';
  data?: Record<string, unknown>;
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
    const reusableSession = dto.reuse_open
      ? await this.repo.findLatestOpenSessionForProfile(profile.id, orgId)
      : null;
    const session = reusableSession
      ?? await this.repo.createSession({
        orgId,
        profileId: profile.id,
        taskId: dto.task_id,
        metadata: dto.metadata,
      });

    await this.closeOtherOpenSessionsForProfile(profile.id, orgId, session.id);

    let decryptedState: any = null;
    if (profile.encrypted_state) {
      try {
        decryptedState = this.profileCrypto.decryptJson(profile.encrypted_state);
      } catch (error) {
        this.logger.error(`Failed to decrypt profile state for ${profile.id}: ${(error as Error).message}`);
      }
    }

    await this.logBrowserAction(orgId, {
      action: 'browser.open.start',
      message: `opening ${dto.service} at ${this.safeUrlForLog(dto.url)}`,
      taskId: session.task_id,
      sessionId: session.id,
      profileId: profile.id,
      data: {
        service: dto.service,
        url: this.safeUrlForLog(dto.url),
        reuse_open: Boolean(dto.reuse_open),
        restored_storage_state: Boolean(decryptedState),
      },
    });

    let result: { url: string; title: string };
    try {
      const hasLiveRuntimeSession = this.runtime.hasSession(session.id);
      if (decryptedState && !hasLiveRuntimeSession) {
        result = await this.runtime.openWithStorageState({
          sessionId: session.id,
          profileId: profile.id,
          url: dto.url,
          storageState: decryptedState,
        });
      } else {
        result = await this.runtime.open({
          sessionId: session.id,
          profileId: profile.id,
          url: dto.url,
        });
      }
    } catch (error) {
      await this.repo.updateSession(session.id, orgId, {
        status: 'failed',
        metadata: {
          ...session.metadata,
          last_error: (error as Error).message,
          failed_at: new Date().toISOString(),
        },
      }).catch(() => undefined);
      await this.logBrowserAction(orgId, {
        action: 'browser.open.failed',
        message: `browser open failed: ${(error as Error).message}`,
        taskId: session.task_id,
        sessionId: session.id,
        profileId: profile.id,
        level: 'error',
        data: { service: dto.service, url: this.safeUrlForLog(dto.url) },
      });
      if (this.isProfileLockError(error)) {
        throw new ConflictException(
          `El perfil local de ${dto.service} parece estar abierto en otra ventana o quedó bloqueado. `
          + 'Cierra esa ventana del navegador y vuelve a verificar la sesión.',
        );
      }
      throw error;
    }

    const updated = await this.repo.updateSession(session.id, orgId, {
      current_url: result.url,
      metadata: { ...session.metadata, title: result.title },
    });
    await this.logBrowserAction(orgId, {
      action: 'browser.open.done',
      message: `opened ${result.title || 'Untitled'} at ${this.safeUrlForLog(result.url)}`,
      taskId: session.task_id,
      sessionId: session.id,
      profileId: profile.id,
      data: { title: result.title, current_url: this.safeUrlForLog(result.url) },
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

    await this.logBrowserAction(orgId, {
      action: 'browser.manual.open',
      message: `manual browser opened for ${dto.service}`,
      profileId: profile.id,
      data: {
        service: dto.service,
        app: launch.app,
        url: this.safeUrlForLog(target.toString()),
        closed_automated_session: closedAutomatedSession,
      },
    });

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
    await this.logBrowserAction(orgId, {
      action: 'browser.screenshot',
      message: `screenshot captured for session ${this.shortSession(sessionId)}`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { screenshotId: screenshot.id },
    });
    return screenshot;
  }

  async extractText(sessionId: string, orgId: string, selector?: string) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    const text = await this.runtime.extractText(sessionId, selector);
    await this.logBrowserAction(orgId, {
      action: 'browser.extract_text',
      message: `extracted text from ${selector ? this.safeSelectorForLog(selector) : 'body'} (${text.length} chars)`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { selector: selector ? this.safeSelectorForLog(selector) : 'body', chars: text.length },
    });
    return {
      kind: 'browser.extracted_text',
      treatment: 'data',
      text,
    };
  }

  async extractTable(sessionId: string, orgId: string, selector?: string) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    const table = await this.runtime.extractTable(sessionId, selector);
    await this.logBrowserAction(orgId, {
      action: 'browser.extract_table',
      message: `extracted table from ${selector ? this.safeSelectorForLog(selector) : 'table'}`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: {
        selector: selector ? this.safeSelectorForLog(selector) : 'table',
        rows: table.rows.length,
        columns: table.headers.length,
      },
    });
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
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    const result = await this.runtime.evaluate<T, A>(sessionId, pageFunction, arg);
    await this.logBrowserAction(orgId, {
      action: 'browser.evaluate',
      message: 'evaluated page function in browser session',
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { result_type: Array.isArray(result) ? 'array' : typeof result },
    });
    return result;
  }

  async wait(sessionId: string, orgId: string, ms: number) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.wait(sessionId, ms);
    await this.logBrowserAction(orgId, {
      action: 'browser.wait',
      message: `waited ${ms}ms in browser session`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { waited_ms: ms },
    });
    return { sessionId, waited_ms: ms };
  }

  async typeCharacters(sessionId: string, orgId: string, text: string, delay?: number) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.typeCharacters(sessionId, text, delay);
    await this.logBrowserAction(orgId, {
      action: 'browser.keyboard.type',
      message: `typed ${text.length} keyboard character(s)`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { chars: text.length, delay_ms: delay ?? 80 },
    });
    return { sessionId };
  }

  async clickNow(sessionId: string, orgId: string, selector: string, options?: { timeout?: number }) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.click(sessionId, selector, options);
    await this.logBrowserAction(orgId, {
      action: 'browser.click',
      message: `clicked ${this.safeSelectorForLog(selector)}`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { selector: this.safeSelectorForLog(selector), timeout_ms: options?.timeout },
    });
    return { sessionId, selector };
  }

  async typeNow(sessionId: string, orgId: string, selector: string, text: string, options?: { timeout?: number }) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.runtime.type(sessionId, selector, text, options);
    await this.logBrowserAction(orgId, {
      action: 'browser.type',
      message: `filled ${this.safeSelectorForLog(selector)} (${text.length} chars)`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
      data: { selector: this.safeSelectorForLog(selector), chars: text.length, timeout_ms: options?.timeout },
    });
    return { sessionId, selector };
  }

  async getOrCreateProfile(orgId: string, service: string) {
    return this.repo.getOrCreateProfile(orgId, service);
  }

  async findLatestOpenSession(profileId: string, orgId: string) {
    return this.repo.findLatestOpenSessionForProfile(profileId, orgId);
  }

  async findLatestSession(profileId: string, orgId: string) {
    return this.repo.findLatestSessionForProfile(profileId, orgId);
  }

  async findLatestScreenshotForProfile(profileId: string, orgId: string) {
    return this.repo.findLatestScreenshotForProfile(profileId, orgId);
  }

  async updateSessionMetadata(sessionId: string, orgId: string, metadata: Record<string, any>) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    return this.repo.updateSession(sessionId, orgId, {
      metadata: { ...session.metadata, ...metadata },
    });
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
    await this.logBrowserAction(orgId, {
      action: 'browser.storage_state.open',
      message: `opened browser with imported storage state at ${this.safeUrlForLog(result.url)}`,
      sessionId: session.id,
      profileId: input.profileId,
      data: { url: this.safeUrlForLog(result.url), title: result.title },
    });
    return { ...session, ...result };
  }

  async saveProfileState(sessionId: string, orgId: string) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    const state = await this.runtime.storageState(sessionId);
    await this.repo.saveEncryptedProfileState(
      session.profile_id,
      orgId,
      this.profileCrypto.encryptJson(state),
    );
  }

  async close(sessionId: string, orgId: string) {
    const session = await this.repo.findSessionOrThrow(sessionId, orgId);
    await this.saveProfileState(sessionId, orgId).catch((error) => {
      this.logger.warn(`Could not save browser profile state before close: ${(error as Error).message}`);
    });
    await this.runtime.close(sessionId);
    const updated = await this.repo.updateSession(sessionId, orgId, { status: 'closed' });
    await this.logBrowserAction(orgId, {
      action: 'browser.close',
      message: `closed browser session ${this.shortSession(sessionId)}`,
      taskId: session.task_id,
      sessionId,
      profileId: session.profile_id,
    });
    return updated;
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

    await this.logBrowserAction(orgId, {
      action: 'browser.action.prepared',
      message: `prepared ${dto.action_type} for approval`,
      taskId: dto.task_id,
      sessionId,
      profileId: session.profile_id,
      data: {
        action_type: dto.action_type,
        approval_id: approval.id,
        screenshot_id: screenshot.id,
      },
    });

    return { preparation, approval, action_hash: approval.action_hash, nonce: approval.nonce };
  }

  private async logBrowserAction(orgId: string, input: BrowserDebugInput): Promise<void> {
    await this.events.publish({
      type: 'task.log',
      orgId,
      taskId: input.taskId ?? undefined,
      payload: {
        message: input.message,
        scope: 'browser',
        agent: 'browser',
        module: 'BrowserService',
        action: input.action,
        level: input.level ?? 'debug',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
        ...(input.data ?? {}),
      },
    });
  }

  private safeUrlForLog(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.search) parsed.search = '?redacted';
      if (parsed.hash) parsed.hash = '#redacted';
      const value = parsed.toString();
      return value.length > 180 ? `${value.slice(0, 177)}...` : value;
    } catch {
      return rawUrl.length > 180 ? `${rawUrl.slice(0, 177)}...` : rawUrl;
    }
  }

  private safeSelectorForLog(selector: string): string {
    return selector.length > 140 ? `${selector.slice(0, 137)}...` : selector;
  }

  private shortSession(sessionId: string): string {
    return sessionId.slice(0, 8);
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

  private async closeOtherOpenSessionsForProfile(profileId: string, orgId: string, keepSessionId: string): Promise<void> {
    const openSessions = await this.repo.findOpenSessionsForProfile(profileId, orgId);
    for (const existing of openSessions) {
      if (existing.id === keepSessionId) continue;
      try {
        await this.close(existing.id, orgId);
      } catch (error) {
        this.logger.warn(`Could not close stale browser session ${this.shortSession(existing.id)}: ${(error as Error).message}`);
        await this.repo.updateSession(existing.id, orgId, {
          status: 'closed',
          metadata: {
            ...existing.metadata,
            closed_as_stale_for_session: keepSessionId,
          },
        }).catch(() => undefined);
      }
    }
  }

  private profileDir(profileId: string): string {
    return join(process.env.BROWSER_PROFILES_DIR ?? join(homedir(), '.eva-browser-profiles'), profileId);
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

  private isProfileLockError(error: unknown): boolean {
    const message = (error as Error).message ?? '';
    return /Target page, context or browser has been closed|SingletonLock|ProcessSingleton|user data dir|profile.*in use|browser has been closed/i.test(message);
  }
}
