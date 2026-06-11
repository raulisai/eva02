import { Injectable, Logger } from '@nestjs/common';
import { BrowserScreenshot } from '../browser/browser.types';
import { BrowserService } from '../browser/browser.service';

const RAPPI_SERVICE = 'rappi_web';
const RAPPI_LOGIN_URL = 'https://www.rappi.com.mx/login';
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

  constructor(private readonly browser: BrowserService) {}

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
    return { session_id: opened.id, state: signals.state, current_url: opened.current_url, screenshot };
  }

  async startEmailLogin(orgId: string, email: string, taskId?: string): Promise<RappiEmailLoginStartResult> {
    const opened = await this.browser.open({
      service: RAPPI_SERVICE,
      url: RAPPI_LOGIN_URL,
      task_id: taskId,
      reuse_open: false,
      metadata: { service: RAPPI_SERVICE, purpose: 'rappi-email-login', email },
    }, orgId);
    await this.browser.wait(opened.id, orgId, SETTLE_MS);

    const signals = await this.inspectPage(opened.id, orgId);
    if (signals.state === 'logged_in') {
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      return { ok: true, reason: 'already_logged_in', session_id: opened.id, text: 'Rappi ya tiene sesión activa.', screenshot };
    }

    const entered = await this.typeEmailAndContinue(opened.id, orgId, email);
    if (!entered) {
      const screenshot = await this.browser.screenshot(opened.id, orgId);
      return { ok: false, reason: 'no_email_field', session_id: opened.id, text: 'No encontré el campo de correo en Rappi. Te envié screenshot para resolverlo manualmente.', screenshot };
    }

    await this.browser.wait(opened.id, orgId, 3000);
    const afterSignals = await this.inspectPage(opened.id, orgId);
    const screenshot = await this.browser.screenshot(opened.id, orgId);

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

        const codeRequired = /c[oó]digo de verificaci[oó]n|verification code|ingresa el c[oó]digo|revisa tu correo|check your email|one.time|otp/i.test(text);
        if (codeRequired) return { state: 'code_required', textSample: sample, currentUrl };

        const emailRequired = /correo electr[oó]nico|email|ingresa.*correo|tu correo/i.test(text);
        if (emailRequired) return { state: 'email_required', textSample: sample, currentUrl };

        const loading = /cargando|loading|espera/i.test(text) || lines.length < 3;
        if (loading) return { state: 'loading', textSample: sample, currentUrl };

        const loginRequired = /ingresa|inicia sesi[oó]n|registr|login|sign in/i.test(text);
        if (loginRequired) return { state: 'login_required', textSample: sample, currentUrl };

        return { state: 'unknown', textSample: sample, currentUrl };
      });
    } catch (error) {
      this.logger.warn(`Could not inspect Rappi page state: ${(error as Error).message}`);
      return { state: 'unknown', textSample: '' };
    }
  }

  private async typeEmailAndContinue(sessionId: string, orgId: string, email: string): Promise<boolean> {
    return this.browser.evaluate<boolean, { email: string }>(sessionId, orgId, ({ email }) => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
      };
      const selectors = ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="correo"]', 'input[placeholder*="mail"]', 'input[id*="email"]'];
      const input = selectors.map(s => document.querySelector(s) as HTMLInputElement).find(el => isVisible(el));
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) { setter.call(input, email); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
      else input.value = email;
      const buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
      const btn = buttons.find(el => {
        const txt = el.textContent?.toLowerCase() ?? '';
        return /continuar|continue|siguiente|next|enviar|send|ingresar|entrar|submit/i.test(txt) && isVisible(el as HTMLElement);
      }) ?? buttons.find(el => isVisible(el as HTMLElement));
      if (btn) (btn as HTMLElement).click();
      return true;
    }, { email });
  }

  private async typeCodeAndSubmit(sessionId: string, orgId: string, code: string): Promise<boolean> {
    return this.browser.evaluate<boolean, { code: string }>(sessionId, orgId, ({ code }) => {
      const isVisible = (el: HTMLElement | null) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
      };
      // Individual digit inputs (OTP widget)
      const digitInputs = Array.from(document.querySelectorAll('input[maxlength="1"], input[data-index]'))
        .filter(el => isVisible(el as HTMLElement)) as HTMLInputElement[];
      if (digitInputs.length >= 4) {
        digitInputs.slice(0, code.length).forEach((inp, i) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) { setter.call(inp, code[i]); inp.dispatchEvent(new Event('input', { bubbles: true })); }
          else inp.value = code[i];
        });
        const btn = document.querySelector('button[type="submit"]') as HTMLElement;
        if (btn && isVisible(btn)) btn.click();
        return true;
      }
      // Single field
      const selectors = ['input[autocomplete="one-time-code"]', 'input[name*="code"]', 'input[name*="otp"]', 'input[placeholder*="código"]', 'input[placeholder*="code"]', 'input[type="tel"]'];
      const input = selectors.map(s => document.querySelector(s) as HTMLInputElement).find(el => isVisible(el));
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) { setter.call(input, code); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
      else input.value = code;
      const buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
      const btn = buttons.find(el => {
        const txt = el.textContent?.toLowerCase() ?? '';
        return /confirmar|confirm|verif|continuar|continue|enviar|send|ingresar|entrar/i.test(txt) && isVisible(el as HTMLElement);
      }) ?? buttons.find(el => isVisible(el as HTMLElement));
      if (btn) (btn as HTMLElement).click();
      return true;
    }, { code });
  }
}
