import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrowserScreenshot } from '../browser/browser.types';
import { BrowserService } from '../browser/browser.service';
import { SmartNavigatorService } from '../browser/smart-navigator.service';
import { GoogleWebLoginResult, GoogleWebLoginService } from './google-web-login.service';

const UBER_HOME_URL = 'https://m.uber.com/go/home';
const UBER_DEEPLINK_URL = 'https://m.uber.com/ul/';
// Direct email-login URL — skips the "choose method" screen
const UBER_EMAIL_URL = 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fwww.uber.com';
const UBER_SERVICE = 'uber_web';
const DEFAULT_SETTLE_MS = 5000;

export type UberWebState = 'logged_in' | 'login_required' | 'email_required' | 'code_required' | 'password_required' | 'quote_ready' | 'loading' | 'unknown';

export interface UberSessionStatus {
  session_id: string;
  state: UberWebState;
  current_url: string | null;
  title?: string;
  google_login_available: boolean;
  screenshot?: BrowserScreenshot;
}

export interface UberQuoteCandidate {
  label: string;
  price: string;
  raw_lines: string[];
}

export type UberEstimateResult =
  | {
      ok: true;
      reason: 'quote_ready';
      session: UberSessionStatus;
      origin: string;
      destination: string;
      candidates: UberQuoteCandidate[];
      text: string;
    }
  | {
      ok: false;
      reason: 'login_required' | 'quote_not_found' | 'loading' | 'unknown';
      session: UberSessionStatus;
      origin: string;
      destination: string;
      candidates: UberQuoteCandidate[];
      text: string;
    };

interface UberPageSignals {
  state: UberWebState;
  googleLoginAvailable: boolean;
  quoteCandidates: UberQuoteCandidate[];
  textSample: string;
  currentUrl?: string;
  title?: string;
}

export interface UberGoogleLoginResult {
  ok: boolean;
  reason: 'logged_in' | 'login_required' | 'google_credential_missing' | 'google_mfa_required' | 'google_blocked' | 'google_unknown';
  session: UberSessionStatus;
  google?: GoogleWebLoginResult;
  text: string;
}

export interface UberManualLoginResult {
  ok: true;
  service: 'uber_web';
  url: string;
  app: string;
  profile_id: string;
  closed_automated_session: boolean;
  text: string;
}

export interface UberEmailLoginStartResult {
  ok: boolean;
  reason: 'code_required' | 'already_logged_in' | 'no_email_field' | 'unknown';
  session_id: string;
  text: string;
  screenshot?: BrowserScreenshot;
}

export interface UberCodeSubmitResult {
  ok: boolean;
  reason: 'logged_in' | 'invalid_code' | 'code_expired' | 'no_active_session' | 'unknown';
  session_id?: string;
  text: string;
  screenshot?: BrowserScreenshot;
}

@Injectable()
export class UberWebService {
  private readonly logger = new Logger(UberWebService.name);

  constructor(
    private readonly browser: BrowserService,
    @Optional() private readonly googleWeb?: GoogleWebLoginService,
    @Optional() private readonly smartNav?: SmartNavigatorService,
  ) {}

  async startSession(orgId: string, taskId?: string): Promise<UberSessionStatus> {
    const opened = await this.browser.open({
      service: UBER_SERVICE,
      url: UBER_HOME_URL,
      task_id: taskId,
      reuse_open: true,
      metadata: { service: UBER_SERVICE, purpose: 'uber-web-login' },
    }, orgId);

    await this.browser.wait(opened.id, orgId, this.settleMs());
    const signals = await this.inspectPage(opened.id, orgId);
    const screenshot = await this.browser.screenshot(opened.id, orgId);

    return {
      session_id: opened.id,
      state: signals.state === 'quote_ready' ? 'logged_in' : signals.state,
      current_url: opened.current_url,
      title: opened.title,
      google_login_available: signals.googleLoginAvailable,
      screenshot,
    };
  }

  async estimateRide(orgId: string, input: {
    origin: string;
    destination: string;
    taskId?: string;
    skipGoogleLogin?: boolean;
  }): Promise<UberEstimateResult> {
    const opened = await this.browser.open({
      service: UBER_SERVICE,
      url: this.buildRouteUrl(input.origin, input.destination),
      task_id: input.taskId,
      reuse_open: true,
      metadata: {
        service: UBER_SERVICE,
        purpose: 'uber-web-estimate',
        origin: input.origin,
        destination: input.destination,
        guardrail: 'quote-only-never-request-ride',
      },
    }, orgId);

    await this.browser.wait(opened.id, orgId, this.settleMs());
    const signals = await this.inspectPage(opened.id, orgId);
    const screenshot = await this.browser.screenshot(opened.id, orgId);
    const session: UberSessionStatus = {
      session_id: opened.id,
      state: signals.state,
      current_url: opened.current_url,
      title: opened.title,
      google_login_available: signals.googleLoginAvailable,
      screenshot,
    };

    if (signals.state === 'login_required') {
      if (!input.skipGoogleLogin && signals.googleLoginAvailable && this.googleWeb && await this.googleWeb.hasCredential(orgId)) {
        const login = await this.loginUberWithGoogleFromSession(orgId, opened.id, input.taskId);
        if (login.ok) {
          return this.estimateRide(orgId, {
            origin: input.origin,
            destination: input.destination,
            taskId: input.taskId,
            skipGoogleLogin: true,
          });
        }
        return {
          ok: false,
          reason: 'login_required',
          session: login.session,
          origin: input.origin,
          destination: input.destination,
          candidates: [],
          text: login.text,
        };
      }
      return {
        ok: false,
        reason: 'login_required',
        session,
        origin: input.origin,
        destination: input.destination,
        candidates: [],
        text: this.loginRequiredText(session),
      };
    }

    if (signals.state === 'loading') {
      return {
        ok: false,
        reason: 'loading',
        session,
        origin: input.origin,
        destination: input.destination,
        candidates: [],
        text: 'Uber Web abrió, pero todavía está cargando. Te envié screenshot; espera unos segundos y vuelve a intentar.',
      };
    }

    if (signals.quoteCandidates.length === 0) {
      return {
        ok: false,
        reason: signals.state === 'unknown' ? 'unknown' : 'quote_not_found',
        session,
        origin: input.origin,
        destination: input.destination,
        candidates: [],
        text:
          'Abrí Uber Web con la ruta, pero no encontré una tarifa visible todavía. '
          + 'Te envié screenshot para confirmar el estado de la pantalla; no pedí ni confirmé ningún viaje.',
      };
    }

    return {
      ok: true,
      reason: 'quote_ready',
      session: { ...session, state: 'quote_ready' },
      origin: input.origin,
      destination: input.destination,
      candidates: signals.quoteCandidates,
      text: this.formatQuote(input.origin, input.destination, signals.quoteCandidates),
    };
  }

  async startGoogleLogin(orgId: string, taskId?: string): Promise<UberGoogleLoginResult> {
    const opened = await this.browser.open({
      service: UBER_SERVICE,
      url: UBER_HOME_URL,
      task_id: taskId,
      reuse_open: true,
      metadata: { service: UBER_SERVICE, purpose: 'uber-web-google-login' },
    }, orgId);
    await this.browser.wait(opened.id, orgId, this.settleMs());

    const signals = await this.inspectPage(opened.id, orgId);
    if (signals.state !== 'login_required') {
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      return {
        ok: true,
        reason: 'logged_in',
        session: {
          session_id: opened.id,
          state: signals.state === 'quote_ready' ? 'logged_in' : signals.state,
          current_url: signals.currentUrl ?? opened.current_url,
          title: signals.title ?? opened.title,
          google_login_available: signals.googleLoginAvailable,
          screenshot,
        },
        text: 'Uber Web ya parece tener sesión activa en este perfil local.',
      };
    }

    return this.loginUberWithGoogleFromSession(orgId, opened.id, taskId);
  }

  async startEmailLogin(orgId: string, email: string, password?: string, taskId?: string): Promise<UberEmailLoginStartResult> {
    // Navigate directly to the email-login form — avoids the "choose method" screen
    const opened = await this.browser.open({
      service: UBER_SERVICE,
      url: UBER_EMAIL_URL,
      task_id: taskId,
      reuse_open: false,
      metadata: { service: UBER_SERVICE, purpose: 'uber-email-login', email, ...(password ? { temp_password: password } : {}) },
    }, orgId);
    await this.browser.wait(opened.id, orgId, this.settleMs());

    let signals = await this.inspectPage(opened.id, orgId);
    if (signals.state === 'logged_in' || signals.state === 'quote_ready') {
      await this.browser.saveProfileState(opened.id, orgId).catch((err) => {
        this.logger.error(`Failed to auto-save profile state: ${err.message}`);
      });
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      return { ok: true, reason: 'already_logged_in', session_id: opened.id, text: 'Uber Web ya tiene sesión activa.', screenshot };
    }

    // Try to find the email field directly (direct URL may land on email form already)
    let hasEmailField = await this.hasVisibleEmailField(opened.id, orgId);

    if (!hasEmailField) {
      // Fallback 1: click "Use email" / "Continuar con correo" link on the method-choice screen
      const clicked = await this.clickUseEmail(opened.id, orgId);
      if (clicked) {
        await this.browser.wait(opened.id, orgId, 2000);
        hasEmailField = await this.hasVisibleEmailField(opened.id, orgId);
      }
    }

    if (!hasEmailField && this.smartNav?.available) {
      // Fallback 2: let the cheap-model navigator find the email-login path.
      this.logger.log('Uber email field not found via selectors — handing off to smart navigator');
      await this.smartNav.navigate(
        orgId,
        opened.id,
        'Llega a la pantalla de inicio de sesión de Uber con correo electrónico. '
        + 'Si ves opciones de método (teléfono, Google, correo), elige la opción de continuar con correo electrónico '
        + 'para que quede visible el campo donde se escribe el email. No inicies sesión con Google ni con teléfono.',
        { maxSteps: 4, taskId },
      );
      await this.browser.wait(opened.id, orgId, 1500);
      hasEmailField = await this.hasVisibleEmailField(opened.id, orgId);
    }

    const entered = await this.typeEmailAndContinue(opened.id, orgId, email);
    if (!entered) {
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      return { ok: false, reason: 'no_email_field', session_id: opened.id, text: 'No encontré el campo de email en Uber. Te envié screenshot para resolverlo manualmente.', screenshot };
    }

    // Increased wait time for Uber to redirect to the challenge screen
    await this.browser.wait(opened.id, orgId, 5000);

    // Check if it asks for password immediately
    signals = await this.inspectPage(opened.id, orgId);
    if (signals.state === 'password_required') {
      if (password) {
        const passwordEntered = await this.typePasswordAndSubmit(opened.id, orgId, password);
        if (passwordEntered) {
          await this.browser.wait(opened.id, orgId, 5000);
        }
      } else {
        const screenshot = await this.browser.screenshot(opened.id, orgId);
        return { ok: false, reason: 'unknown', session_id: opened.id, text: 'Uber pide contraseña, pero no la proporcionaste. Vuelve a iniciar sesión incluyendo tu contraseña.', screenshot };
      }
    }
    
    // Check for "Send code via SMS" or similar intermediate challenge screens
    // Use native Playwright click — much more reliable than JS injection
    let clicked = await this.handleIntermediateChallenges(opened.id, orgId);
    if (clicked) {
      await this.browser.wait(opened.id, orgId, 2500);
    } else {
      // Retry once more in case the page was still loading
      await this.browser.wait(opened.id, orgId, 2000);
      clicked = await this.handleIntermediateChallenges(opened.id, orgId);
      if (clicked) {
        await this.browser.wait(opened.id, orgId, 2500);
      }
    }

    await this.browser.wait(opened.id, orgId, 2000);
    
    let afterSignals = await this.inspectPage(opened.id, orgId);

    // Check password again (if it asks for it after intermediate challenge)
    if (afterSignals.state === 'password_required') {
      if (password) {
        const passwordEntered = await this.typePasswordAndSubmit(opened.id, orgId, password);
        if (passwordEntered) {
          await this.browser.wait(opened.id, orgId, 5000);
          afterSignals = await this.inspectPage(opened.id, orgId);
        }
      } else {
        const screenshot = await this.browser.screenshot(opened.id, orgId);
        return { ok: false, reason: 'unknown', session_id: opened.id, text: 'Uber pide contraseña, pero no la proporcionaste. Vuelve a iniciar sesión incluyendo tu contraseña.', screenshot };
      }
    }

    const screenshot = await this.browser.screenshot(opened.id, orgId);

    if (afterSignals.state === 'code_required') {
      return {
        ok: true,
        reason: 'code_required',
        session_id: opened.id,
        text: `Ingresé el correo **${email}** en Uber. Te enviaron un código de verificación — dímelo y lo escribo para completar el login.`,
        screenshot,
      };
    }

    // Since we are in a terminal state (not code_required), delete temp_password from metadata
    if (password) {
      const { temp_password, ...cleanMetadata } = (opened.metadata || {}) as any;
      await this.browser.updateSessionMetadata(opened.id, orgId, cleanMetadata);
    }

    if (afterSignals.state === 'logged_in' || afterSignals.state === 'quote_ready') {
      await this.browser.saveProfileState(opened.id, orgId).catch((err) => {
        this.logger.error(`Failed to auto-save profile state: ${err.message}`);
      });
      return { ok: true, reason: 'already_logged_in', session_id: opened.id, text: 'Uber Web quedó autenticado directamente con el correo.', screenshot };
    }

    return { ok: false, reason: 'unknown', session_id: opened.id, text: 'Ingresé el correo pero Uber no mostró la pantalla de código. Te envié screenshot para verificar el estado.', screenshot };
  }

  async submitLoginCode(orgId: string, code: string, taskId?: string): Promise<UberCodeSubmitResult> {
    const profile = await this.browser.getOrCreateProfile(orgId, UBER_SERVICE);
    const session = await this.browser.findLatestOpenSession(profile.id, orgId);
    if (!session) {
      return { ok: false, reason: 'no_active_session', text: 'No encontré una sesión activa de Uber donde ingresar el código. Inicia el login primero.' };
    }

    const typed = await this.typeCodeAndSubmit(session.id, orgId, code);
    if (!typed) {
      const screenshot = await this.browser.screenshot(session.id, orgId);
      return { ok: false, reason: 'unknown', session_id: session.id, text: 'No encontré el campo de código en la pantalla actual de Uber. Te envié screenshot.', screenshot };
    }

    await this.browser.wait(session.id, orgId, 4000);
    let signals = await this.inspectPage(session.id, orgId);

    // If it asks for password AFTER code entry!
    if (signals.state === 'password_required') {
      const sessionPassword = session.metadata?.temp_password;
      if (typeof sessionPassword === 'string' && sessionPassword) {
        const passwordEntered = await this.typePasswordAndSubmit(session.id, orgId, sessionPassword);
        if (passwordEntered) {
          await this.browser.wait(session.id, orgId, 5000);
          signals = await this.inspectPage(session.id, orgId);
        }
      } else {
        const screenshot = await this.browser.screenshot(session.id, orgId);
        return {
          ok: false,
          reason: 'unknown',
          session_id: session.id,
          text: 'Ingresé el código y ahora Uber pide contraseña. Por favor, vuelve a iniciar sesión incluyendo tu contraseña al principio.',
          screenshot,
        };
      }
    }

    const screenshot = await this.browser.screenshot(session.id, orgId);

    // Clean up password from metadata if we are in a terminal state (not code_required)
    if (signals.state !== 'code_required') {
      const { temp_password, ...cleanMetadata } = (session.metadata || {}) as any;
      await this.browser.updateSessionMetadata(session.id, orgId, cleanMetadata);
    }

    if (signals.state === 'logged_in' || signals.state === 'quote_ready') {
      await this.browser.saveProfileState(session.id, orgId).catch((err) => {
        this.logger.error(`Failed to auto-save profile state: ${err.message}`);
      });
      return { ok: true, reason: 'logged_in', session_id: session.id, text: '✅ Uber Web quedó autenticado. Ya puedes pedir cotizaciones.', screenshot };
    }

    if (signals.state === 'code_required') {
      return { ok: false, reason: 'invalid_code', session_id: session.id, text: 'El código parece incorrecto o expirado. Verifica y dime el código correcto.', screenshot };
    }

    return { ok: false, reason: 'unknown', session_id: session.id, text: 'Ingresé el código pero Uber no terminó de autenticar. Te envié screenshot del estado actual.', screenshot };
  }

  async openManualLogin(orgId: string): Promise<UberManualLoginResult> {
    const opened = await this.browser.openManualProfile({
      service: UBER_SERVICE,
      url: UBER_HOME_URL,
    }, orgId);

    return {
      ...opened,
      service: UBER_SERVICE,
      text: [
        `${opened.app} normal se abrió con el perfil local de Uber Web.`,
        'Completa el login de Google/Uber ahí, cierra esa ventana y luego vuelve a validar o pide la cotización.',
        'EVA no recibió ni guardó tu contraseña; solo reutilizará la sesión local del perfil.',
      ].join('\n'),
    };
  }

  private settleMs(): number {
    const configured = Number(process.env.UBER_WEB_SETTLE_MS ?? DEFAULT_SETTLE_MS);
    if (!Number.isFinite(configured)) return DEFAULT_SETTLE_MS;
    return Math.min(Math.max(configured, 1000), 20000);
  }

  private buildRouteUrl(origin: string, destination: string): string {
    const url = new URL(UBER_DEEPLINK_URL);
    url.searchParams.set('action', 'setPickup');
    url.searchParams.set('pickup[formatted_address]', origin);
    url.searchParams.set('dropoff[formatted_address]', destination);
    return url.toString();
  }

  private async inspectPage(sessionId: string, orgId: string): Promise<UberPageSignals> {
    try {
      return await this.browser.evaluate<UberPageSignals>(sessionId, orgId, () => {
        const normalize = (value: string) => value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const text = normalize(document.body?.innerText ?? '');
        const currentUrl = location.href;
        const title = document.title;
        const lower = text.toLowerCase();
        const lines = text
          .split('\n')
          .map((line) => normalize(line))
          .filter(Boolean);
        const uniqueLines = lines.filter((line, index, all) => all.indexOf(line) === index);

        const googleLoginAvailable = /continuar con google|continue with google|sign in with google|iniciar sesi[oó]n con google|google/i.test(text);
        const loginRequired = /log in|sign in|iniciar sesi[oó]n|inicia sesi[oó]n|continue|continuar|login/i.test(text)
          && !/\b(uberx|comfort|black|xl|moto|taxi|elige|choose|precio|price)\b/i.test(text);
        const loading = /loading|cargando|espera|please wait/i.test(text);

        const pricePattern = /\b(?:MX\$|M\$|\$|USD|MXN)\s?\d[\d,.]*(?:\s?(?:MXN|USD))?\b/i;
        const productPattern = /\b(uberx|comfort|black|xl|moto|flash|taxi|priority|planet|green|share|reserve|uber)\b/i;
        const quoteCandidates = uniqueLines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => pricePattern.test(line))
          .slice(0, 8)
          .map(({ line, index }) => {
            const windowLines = uniqueLines.slice(Math.max(0, index - 3), index + 4);
            const label =
              [...windowLines].reverse().find((candidate) => productPattern.test(candidate) && !pricePattern.test(candidate))
              ?? uniqueLines[index - 1]
              ?? 'Uber';
            return {
              label,
              price: line.match(pricePattern)?.[0] ?? line,
              raw_lines: windowLines,
            };
          });

        const passwordRequired = (/enter your password|ingresa tu contrase[ñn]a|contrase[ñn]a/i.test(text)
          || (/welcome back/i.test(text) && /password/i.test(text)))
          && !googleLoginAvailable
          && !/continue with google|continuar con google/i.test(text);

        const codeRequired = (/verifica|verification code|c[oó]digo de verificaci[oó]n|enter.*code|ingresa.*c[oó]digo|check your email|revisa tu correo|one-time|otp|almost there|casi listo|digit.*code|sent via sms/i.test(text))
          && !googleLoginAvailable
          && !/continue with google|continuar con google/i.test(text);

        // Check password/OTP screens BEFORE login_required
        if (passwordRequired) {
          return { state: 'password_required', googleLoginAvailable, quoteCandidates: [], textSample: uniqueLines.slice(0, 30).join('\n'), currentUrl, title };
        }

        if (codeRequired) {
          return { state: 'code_required', googleLoginAvailable, quoteCandidates: [], textSample: uniqueLines.slice(0, 30).join('\n'), currentUrl, title };
        }

        if (loginRequired || googleLoginAvailable || location.href.includes('/login') || location.href.includes('/auth')) {
          return { state: 'login_required', googleLoginAvailable, quoteCandidates: [], textSample: uniqueLines.slice(0, 30).join('\n'), currentUrl, title };
        }

        if (loading || uniqueLines.length < 3) {
          return { state: 'loading', googleLoginAvailable, quoteCandidates: [], textSample: uniqueLines.slice(0, 30).join('\n'), currentUrl, title };
        }

        const rideForm = /where to|a d[oó]nde|destino|destination|pickup|recogida|origen|elige un viaje|choose a ride/i.test(text);
        return {
          state: rideForm ? 'logged_in' : 'unknown',
          googleLoginAvailable,
          quoteCandidates: [],
          textSample: uniqueLines.slice(0, 30).join('\n'),
          currentUrl,
          title,
        };
      });
    } catch (error) {
      this.logger.warn(`Could not inspect Uber Web state: ${(error as Error).message}`);
      return { state: 'unknown', googleLoginAvailable: false, quoteCandidates: [], textSample: '' };
    }
  }

  private async loginUberWithGoogleFromSession(
    orgId: string,
    sessionId: string,
    taskId?: string,
  ): Promise<UberGoogleLoginResult> {
    if (!this.googleWeb || !await this.googleWeb.hasCredential(orgId)) {
      const signals = await this.inspectPage(sessionId, orgId);
      const screenshot = await this.browser.screenshot(sessionId, orgId);
      return {
        ok: false,
        reason: 'google_credential_missing',
        session: this.sessionFromSignals(sessionId, signals, screenshot),
        text: [
          'Uber Web pide login con Google, pero no hay credencial Google Web guardada.',
          'Agrégala en Credentials → Google Web Login o inicia sesión manualmente en el navegador local.',
        ].join('\n'),
      };
    }

    const clicked = await this.clickContinueWithGoogle(sessionId, orgId);
    if (!clicked) {
      const signals = await this.inspectPage(sessionId, orgId);
      const screenshot = await this.browser.screenshot(sessionId, orgId);
      return {
        ok: false,
        reason: 'login_required',
        session: this.sessionFromSignals(sessionId, signals, screenshot),
        text: 'No encontré un botón visible de “Continuar con Google” en Uber. Te envié screenshot para resolverlo manualmente.',
      };
    }

    await this.browser.wait(sessionId, orgId, 2500);
    const google = await this.googleWeb.loginCurrentSession(orgId, sessionId, taskId);
    await this.browser.wait(sessionId, orgId, this.settleMs());
    const signals = await this.inspectPage(sessionId, orgId);
    const screenshot = await this.browser.screenshot(sessionId, orgId);
    const session = this.sessionFromSignals(sessionId, signals, screenshot);
    const uberReady = signals.state !== 'login_required' && signals.state !== 'loading' && signals.state !== 'unknown';

    if (uberReady) {
      return {
        ok: true,
        reason: 'logged_in',
        session,
        google,
        text: 'Google Web quedó autenticado y Uber Web ya no muestra pantalla de login. Te envié screenshot para confirmar.',
      };
    }

    const reason: UberGoogleLoginResult['reason'] =
      google.state === 'mfa_required' ? 'google_mfa_required'
      : google.state === 'blocked' ? 'google_blocked'
      : google.state === 'no_credential' ? 'google_credential_missing'
      : 'google_unknown';

    return {
      ok: false,
      reason,
      session,
      google,
      text: [
        google.text,
        '',
        'Uber todavía no quedó autenticado. Te envié screenshot del estado actual; cuando completes el paso manual, reintento la cotización.',
      ].join('\n'),
    };
  }

  private async hasVisibleEmailField(sessionId: string, orgId: string): Promise<boolean> {
    return this.browser.evaluate<boolean>(sessionId, orgId, () => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0;
      };
      const selectors = ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="mail" i]', 'input[placeholder*="correo" i]', 'input[id*="email" i]'];
      return selectors.some((s) => isVisible(document.querySelector(s) as HTMLElement));
    });
  }

  private async clickUseEmail(sessionId: string, orgId: string): Promise<boolean> {
    return this.browser.evaluate<boolean>(sessionId, orgId, () => {
      const candidates = Array.from(document.querySelectorAll('a, button, div[role="button"], span[role="button"], li'));
      const match = candidates.find((el) => {
        const text = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        return /use email|usar correo|email instead|correo electr[oó]nico|sign in with email|iniciar.*correo|continue.*email|continuar.*correo/i.test(text);
      });
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    });
  }

  private async typeEmailAndContinue(sessionId: string, orgId: string, email: string): Promise<boolean> {
    // Phase 1: find the input and type char-by-char so React state updates correctly
    const found = await this.browser.evaluate<boolean, { email: string }>(sessionId, orgId, ({ email }) => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0;
      };
      const selectors = [
        'input[type="email"]', 'input[name="email"]',
        'input[placeholder*="mail" i]', 'input[placeholder*="correo" i]',
        'input[id*="email" i]', 'input[autocomplete="email"]',
      ];
      const input = selectors.map((s) => document.querySelector(s) as HTMLInputElement).find((el) => isVisible(el));
      if (!input) return false;

      input.focus();
      // Clear existing value
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

      // Type each character to trigger React synthetic events
      let current = '';
      for (const char of email) {
        current += char;
        if (setter) setter.call(input, current);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { email });

    if (!found) return false;

    // Phase 2: wait a tick for React to re-render and enable the submit button
    await this.browser.wait(sessionId, orgId, 600);

    // Phase 3: press Enter on the input (most reliable way to submit React forms)
    await this.browser.evaluate<void>(sessionId, orgId, () => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0;
      };
      const selectors = [
        'input[type="email"]', 'input[name="email"]',
        'input[placeholder*="mail" i]', 'input[placeholder*="correo" i]',
        'input[id*="email" i]', 'input[autocomplete="email"]',
      ];
      const input = selectors.map((s) => document.querySelector(s) as HTMLInputElement).find((el) => isVisible(el));

      // Try specific Uber button IDs first
      const specificBtn = document.querySelector('#forward-button') as HTMLButtonElement
        ?? document.querySelector('button[data-testid="forward-button"]') as HTMLButtonElement;
      
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[type="submit"], button, div[role="button"]'));
      const submitBtn = specificBtn ?? buttons.find((el) => {
        if (!isVisible(el as HTMLElement) || (el as HTMLButtonElement).disabled) return false;
        const txt = el.textContent?.toLowerCase() ?? '';
        return /continuar|continue|next|siguiente|enviar|send|submit/i.test(txt);
      }) ?? buttons.find((el) => isVisible(el as HTMLElement) && !(el as HTMLButtonElement).disabled);

      if (submitBtn) {
        submitBtn.click();
      }
      
      if (input) {
        // Always simulate Enter key as well, as it's often more reliable in React/Uber
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        const form = input.closest('form');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });

    return true;
  }

  private async handleIntermediateChallenges(sessionId: string, orgId: string): Promise<boolean> {
    // Use Playwright's native click with text selectors — much more reliable than JS injection
    const smsSelectors = [
      'text=Send code via SMS',
      'text=Enviar código por SMS',
      'text=Send code via email',
      'text=Enviar código por correo',
      ':text("Send code")',
    ];

    for (const selector of smsSelectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, selector, { timeout: 1500 });
        this.logger.log(`Clicked intermediate challenge button: ${selector}`);
        return true;
      } catch {
        // Selector not found, try next
      }
    }

    return false;
  }

  private async typeCodeAndSubmit(sessionId: string, orgId: string, code: string): Promise<boolean> {
    // Find the first visible input on the OTP screen and click it
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
      // Fallback: try using evaluate to find the first visible input and click/focus it
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

    // Use native Playwright keyboard.type — works with all OTP widgets (single or multi-box)
    await this.browser.typeCharacters(sessionId, orgId, code, 120);
    await this.browser.wait(sessionId, orgId, 800);

    // Click Next/Submit button
    const submitSelectors = [
      'text=Next >> nth=0',
      'text=Siguiente >> nth=0',
      'text=Verify >> nth=0',
      'text=Verificar >> nth=0',
      'text=Confirmar >> nth=0',
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

  private async typePasswordAndSubmit(sessionId: string, orgId: string, password?: string): Promise<boolean> {
    if (!password) return false;

    const selectors = [
      'input[type="password"] >> nth=0',
      'input[name="password"] >> nth=0',
      'input[placeholder*="password" i] >> nth=0',
      'input[placeholder*="contraseña" i] >> nth=0',
    ];

    let clicked = false;
    for (const sel of selectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, sel, { timeout: 1500 });
        clicked = true;
        break;
      } catch {
        // try next
      }
    }

    if (!clicked) {
      // Fallback: try using evaluate to find the first visible input and click/focus it
      const evaluated = await this.browser.evaluate<boolean>(sessionId, orgId, () => {
        const isVisible = (el: HTMLElement | null) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
        };
        const selectors = [
          'input[type="password"]',
          'input[name="password"]',
          'input[placeholder*="password" i]',
          'input[placeholder*="contraseña" i]',
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

    await this.browser.typeCharacters(sessionId, orgId, password, 80);
    await this.browser.wait(sessionId, orgId, 800);

    // Click Next button
    const submitSelectors = [
      'text=Next >> nth=0',
      'text=Siguiente >> nth=0',
      'text=Verify >> nth=0',
      'text=Verificar >> nth=0',
      'text=Confirmar >> nth=0',
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

  private async clickContinueWithGoogle(sessionId: string, orgId: string): Promise<boolean> {
    return this.browser.evaluate<boolean>(sessionId, orgId, () => {
      const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const match = candidates.find((element) => {
        const text = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`.toLowerCase();
        return /continue with google|continuar con google|sign in with google|iniciar sesi[oó]n con google|google/.test(text);
      });
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    });
  }

  private sessionFromSignals(
    sessionId: string,
    signals: UberPageSignals,
    screenshot: BrowserScreenshot,
  ): UberSessionStatus {
    return {
      session_id: sessionId,
      state: signals.state === 'quote_ready' ? 'logged_in' : signals.state,
      current_url: signals.currentUrl ?? null,
      title: signals.title,
      google_login_available: signals.googleLoginAvailable,
      screenshot,
    };
  }

  private loginRequiredText(session: UberSessionStatus): string {
    const google = session.google_login_available
      ? 'Sí veo opción de iniciar sesión con Google en Uber Web.'
      : 'No pude confirmar un botón de Google en la pantalla visible.';
    return [
      'Abrí Uber Web, pero este perfil local todavía no está dentro de tu cuenta.',
      google,
      'Te envié screenshot para que confirmes. Inicia sesión manualmente en esa sesión del navegador; después puedo reintentar la cotización.',
      'Nota: una credencial OAuth de Google guardada en EVA no equivale a una sesión web de Google/Uber.',
    ].join('\n');
  }

  private formatQuote(origin: string, destination: string, candidates: UberQuoteCandidate[]): string {
    return [
      `Cotización visible de Uber para ${origin} → ${destination}:`,
      '',
      ...candidates.slice(0, 5).map((candidate) => `- ${candidate.label}: ${candidate.price}`),
      '',
      'Te envié screenshot para confirmar. No pedí ni confirmé ningún viaje.',
    ].join('\n');
  }

  async getProfile(orgId: string) {
    return this.browser.getOrCreateProfile(orgId, UBER_SERVICE);
  }
}
