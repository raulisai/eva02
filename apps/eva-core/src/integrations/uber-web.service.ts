import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrowserScreenshot } from '../browser/browser.types';
import { BrowserService } from '../browser/browser.service';
import { GoogleWebLoginResult, GoogleWebLoginService } from './google-web-login.service';

const UBER_HOME_URL = 'https://m.uber.com/go/home';
const UBER_DEEPLINK_URL = 'https://m.uber.com/ul/';
const UBER_SERVICE = 'uber_web';
const DEFAULT_SETTLE_MS = 5000;

export type UberWebState = 'logged_in' | 'login_required' | 'quote_ready' | 'loading' | 'unknown';

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

@Injectable()
export class UberWebService {
  private readonly logger = new Logger(UberWebService.name);

  constructor(
    private readonly browser: BrowserService,
    @Optional() private readonly googleWeb?: GoogleWebLoginService,
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

        if (quoteCandidates.length > 0) {
          return { state: 'quote_ready', googleLoginAvailable, quoteCandidates, textSample: uniqueLines.slice(0, 30).join('\n'), currentUrl, title };
        }

        if (loginRequired || googleLoginAvailable || location.href.includes('/login')) {
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
}
