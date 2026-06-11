import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrowserScreenshot } from '../browser/browser.types';
import { BrowserService } from '../browser/browser.service';
import { SmartNavigatorService } from '../browser/smart-navigator.service';

const RAPPI_SERVICE = 'rappi_web';
const RAPPI_LOGIN_URL = 'https://www.rappi.com.mx/login';
// Direct email-form URL — skips the "choose method" screen
const RAPPI_EMAIL_URL = 'https://www.rappi.com.mx/login/email?url_redirect=%2F&source=WEB_HEADER';
const SETTLE_MS = 4000;

export type RappiWebState =
  | 'logged_in'
  | 'login_required'
  | 'email_required'
  | 'code_required'
  | 'loading'
  | 'unknown';

export interface RappiSessionStatus {
  session_id: string;
  state: RappiWebState;
  current_url: string | null;
  screenshot?: BrowserScreenshot;
}

export interface RappiStoredSessionStatus {
  ok: true;
  has_session: boolean;
  session_id: string | null;
  state: RappiWebState | null;
  current_url: string | null;
  email?: string;
  last_verified_at?: string;
  screenshot?: BrowserScreenshot;
}

export interface RappiEmailLoginStartResult {
  ok: boolean;
  reason: 'code_required' | 'already_logged_in' | 'no_email_field' | 'unknown';
  session_id: string;
  text: string;
  screenshot?: BrowserScreenshot;
}

export interface RappiCodeSubmitResult {
  ok: boolean;
  reason: 'logged_in' | 'invalid_code' | 'no_active_session' | 'unknown';
  session_id?: string;
  text: string;
  screenshot?: BrowserScreenshot;
}

interface RappiPageSignals {
  state: RappiWebState;
  textSample: string;
  currentUrl?: string;
}

@Injectable()
export class RappiWebService {
  private readonly logger = new Logger(RappiWebService.name);

  constructor(
    private readonly browser: BrowserService,
    @Optional() private readonly smartNav?: SmartNavigatorService,
  ) {}

  async startSession(orgId: string, taskId?: string): Promise<RappiSessionStatus> {
    const opened = await this.browser.open({
      service: RAPPI_SERVICE,
      url: RAPPI_LOGIN_URL,
      task_id: taskId,
      reuse_open: true,
      metadata: { service: RAPPI_SERVICE, purpose: 'rappi-session' },
    }, orgId);
    await this.browser.wait(opened.id, orgId, SETTLE_MS);
    const signals = await this.inspectPage(opened.id, orgId);
    const screenshot = await this.browser.screenshot(opened.id, orgId);
    await this.persistSessionCheck(opened.id, orgId, signals, screenshot);
    return { session_id: opened.id, state: signals.state, current_url: signals.currentUrl ?? opened.current_url, screenshot };
  }

  async startEmailLogin(orgId: string, email: string, taskId?: string): Promise<RappiEmailLoginStartResult> {
    // Navigate directly to the email-login form — skips "choose method" screen
    const opened = await this.browser.open({
      service: RAPPI_SERVICE,
      url: RAPPI_EMAIL_URL,
      task_id: taskId,
      reuse_open: false,
      metadata: { service: RAPPI_SERVICE, purpose: 'rappi-email-login', email },
    }, orgId);
    await this.browser.wait(opened.id, orgId, SETTLE_MS);

    const signals = await this.inspectPage(opened.id, orgId);
    if (signals.state === 'logged_in') {
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      await this.persistSessionCheck(opened.id, orgId, signals, screenshot, { email });
      return { ok: true, reason: 'already_logged_in', session_id: opened.id, text: 'Rappi ya tiene sesión activa.', screenshot };
    }

    // If the direct URL redirected to the general login page, click "Continuar con correo"
    let hasEmailField = await this.hasVisibleEmailField(opened.id, orgId);
    if (!hasEmailField) {
      const clicked = await this.clickUseEmail(opened.id, orgId);
      if (clicked) {
        await this.browser.wait(opened.id, orgId, 2000);
        hasEmailField = await this.hasVisibleEmailField(opened.id, orgId);
      }
    }

    if (!hasEmailField && this.smartNav?.available) {
      // Smart-navigator fallback: cheap model finds the email-login path.
      this.logger.log('Rappi email field not found via selectors — handing off to smart navigator');
      await this.smartNav.navigate(
        orgId,
        opened.id,
        'Llega a la pantalla de inicio de sesión de Rappi con correo electrónico. '
        + 'Si ves opciones de método (teléfono, Google, Facebook, correo), elige continuar con correo electrónico '
        + 'para que quede visible el campo donde se escribe el email. No uses Google, Facebook ni teléfono.',
        { maxSteps: 4, taskId },
      );
      await this.browser.wait(opened.id, orgId, 1500);
      hasEmailField = await this.hasVisibleEmailField(opened.id, orgId);
    }

    const entered = await this.typeEmailAndContinue(opened.id, orgId, email);
    if (!entered) {
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      await this.persistSessionCheck(opened.id, orgId, signals, screenshot, { email });
      return { ok: false, reason: 'no_email_field', session_id: opened.id, text: 'No encontré el campo de correo en Rappi. Te envié screenshot para resolverlo manualmente.', screenshot };
    }

    await this.browser.wait(opened.id, orgId, 3000);
    const afterSignals = await this.inspectPage(opened.id, orgId);
    const screenshot = await this.browser.screenshot(opened.id, orgId);
    await this.persistSessionCheck(opened.id, orgId, afterSignals, screenshot, { email });

    if (afterSignals.state === 'code_required') {
      return {
        ok: true,
        reason: 'code_required',
        session_id: opened.id,
        text: `Ingresé el correo **${email}** en Rappi. Te enviaron un código de verificación — dímelo y lo escribo para completar el login.`,
        screenshot,
      };
    }

    if (afterSignals.state === 'logged_in') {
      return { ok: true, reason: 'already_logged_in', session_id: opened.id, text: 'Rappi quedó autenticado directamente con el correo.', screenshot };
    }

    return { ok: false, reason: 'unknown', session_id: opened.id, text: 'Ingresé el correo pero Rappi no mostró la pantalla de código. Te envié screenshot para verificar el estado.', screenshot };
  }

  async submitLoginCode(orgId: string, code: string): Promise<RappiCodeSubmitResult> {
    const profile = await this.browser.getOrCreateProfile(orgId, RAPPI_SERVICE);
    const session = await this.browser.findLatestOpenSession(profile.id, orgId);
    if (!session) {
      return { ok: false, reason: 'no_active_session', text: 'No encontré una sesión activa de Rappi. Inicia el login primero.' };
    }

    const typed = await this.typeCodeAndSubmit(session.id, orgId, code);
    if (!typed) {
      const screenshot = await this.browser.screenshot(session.id, orgId);
      return { ok: false, reason: 'unknown', session_id: session.id, text: 'No encontré el campo de código en la pantalla actual de Rappi. Te envié screenshot.', screenshot };
    }

    await this.browser.wait(session.id, orgId, 3000);
    const signals = await this.inspectPage(session.id, orgId);
    const screenshot = await this.browser.screenshot(session.id, orgId);
    await this.persistSessionCheck(session.id, orgId, signals, screenshot);

    if (signals.state === 'logged_in') {
      return { ok: true, reason: 'logged_in', session_id: session.id, text: '✅ Rappi quedó autenticado. Ya puedes hacer pedidos.', screenshot };
    }

    if (signals.state === 'code_required') {
      return { ok: false, reason: 'invalid_code', session_id: session.id, text: 'El código parece incorrecto o expirado. Verifica y dime el código correcto.', screenshot };
    }

    return { ok: false, reason: 'unknown', session_id: session.id, text: 'Ingresé el código pero Rappi no terminó de autenticar. Te envié screenshot del estado actual.', screenshot };
  }

  private async inspectPage(sessionId: string, orgId: string): Promise<RappiPageSignals> {
    try {
      return await this.browser.evaluate<RappiPageSignals>(sessionId, orgId, () => {
        const normalize = (v: string) => v.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
        const text = normalize(document.body?.innerText ?? '');
        const currentUrl = location.href;
        const lines = text.split('\n').map(normalize).filter(Boolean);
        const sample = lines.slice(0, 30).join('\n');

        const loggedIn = /mi cuenta|mis pedidos|mis órdenes|perfil|cerrar sesi[oó]n|logout|bienvenid[oa]|regresar a inicio/i.test(text)
          && !/ingresa|inicia sesi[oó]n|registr|login/i.test(text.slice(0, 300));
        if (loggedIn) return { state: 'logged_in', textSample: sample, currentUrl };

        const loginRequired = /ingresa|inicia sesi[oó]n|registr|login|sign in/i.test(text);
        if (loginRequired) return { state: 'login_required', textSample: sample, currentUrl };

        const codeRequired = /c[oó]digo de verificaci[oó]n|verification code|ingresa el c[oó]digo|revisa tu correo|check your email|one.time|otp/i.test(text);
        if (codeRequired) return { state: 'code_required', textSample: sample, currentUrl };

        const emailRequired = /correo electr[oó]nico|email|ingresa.*correo|tu correo/i.test(text);
        if (emailRequired) return { state: 'email_required', textSample: sample, currentUrl };

        return { state: 'unknown', textSample: sample, currentUrl };
      });
    } catch (error) {
      this.logger.warn(`Could not inspect Rappi page state: ${(error as Error).message}`);
      return { state: 'unknown', textSample: '' };
    }
  }

  private async hasVisibleEmailField(sessionId: string, orgId: string): Promise<boolean> {
    return this.browser.evaluate<boolean>(sessionId, orgId, () => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0;
      };
      const selectors = ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="correo" i]', 'input[placeholder*="mail" i]', 'input[id*="email" i]'];
      return selectors.some((s) => isVisible(document.querySelector(s) as HTMLElement));
    });
  }

  private async clickUseEmail(sessionId: string, orgId: string): Promise<boolean> {
    return this.browser.evaluate<boolean>(sessionId, orgId, () => {
      const candidates = Array.from(document.querySelectorAll('a, button, div[role="button"], span[role="button"], li'));
      const match = candidates.find((el) => {
        const text = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        return /correo electr[oó]nico|usar correo|continuar con correo|use email|sign in with email|iniciar.*correo|continue.*email|email/i.test(text);
      });
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    });
  }

  private async typeEmailAndContinue(sessionId: string, orgId: string, email: string): Promise<boolean> {
    // Phase 1: click the email input using Playwright-native selectors (no JS injection)
    const emailSelectors = [
      'input[type="email"] >> nth=0',
      'input[name="email"] >> nth=0',
      'input[autocomplete="email"] >> nth=0',
      'input[placeholder*="correo" i] >> nth=0',
      'input[placeholder*="mail" i] >> nth=0',
      'input[id*="email" i] >> nth=0',
    ];

    let clicked = false;
    for (const sel of emailSelectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, sel, { timeout: 1500 });
        clicked = true;
        break;
      } catch {
        // try next
      }
    }

    if (!clicked) {
      // Fallback: find and focus via evaluate
      const found = await this.browser.evaluate<boolean>(sessionId, orgId, () => {
        const isVisible = (el: HTMLElement | null) => {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0;
        };
        const selectors = [
          'input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]',
          'input[placeholder*="correo" i]', 'input[placeholder*="mail" i]', 'input[id*="email" i]',
        ];
        for (const s of selectors) {
          const inputs = Array.from(document.querySelectorAll(s)) as HTMLInputElement[];
          const first = inputs.find(isVisible);
          if (first) { first.focus(); first.click(); return true; }
        }
        return false;
      });
      if (!found) return false;
    }

    // Phase 2: type email character by character with native keyboard events
    await this.browser.typeCharacters(sessionId, orgId, email, 80);
    await this.browser.wait(sessionId, orgId, 600);

    // Phase 3: click submit button using Playwright-native selectors
    const submitSelectors = [
      'text=Continuar >> nth=0',
      'text=Continue >> nth=0',
      'text=Siguiente >> nth=0',
      'text=Next >> nth=0',
      'text=Ingresar >> nth=0',
      'text=Enviar >> nth=0',
      'button[type="submit"] >> nth=0',
    ];
    for (const sel of submitSelectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, sel, { timeout: 1500 });
        break;
      } catch {
        // try next
      }
    }

    return true;
  }

  private async typeCodeAndSubmit(sessionId: string, orgId: string, code: string): Promise<boolean> {
    const otpSelectors = [
      'input[autocomplete="one-time-code"] >> nth=0',
      'input[maxlength="1"] >> nth=0',
      'input[type="tel"] >> nth=0',
      'input[type="number"] >> nth=0',
      'input[name*="code"] >> nth=0',
      'input[name*="otp"] >> nth=0',
      'input[type="text"] >> nth=0',
      'input >> nth=0',
    ];

    let clicked = false;
    for (const sel of otpSelectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, sel, { timeout: 1500 });
        clicked = true;
        break;
      } catch {
        // try next
      }
    }

    if (!clicked) {
      const evaluated = await this.browser.evaluate<boolean>(sessionId, orgId, () => {
        const isVisible = (el: HTMLElement | null) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
        };
        const selectors = [
          'input[autocomplete="one-time-code"]',
          'input[maxlength="1"]',
          'input[type="tel"]',
          'input[type="number"]',
          'input[name*="code"]',
          'input[name*="otp"]',
          'input[type="text"]',
          'input',
        ];
        for (const s of selectors) {
          const inputs = Array.from(document.querySelectorAll(s)) as HTMLInputElement[];
          const firstVisible = inputs.find(isVisible);
          if (firstVisible) {
            firstVisible.focus();
            firstVisible.click();
            return true;
          }
        }
        return false;
      });
      if (!evaluated) return false;
    }

    await this.browser.typeCharacters(sessionId, orgId, code, 120);
    await this.browser.wait(sessionId, orgId, 800);

    const submitSelectors = [
      'text=Confirmar >> nth=0',
      'text=Confirm >> nth=0',
      'text=Verificar >> nth=0',
      'text=Verify >> nth=0',
      'text=Continuar >> nth=0',
      'text=Continue >> nth=0',
      'text=Siguiente >> nth=0',
      'text=Next >> nth=0',
      'button[type="submit"] >> nth=0',
      'button >> nth=0',
    ];
    for (const sel of submitSelectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, sel, { timeout: 1500 });
        break;
      } catch {
        // try next
      }
    }

    return true;
  }

  async getProfile(orgId: string) {
    return this.browser.getOrCreateProfile(orgId, RAPPI_SERVICE);
  }

  async getStoredStatus(orgId: string): Promise<RappiStoredSessionStatus> {
    const profile = await this.browser.getOrCreateProfile(orgId, RAPPI_SERVICE);
    const sessions = typeof (this.browser as any).findSessions === 'function'
      ? await (this.browser as any).findSessions(profile.id, orgId, 10).catch(() => [])
      : [await this.browser.findLatestSession(profile.id, orgId)].filter(Boolean);

    const latestSession = sessions[0] || null;
    const verifiedSession = sessions.find((s: any) => {
      const m = (s?.metadata ?? {}) as Record<string, unknown>;
      return typeof m.last_state === 'string' || typeof m.email === 'string';
    }) || latestSession;

    const screenshot = await this.browser.findLatestScreenshotForProfile(profile.id, orgId);
    const metadata = (verifiedSession?.metadata ?? {}) as Record<string, unknown>;
    const state = this.asRappiState(metadata.last_state);

    return {
      ok: true,
      has_session: Boolean(profile.encrypted_state) && (!state || state === 'logged_in'),
      session_id: verifiedSession?.id ?? null,
      state: state ?? null,
      current_url: typeof metadata.last_current_url === 'string'
        ? metadata.last_current_url
        : verifiedSession?.current_url ?? null,
      email: typeof metadata.email === 'string' ? metadata.email : undefined,
      last_verified_at: typeof metadata.last_verified_at === 'string' ? metadata.last_verified_at : undefined,
      screenshot: screenshot ?? undefined,
    };
  }

  private async persistSessionCheck(
    sessionId: string,
    orgId: string,
    signals: RappiPageSignals,
    screenshot?: BrowserScreenshot,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    if (signals.state === 'logged_in') {
      await this.browser.saveProfileState(sessionId, orgId).catch((err) => {
        this.logger.error(`Failed to auto-save profile state: ${err.message}`);
      });
    }
    await this.browser.updateSessionMetadata(sessionId, orgId, {
      ...extra,
      last_state: signals.state,
      last_current_url: signals.currentUrl ?? null,
      last_verified_at: now,
      ...(screenshot ? { last_screenshot_id: screenshot.id } : {}),
      ...(signals.state === 'logged_in' ? { last_success_at: now } : {}),
    }).catch((err) => {
      this.logger.warn(`Failed to persist Rappi session metadata: ${err.message}`);
    });
  }

  private asRappiState(value: unknown): RappiWebState | null {
    if (typeof value !== 'string') return null;
    return [
      'logged_in',
      'login_required',
      'email_required',
      'code_required',
      'loading',
      'unknown',
    ].includes(value) ? value as RappiWebState : null;
  }
}
