import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, BrowserContext, Page } from 'playwright';

export interface BrowserRuntimeSession {
  id: string;
  profileId: string;
  context: BrowserContext;
  page: Page;
}

export interface BrowserRuntimeOptions {
  profilesRoot?: string;
  headless?: boolean;
  channel?: string;
}

export interface ExtractedTable {
  headers: string[];
  rows: string[][];
}

export class BrowserProfileCrypto {
  private readonly key: Buffer;

  constructor(masterKey = process.env.EVA_MASTER_KEY) {
    const source = masterKey && masterKey.length >= 32 ? masterKey : 'eva-dev-kms-mock-key';
    this.key = createHash('sha256').update(source).digest();
  }

  encryptJson(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
  }

  decryptJson<T = unknown>(sealed: string): T {
    const [ivRaw, tagRaw, encryptedRaw] = sealed.split('.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  }
}

export class PlaywrightBrowserRuntime {
  private readonly sessions = new Map<string, BrowserRuntimeSession>();
  private readonly profilesRoot: string;
  private readonly headless: boolean;
  private readonly channel?: string;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.profilesRoot = options.profilesRoot ?? join(tmpdir(), 'eva-browser-profiles');
    this.headless = options.headless ?? true;
    this.channel = options.channel ?? process.env.BROWSER_CHANNEL;
  }

  async open(input: { sessionId: string; profileId: string; url: string }): Promise<{ url: string; title: string }> {
    const session = await this.getOrCreate(input.sessionId, input.profileId);
    await session.page.goto(input.url, { waitUntil: 'domcontentloaded' });
    
    // Title retrieval is fragile if a redirect happens immediately
    let title = 'Untitled';
    try {
      title = await session.page.title();
    } catch {
      // Ignore "context destroyed" or similar errors during title retrieval
    }

    return { url: session.page.url(), title };
  }

  async click(sessionId: string, selector: string, options?: { timeout?: number }): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.page.locator(selector).click(options);
  }

  async type(sessionId: string, selector: string, text: string, options?: { timeout?: number }): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.page.locator(selector).fill(text, options);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const session = this.requireSession(sessionId);
    return session.page.screenshot({ fullPage: true });
  }

  async extractText(sessionId: string, selector?: string): Promise<string> {
    const session = this.requireSession(sessionId);
    const locator = selector ? session.page.locator(selector) : session.page.locator('body');
    return (await locator.innerText()).trim();
  }

  async extractTable(sessionId: string, selector = 'table'): Promise<ExtractedTable> {
    const session = this.requireSession(sessionId);
    return session.page.locator(selector).evaluate((table) => {
      const rows = Array.from(table.querySelectorAll('tr'));
      const headers = Array.from(rows[0]?.querySelectorAll('th,td') ?? []).map((cell) =>
        (cell.textContent ?? '').trim(),
      );
      const bodyRows = rows.slice(headers.length ? 1 : 0).map((row) =>
        Array.from(row.querySelectorAll('td,th')).map((cell) => (cell.textContent ?? '').trim()),
      );
      return { headers, rows: bodyRows };
    });
  }

  async evaluate<T = unknown, A = unknown>(
    sessionId: string,
    pageFunction: (arg: A) => T | Promise<T>,
    arg?: A,
  ): Promise<T> {
    const session = this.requireSession(sessionId);
    return session.page.evaluate(pageFunction as any, arg as any) as Promise<T>;
  }

  async wait(sessionId: string, ms: number): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.page.waitForTimeout(ms);
  }

  async typeCharacters(sessionId: string, text: string, delay = 80): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.page.keyboard.type(text, { delay });
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.context.close();
    this.sessions.delete(sessionId);
  }

  async storageState(sessionId: string): Promise<unknown> {
    const session = this.requireSession(sessionId);
    return session.context.storageState();
  }

  /**
   * Opens a persistent context and seeds it with the provided cookies.
   * Accepts a Playwright StorageState object or a Cookie-Editor JSON array.
   * This is the server-safe way to import a session from a real browser.
   */
  async openWithStorageState(
    input: { sessionId: string; profileId: string; url: string; storageState: unknown },
  ): Promise<{ url: string; title: string }> {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      await existing.context.close();
      this.sessions.delete(input.sessionId);
    }
    const userDataDir = join(this.profilesRoot, input.profileId);
    await mkdir(userDataDir, { recursive: true });
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.headless,
      args: this.stealthArgs(),
    });
    await this.applyStealthToContext(context);

    // Seed cookies from the provided payload
    const cookies = this.extractCookies(input.storageState);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = context.pages()[0] ?? await context.newPage();
    this.sessions.set(input.sessionId, { id: input.sessionId, profileId: input.profileId, context, page });
    await page.goto(input.url, { waitUntil: 'domcontentloaded' });
    
    let title = 'Untitled';
    try {
      title = await page.title();
    } catch {
      // Ignore
    }

    return { url: page.url(), title };
  }

  private extractCookies(storageState: unknown): Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }> {
    if (Array.isArray(storageState)) {
      // Cookie-Editor / EditThisCookie array
      return storageState
        .filter((c): c is Record<string, unknown> => c && typeof c === 'object')
        .map((c) => ({
          name: String(c['name'] ?? ''),
          value: String(c['value'] ?? ''),
          domain: String(c['domain'] ?? ''),
          path: String(c['path'] ?? '/'),
          expires: typeof c['expirationDate'] === 'number' ? c['expirationDate'] : (typeof c['expires'] === 'number' ? c['expires'] : undefined),
          httpOnly: Boolean(c['httpOnly']),
          secure: Boolean(c['secure']),
        }))
        .filter((c) => c.name && c.domain);
    }
    if (storageState && typeof storageState === 'object' && 'cookies' in storageState && Array.isArray((storageState as { cookies: unknown }).cookies)) {
      return this.extractCookies((storageState as { cookies: unknown }).cookies);
    }
    return [];
  }

  private async getOrCreate(sessionId: string, profileId: string): Promise<BrowserRuntimeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const userDataDir = join(this.profilesRoot, profileId);
    await mkdir(userDataDir, { recursive: true });
    const context = await this.launchContext(userDataDir);
    const page = context.pages()[0] ?? await context.newPage();
    const session = { id: sessionId, profileId, context, page };
    this.sessions.set(sessionId, session);
    return session;
  }

  private stealthArgs(): string[] {
    return [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ];
  }

  private async applyStealthToContext(context: BrowserContext): Promise<void> {
    // Hide navigator.webdriver and related automation fingerprints
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en-US', 'en'] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {} };
    });
  }

  private async launchContext(userDataDir: string): Promise<BrowserContext> {
    const stealthArgs = this.stealthArgs();
    const attempts = this.channel
      ? [{ headless: this.headless, channel: this.channel, args: stealthArgs }]
      : [
          { headless: this.headless, args: stealthArgs },
          { headless: this.headless, channel: 'chrome', args: stealthArgs },
          ...(process.platform === 'darwin' && this.headless
            ? [{ headless: false, channel: 'chrome', args: stealthArgs }]
            : []),
        ];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const context = await chromium.launchPersistentContext(userDataDir, attempt);
        await this.applyStealthToContext(context);
        return context;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Browser failed to launch');
  }

  private requireSession(sessionId: string): BrowserRuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Browser session ${sessionId} is not open`);
    return session;
  }
}

export type BrowserRuntime = Pick<
  PlaywrightBrowserRuntime,
  'open'
  | 'click'
  | 'type'
  | 'typeCharacters'
  | 'screenshot'
  | 'extractText'
  | 'extractTable'
  | 'evaluate'
  | 'wait'
  | 'close'
  | 'storageState'
  | 'openWithStorageState'
>;
