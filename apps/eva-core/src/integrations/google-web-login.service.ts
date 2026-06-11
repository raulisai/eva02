import { Injectable, Logger } from '@nestjs/common';
import { BrowserScreenshot } from '../browser/browser.types';
import { BrowserService } from '../browser/browser.service';
import { IntegrationsService } from './integrations.service';
import { GoogleWebCredential } from './integrations.types';

const GOOGLE_WEB_SERVICE = 'google_web';
const GOOGLE_LOGIN_URL = 'https://accounts.google.com/signin/v2/identifier';
const STEP_WAIT_MS = 1800;

export type GoogleWebLoginState =
  | 'logged_in'
  | 'email_required'
  | 'account_picker'
  | 'password_required'
  | 'consent_required'
  | 'mfa_required'
  | 'challenge_required'
  | 'blocked'
  | 'loading'
  | 'unknown'
  | 'no_credential';

export interface GoogleWebLoginResult {
  ok: boolean;
  state: GoogleWebLoginState;
  session_id?: string;
  current_url?: string;
  title?: string;
  email?: string;
  screenshot?: BrowserScreenshot;
  text: string;
}

interface GooglePageSignals {
  state: GoogleWebLoginState;
  currentUrl: string;
  title: string;
  emailSelector?: string;
  passwordSelector?: string;
  textSample: string;
}

@Injectable()
export class GoogleWebLoginService {
  private readonly logger = new Logger(GoogleWebLoginService.name);

  constructor(
    private readonly browser: BrowserService,
    private readonly integrations: IntegrationsService,
  ) {}

  async hasCredential(orgId: string): Promise<boolean> {
    const credential = await this.getCredential(orgId);
    return Boolean(credential);
  }

  async startSession(orgId: string, taskId?: string): Promise<GoogleWebLoginResult> {
    const credential = await this.getCredential(orgId);
    if (!credential) return this.noCredential();

    const opened = await this.browser.open({
      service: GOOGLE_WEB_SERVICE,
      url: GOOGLE_LOGIN_URL,
      task_id: taskId,
      reuse_open: true,
      metadata: {
        service: GOOGLE_WEB_SERVICE,
        purpose: 'google-web-login',
        email: credential.email,
        mfa: 'manual-user-required',
      },
    }, orgId);

    await this.browser.wait(opened.id, orgId, STEP_WAIT_MS);
    return this.loginCurrentSession(orgId, opened.id, taskId, credential);
  }

  async loginCurrentSession(
    orgId: string,
    sessionId: string,
    taskId?: string,
    credentialInput?: GoogleWebCredential,
  ): Promise<GoogleWebLoginResult> {
    const credential = credentialInput ?? await this.getCredential(orgId);
    if (!credential) return this.noCredential();

    let lastSignals: GooglePageSignals | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const signals = await this.inspect(sessionId, orgId, credential.email);
      lastSignals = signals;

      if (signals.state === 'logged_in') {
        return this.withScreenshot(orgId, sessionId, {
          ok: true,
          state: 'logged_in',
          session_id: sessionId,
          current_url: signals.currentUrl,
          title: signals.title,
          email: credential.email,
          text: `Google Web ya está autenticado como ${credential.email}.`,
        });
      }

      if (signals.state === 'email_required' && signals.emailSelector) {
        await this.browser.typeNow(sessionId, orgId, signals.emailSelector, credential.email);
        await this.clickFirst(sessionId, orgId, {
          selectors: ['#identifierNext button', '#identifierNext', 'button[jsname="LgbsSe"]'],
          labels: ['Next', 'Siguiente'],
        });
        await this.browser.wait(sessionId, orgId, STEP_WAIT_MS);
        continue;
      }

      if (signals.state === 'account_picker') {
        const clicked = await this.clickAccount(sessionId, orgId, credential.email);
        if (clicked) {
          await this.browser.wait(sessionId, orgId, STEP_WAIT_MS);
          continue;
        }
        return this.withScreenshot(orgId, sessionId, {
          ok: false,
          state: 'account_picker',
          session_id: sessionId,
          current_url: signals.currentUrl,
          title: signals.title,
          email: credential.email,
          text: `Google mostró selector de cuenta, pero no encontré ${credential.email}. Te envié screenshot para elegirla manualmente.`,
        });
      }

      if (signals.state === 'password_required' && signals.passwordSelector) {
        await this.browser.typeNow(sessionId, orgId, signals.passwordSelector, credential.password);
        await this.clickFirst(sessionId, orgId, {
          selectors: ['#passwordNext button', '#passwordNext', 'button[jsname="LgbsSe"]'],
          labels: ['Next', 'Siguiente'],
        });
        await this.browser.wait(sessionId, orgId, STEP_WAIT_MS * 2);
        continue;
      }

      if (signals.state === 'consent_required') {
        const clicked = await this.clickFirst(sessionId, orgId, {
          selectors: ['button[type="submit"]', 'button[jsname="LgbsSe"]'],
          labels: ['Continue', 'Continuar', 'Allow', 'Permitir'],
        });
        if (clicked) {
          await this.browser.wait(sessionId, orgId, STEP_WAIT_MS * 2);
          continue;
        }
      }

      if (['mfa_required', 'challenge_required', 'blocked'].includes(signals.state)) {
        return this.withScreenshot(orgId, sessionId, {
          ok: false,
          state: signals.state,
          session_id: sessionId,
          current_url: signals.currentUrl,
          title: signals.title,
          email: credential.email,
          text: this.manualStepText(signals.state, credential.email),
        });
      }

      await this.browser.wait(sessionId, orgId, STEP_WAIT_MS);
    }

    return this.withScreenshot(orgId, sessionId, {
      ok: false,
      state: lastSignals?.state ?? 'unknown',
      session_id: sessionId,
      current_url: lastSignals?.currentUrl,
      title: lastSignals?.title,
      email: credential.email,
      text: 'No pude completar el login web de Google automáticamente. Te envié screenshot del estado actual para resolverlo manualmente.',
    });
  }

  private async getCredential(orgId: string): Promise<GoogleWebCredential | null> {
    const secret = await this.integrations.getSecret(orgId, 'credential', GOOGLE_WEB_SERVICE);
    if (!secret) return null;
    try {
      const credential = JSON.parse(secret) as Partial<GoogleWebCredential>;
      if (!credential.email || !credential.password) return null;
      return { email: credential.email, password: credential.password };
    } catch {
      return null;
    }
  }

  private noCredential(): GoogleWebLoginResult {
    return {
      ok: false,
      state: 'no_credential',
      text: 'No hay credencial Google Web guardada. Agrega email y contraseña en Credentials → Google Web Login.',
    };
  }

  private async inspect(sessionId: string, orgId: string, email: string): Promise<GooglePageSignals> {
    try {
      return await this.browser.evaluate<GooglePageSignals, { email: string }>(sessionId, orgId, ({ email }) => {
        const normalize = (value: string) => value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const text = normalize(document.body?.innerText ?? '');
        const lower = text.toLowerCase();
        const currentUrl = location.href;
        const title = document.title;
        const host = location.hostname.toLowerCase();
        const isGoogle = host === 'google.com' || host.endsWith('.google.com');

        const isVisible = (el: HTMLElement | null) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const hasSize = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && hasSize;
        };

        const findSelector = (selectors: string[]) => selectors.find((selector) => {
          const el = document.querySelector(selector) as HTMLElement;
          return isVisible(el);
        });

        const emailSelector = findSelector(['input[type="email"]', 'input[name="identifier"]', '#identifierId']);
        const passwordSelector = findSelector(['input[name="Passwd"]', 'input[type="password"]']);
        const sample = text.split('\n').map((line) => normalize(line)).filter(Boolean).slice(0, 30).join('\n');

        if (!isGoogle) {
          return { state: 'logged_in', currentUrl, title, textSample: sample };
        }

        if (/couldn.?t sign you in|could not sign you in|browser or app may not be secure|unusual traffic|no se pudo acceder|navegador o app no sean seguros/i.test(text)) {
          return { state: 'blocked', currentUrl, title, textSample: sample };
        }

        if (/2-step verification|two-step verification|verificaci[oó]n en 2 pasos|authenticator|security key|llave de seguridad|passkey|c[oó]digo|code sent|check your phone|revisa tu tel[eé]fono|tap yes|presiona s[ií]/i.test(text)) {
          return { state: 'mfa_required', currentUrl, title, textSample: sample };
        }

        if (/verify it.?s you|verifica que eres t[uú]|confirm your recovery|recovery email|correo de recuperaci[oó]n|challenge|desaf[ií]o/i.test(text)) {
          return { state: 'challenge_required', currentUrl, title, textSample: sample };
        }

        if (/choose an account|elige una cuenta|selecciona una cuenta|use another account/i.test(text)) {
          return { state: lower.includes(email.toLowerCase()) ? 'account_picker' : 'email_required', currentUrl, title, emailSelector, textSample: sample };
        }

        if (passwordSelector) {
          return { state: 'password_required', currentUrl, title, passwordSelector, textSample: sample };
        }

        if (emailSelector) {
          return { state: 'email_required', currentUrl, title, emailSelector, textSample: sample };
        }

        if (/continue to|continuar a|allow|permitir|uber/i.test(text) && /button|role="button"/i.test(document.body?.innerHTML ?? '')) {
          return { state: 'consent_required', currentUrl, title, textSample: sample };
        }

        if (/myaccount\.google\.com|manage your google account|gestionar tu cuenta de google|cuenta de google/i.test(`${currentUrl}\n${text}`)) {
          return { state: 'logged_in', currentUrl, title, textSample: sample };
        }

        if (/loading|cargando|please wait|espera/i.test(text) || text.length < 20) {
          return { state: 'loading', currentUrl, title, textSample: sample };
        }

        return { state: 'unknown', currentUrl, title, textSample: sample };
      }, { email });
    } catch (error) {
      this.logger.warn(`Could not inspect Google Web login state: ${(error as Error).message}`);
      return { state: 'unknown', currentUrl: '', title: '', textSample: '' };
    }
  }

  private async clickFirst(
    sessionId: string,
    orgId: string,
    input: { selectors: string[]; labels: string[] },
  ): Promise<boolean> {
    return this.browser.evaluate<boolean, typeof input>(sessionId, orgId, ({ selectors, labels }) => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const hasSize = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && hasSize;
      };

      const click = (element: Element | null) => {
        if (!element || !isVisible(element as HTMLElement)) return false;
        (element as HTMLElement).click();
        return true;
      };
      for (const selector of selectors) {
        if (click(document.querySelector(selector))) return true;
      }
      const controls = Array.from(document.querySelectorAll('button, div[role="button"], a'));
      const match = controls.find((element) => {
        const text = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`.trim().toLowerCase();
        return labels.some((label) => text.includes(label.toLowerCase())) && isVisible(element as HTMLElement);
      });
      return click(match ?? null);
    }, input);
  }

  private async clickAccount(sessionId: string, orgId: string, email: string): Promise<boolean> {
    return this.browser.evaluate<boolean, { email: string }>(sessionId, orgId, ({ email }) => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const hasSize = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && hasSize;
      };

      const controls = Array.from(document.querySelectorAll('button, div[role="button"], a, [data-identifier]'));
      const match = controls.find((element) => {
        const text = `${element.textContent ?? ''} ${element.getAttribute('data-identifier') ?? ''}`.toLowerCase();
        return text.includes(email.toLowerCase()) && isVisible(element as HTMLElement);
      });
      if (!match) return false;
      (match as HTMLElement).click();
      return true;
    }, { email });
  }

  private async withScreenshot(
    orgId: string,
    sessionId: string,
    result: GoogleWebLoginResult,
  ): Promise<GoogleWebLoginResult> {
    return {
      ...result,
      screenshot: await this.browser.screenshot(sessionId, orgId),
    };
  }

  private manualStepText(state: GoogleWebLoginState, email: string): string {
    if (state === 'mfa_required') {
      return `Google pidió verificación en dos pasos para ${email}. Te envié screenshot; completa el paso manualmente en el navegador y luego reintenta.`;
    }
    if (state === 'blocked') {
      return 'Google bloqueó o desconfió del login automático. Te envié screenshot; completa el acceso manualmente en el navegador local.';
    }
    return `Google pidió una verificación adicional para ${email}. Te envié screenshot; completa ese paso manualmente y luego reintenta.`;
  }
}
