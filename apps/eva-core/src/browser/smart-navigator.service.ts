import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrowserService } from './browser.service';
import { ModelRouterService } from '../model-router/model-router.service';

/**
 * One interactive element as perceived on the page. Indexed so the model can
 * reference it by number and the executor can re-select it by `data-eva-idx`.
 */
export interface NavElement {
  idx: number;
  kind: string;        // 'text' | 'email' | 'password' | 'button' | 'link' | 'select' | 'checkbox' …
  label: string;       // aria-label / placeholder / name / text (trimmed)
  value: string;       // current value for inputs (truncated)
  disabled: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: NavElement[];
  textSample: string;
  screenshotBase64?: string;
}

export type NavActionKind = 'click' | 'type' | 'wait' | 'done' | 'fail';

export interface NavAction {
  action: NavActionKind;
  target: number | null;
  value: string | null;
  reason: string;
}

export interface NavStep {
  snapshot: PageSnapshot;
  action: NavAction;
}

export interface NavResult {
  ok: boolean;
  reason: string;
  steps: NavStep[];
  finalUrl?: string;
}

export interface NavigateOptions {
  /** Max perceive→decide→act cycles. Keeps token cost bounded. */
  maxSteps?: number;
  /** ms to settle after each act before the next perceive. */
  settleMs?: number;
  /** Extra context appended to the goal (e.g. the email/code to enter). */
  context?: Record<string, string>;
  taskId?: string;
}

// Payment/checkout terms the navigator must never click on its own — those
// actions go through the Approval Engine, never the autonomous loop.
const PAYMENT_GUARD = /\b(pagar|paga|comprar|compra|checkout|place order|confirmar pago|pay now|purchase|order now|finalizar compra)\b/i;

const SYSTEM_PROMPT = [
  'Eres un copiloto de automatización web. Recibes un GOAL, la lista de ELEMENTS interactivos visibles en la página actual, y una captura de pantalla (screenshot) de la página.',
  'Elige la ÚNICA mejor acción siguiente. Responde SOLO con JSON estricto, sin texto adicional:',
  '{"action":"click|type|wait|done|fail","target":<índice del elemento o null>,"value":<string o null>,"reason":<string corto>}',
  'Reglas:',
  '- Usa la captura de pantalla para confirmar visualmente el estado de la página (modales, spinners de carga, errores que no aparecen en el texto o elementos deshabilitados).',
  '- "type" requiere target (índice de un input) y value (el texto a escribir).',
  '- "click" requiere target.',
  '- "done" cuando el GOAL ya está cumplido por el estado actual de la página.',
  '- "wait" si la página parece estar cargando y conviene esperar.',
  '- "fail" si ningún elemento permite avanzar hacia el GOAL o si la página muestra errores insalvables.',
  '- NUNCA elijas elementos cuyo label sugiera pago/compra/checkout. Si solo quedan esos, responde "fail".',
  '- Prefiere elementos habilitados (disabled=false).',
  '- No vuelvas a escribir en un campo que ya muestra el value correcto.',
].join('\n');

/**
 * SmartNavigatorService — perceive→decide→act loop driven by a CHEAP model.
 *
 * This is the reusable "agentic browser" primitive (Comet/Atlas style) but
 * server-side and cost-bounded: each step captures a compact digest of the
 * interactive elements, a cheap model picks one action, and we execute it via
 * the existing in-page primitives. Designed to be the robust fallback whenever
 * hardcoded selectors miss a layout/markup change.
 */
@Injectable()
export class SmartNavigatorService {
  private readonly logger = new Logger(SmartNavigatorService.name);

  constructor(
    private readonly browser: BrowserService,
    @Optional() private readonly models?: ModelRouterService,
  ) {}

  get available(): boolean {
    return Boolean(this.models);
  }

  async navigate(
    orgId: string,
    sessionId: string,
    goal: string,
    opts: NavigateOptions = {},
  ): Promise<NavResult> {
    const maxSteps = Math.min(Math.max(opts.maxSteps ?? 6, 1), 12);
    const settleMs = Math.min(Math.max(opts.settleMs ?? 1200, 300), 8000);
    const steps: NavStep[] = [];

    if (!this.models) {
      return { ok: false, reason: 'smart-navigator-unavailable: no model key configured', steps };
    }

    const fullGoal = opts.context && Object.keys(opts.context).length > 0
      ? `${goal}\nDatos disponibles: ${JSON.stringify(opts.context)}`
      : goal;

    for (let step = 0; step < maxSteps; step += 1) {
      await this.waitForPageStability(sessionId, orgId);
      const snapshot = await this.perceive(sessionId, orgId);

      if (snapshot.elements.length === 0) {
        // Nothing actionable yet — let the page settle and retry once more.
        await this.browser.wait(sessionId, orgId, settleMs);
        steps.push({ snapshot, action: { action: 'wait', target: null, value: null, reason: 'no interactive elements yet' } });
        continue;
      }

      const action = await this.decide(orgId, fullGoal, snapshot, steps, opts.taskId);
      steps.push({ snapshot, action });

      if (action.action === 'done') {
        return { ok: true, reason: action.reason || 'goal reached', steps, finalUrl: snapshot.url };
      }
      if (action.action === 'fail') {
        return { ok: false, reason: action.reason || 'navigator gave up', steps, finalUrl: snapshot.url };
      }
      if (action.action === 'wait') {
        await this.browser.wait(sessionId, orgId, settleMs);
        continue;
      }

      const target = action.target != null
        ? snapshot.elements.find((e) => e.idx === action.target)
        : undefined;
      if (!target) {
        this.logger.warn(`Navigator picked invalid target ${action.target}; skipping step`);
        continue;
      }
      if (PAYMENT_GUARD.test(target.label)) {
        return { ok: false, reason: `blocked: target "${target.label}" looks like a payment action (requires approval)`, steps, finalUrl: snapshot.url };
      }

      if (action.action === 'click') {
        await this.clickIdx(sessionId, orgId, target.idx);
      } else if (action.action === 'type') {
        await this.typeIdx(sessionId, orgId, target.idx, action.value ?? '');
      }
      await this.browser.wait(sessionId, orgId, settleMs);
    }

    return { ok: false, reason: `max steps (${maxSteps}) reached without completing goal`, steps };
  }

  // ── perceive ────────────────────────────────────────────────────────────

  private async perceive(sessionId: string, orgId: string): Promise<PageSnapshot> {
    try {
      const snapshot = await this.browser.evaluate<PageSnapshot>(sessionId, orgId, () => {
        const isVisible = (el: Element | null): boolean => {
          if (!el) return false;
          const he = el as HTMLElement;
          const s = window.getComputedStyle(he);
          const hasSize = he.offsetWidth > 0 || he.offsetHeight > 0 || he.getClientRects().length > 0;
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && hasSize;
        };
        const sel = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]';
        const all = Array.from(document.querySelectorAll(sel));
        const elements: Array<{ idx: number; kind: string; label: string; value: string; disabled: boolean }> = [];
        let idx = 0;
        for (const el of all) {
          if (idx >= 100) break;
          if (!isVisible(el)) continue;
          el.setAttribute('data-eva-idx', String(idx));
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') ?? '').toLowerCase();
          const role = (el.getAttribute('role') ?? '').toLowerCase();
          const kind = tag === 'input' ? (type || 'text') : tag === 'a' ? 'link' : (role || tag);
          const raw = el.getAttribute('aria-label')
            ?? el.getAttribute('placeholder')
            ?? el.getAttribute('name')
            ?? el.textContent
            ?? '';
          const label = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
          const inputVal = (el as HTMLInputElement).value;
          const value = typeof inputVal === 'string' ? inputVal.slice(0, 40) : '';
          const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
          elements.push({ idx, kind, label, value, disabled });
          idx += 1;
        }
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
        return { url: location.href, title: document.title, elements, textSample: text };
      });

      let screenshotBase64: string | undefined;
      try {
        const screenshot = await this.browser.screenshot(sessionId, orgId).catch(() => null);
        if (screenshot) {
          screenshotBase64 = screenshot.image_base64;
        }
      } catch (error) {
        this.logger.warn(`Failed to capture screenshot during perceive: ${(error as Error).message}`);
      }

      return {
        ...snapshot,
        screenshotBase64,
      };
    } catch (error) {
      this.logger.warn(`perceive failed: ${(error as Error).message}`);
      return { url: '', title: '', elements: [], textSample: '' };
    }
  }

  // ── decide ──────────────────────────────────────────────────────────────

  private async decide(
    orgId: string,
    goal: string,
    snapshot: PageSnapshot,
    priorSteps: NavStep[],
    taskId?: string,
  ): Promise<NavAction> {
    const recent = priorSteps.slice(-3).map((s) => `${s.action.action} ${s.action.target ?? ''} :: ${s.action.reason}`);
    const user = JSON.stringify({
      goal,
      url: snapshot.url,
      title: snapshot.title,
      page_text: snapshot.textSample,
      elements: snapshot.elements,
      recent_actions: recent,
    });

    try {
      const res = await this.models!.generate(user, {
        orgId,
        taskId,
        requestType: 'tools',
        budget: 'cheap',
        responseFormat: 'json',
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: 220,
        temperature: 0,
        imageBase64: snapshot.screenshotBase64,
        imageMimeType: 'image/png',
      });
      return this.parseAction(res.text);
    } catch (error) {
      this.logger.warn(`decide failed: ${(error as Error).message}`);
      return { action: 'fail', target: null, value: null, reason: `model error: ${(error as Error).message}` };
    }
  }

  private parseAction(raw: string): NavAction {
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Tolerate models that wrap JSON in prose or code fences
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { obj = JSON.parse(match[0]) as Record<string, unknown>; } catch { obj = null; }
      }
    }
    if (!obj || typeof obj !== 'object') {
      return { action: 'fail', target: null, value: null, reason: 'unparseable model response' };
    }
    const action = String(obj['action'] ?? '').toLowerCase() as NavActionKind;
    if (!['click', 'type', 'wait', 'done', 'fail'].includes(action)) {
      return { action: 'fail', target: null, value: null, reason: `unknown action "${obj['action']}"` };
    }
    const targetRaw = obj['target'];
    const target = typeof targetRaw === 'number' ? targetRaw
      : typeof targetRaw === 'string' && /^\d+$/.test(targetRaw) ? Number(targetRaw)
      : null;
    const value = obj['value'] == null ? null : String(obj['value']);
    const reason = String(obj['reason'] ?? '').slice(0, 200);
    return { action, target, value, reason };
  }

  // ── act ─────────────────────────────────────────────────────────────────

  private async clickIdx(sessionId: string, orgId: string, idx: number): Promise<boolean> {
    try {
      await this.browser.clickNow(sessionId, orgId, `[data-eva-idx="${idx}"]`);
      return true;
    } catch (error) {
      this.logger.warn(`Native click failed on index ${idx}, falling back to JS click: ${(error as Error).message}`);
      return this.browser.evaluate<boolean, { idx: number }>(sessionId, orgId, ({ idx }) => {
        const el = document.querySelector(`[data-eva-idx="${idx}"]`) as HTMLElement | null;
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }, { idx });
    }
  }

  private async typeIdx(sessionId: string, orgId: string, idx: number, text: string): Promise<boolean> {
    try {
      await this.browser.typeNow(sessionId, orgId, `[data-eva-idx="${idx}"]`, text);
      return true;
    } catch (error) {
      this.logger.warn(`Native type failed on index ${idx}, falling back to JS type: ${(error as Error).message}`);
      return this.browser.evaluate<boolean, { idx: number; text: string }>(sessionId, orgId, ({ idx, text }) => {
        const input = document.querySelector(`[data-eva-idx="${idx}"]`) as HTMLInputElement | null;
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        let current = '';
        for (const char of text) {
          current += char;
          if (setter) setter.call(input, current);
          input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, { idx, text });
    }
  }

  private async waitForPageStability(sessionId: string, orgId: string, maxWaitMs = 5000): Promise<void> {
    const startTime = Date.now();
    
    // 1. First ensure document.readyState === 'complete'
    await this.browser.evaluate(sessionId, orgId, () => {
      return new Promise<void>((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', () => resolve(), { once: true });
          setTimeout(resolve, 2000);
        }
      });
    }).catch(() => {});

    // 2. Wait for loading spinners/busy indicators to disappear (max 3 seconds of additional wait)
    let spinnerVisible = true;
    while (spinnerVisible && (Date.now() - startTime) < maxWaitMs) {
      spinnerVisible = await this.browser.evaluate(sessionId, orgId, () => {
        const spinnerSelectors = [
          '[class*="spinner" i]',
          '[class*="loading" i]',
          '[id*="loading" i]',
          '[id*="spinner" i]',
          '.loader',
          '.loading',
          '[aria-busy="true"]'
        ];
        for (const selector of spinnerSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements)) {
            const he = el as HTMLElement;
            const style = window.getComputedStyle(he);
            const isVisible = he.offsetWidth > 0 && he.offsetHeight > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            if (isVisible) {
              return true;
            }
          }
        }
        return false;
      }).catch(() => false);

      if (spinnerVisible) {
        await this.browser.wait(sessionId, orgId, 500);
      }
    }
  }
}
