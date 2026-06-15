import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrowserService } from './browser.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { DatabaseService } from '../database/database.service';

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
  selector?: string;
  rect?: { x: number; y: number; width: number; height: number };
  visibleText?: string;
  styles?: {
    color?: string;
    backgroundColor?: string;
    borderColor?: string;
    fontWeight?: string;
    opacity?: string;
  };
  state?: {
    ariaChecked?: string | null;
    ariaSelected?: string | null;
    ariaExpanded?: string | null;
    focused?: boolean;
  };
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: NavElement[];
  textSample: string;
  screenshotBase64?: string;
  fingerprint?: string;
  activeElement?: string;
  viewport?: { width: number; height: number; scrollX: number; scrollY: number };
  visualHints?: string[];
  domHints?: string[];
}

export type NavActionKind = 'click' | 'type' | 'scroll' | 'press' | 'back' | 'wait' | 'done' | 'fail';

export interface NavAction {
  action: NavActionKind;
  target: number | null;
  value: string | null;
  reason: string;
}

export interface NavStep {
  snapshot: PageSnapshot;
  action: NavAction;
  verification?: NavVerification;
  diagnostic?: BrowserDiagnosis;
  error?: string;
}

export interface NavResult {
  ok: boolean;
  reason: string;
  steps: NavStep[];
  finalUrl?: string;
  memory?: BrowserNavigationMemory;
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

export interface NavVerification {
  progressed: boolean;
  reason: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
}

export interface BrowserDiagnosis {
  current_state: string;
  visible_findings: string[];
  failure_reason: string;
  hypotheses: string[];
  next_strategy: string;
  suggested_action?: NavAction;
  confidence: number;
}

export interface BrowserNavigationMemory {
  sessionId: string;
  taskId?: string;
  goal: string;
  siteKey: string;
  currentState: string;
  lastUrl: string;
  lastFingerprint?: string;
  noProgressCount: number;
  attemptedActions: string[];
  failedActions: string[];
  workingSelectors: string[];
  failedSelectors: string[];
  visualFindings: string[];
  hypotheses: string[];
  nextStrategy: string;
  updatedAt: string;
}

interface SiteLearning {
  recorded_at?: string;
  value: string;
}

// Payment/checkout terms the navigator must never click on its own — those
// actions go through the Approval Engine, never the autonomous loop.
const PAYMENT_GUARD = /\b(pagar|paga|comprar|compra|checkout|place order|confirmar pago|pay now|purchase|order now|finalizar compra)\b/i;

const SYSTEM_PROMPT = [
  'Eres un copiloto de automatización web tipo navegador agente. Recibes un GOAL, memoria de sesión, aprendizajes del sitio, ELEMENTS interactivos visibles, DOM hints y una captura de pantalla.',
  'Elige la ÚNICA mejor acción siguiente. Responde SOLO con JSON estricto, sin texto adicional:',
  '{"action":"click|type|scroll|press|back|wait|done|fail","target":<índice del elemento o null>,"value":<string o null>,"reason":<string corto>}',
  'Reglas:',
  '- Usa la captura de pantalla para confirmar visualmente el estado de la página (modales, spinners de carga, errores que no aparecen en el texto o elementos deshabilitados).',
  '- Usa DOM hints, labels, roles, selectores y estilos para razonar dónde hacer click; no dependas solo del texto.',
  '- Usa MEMORY para no repetir acciones fallidas y para continuar desde donde te quedaste.',
  '- Usa SITE_LEARNINGS como pistas, no como verdad absoluta; verifica contra la página actual.',
  '- "type" requiere target (índice de un input) y value (el texto a escribir).',
  '- "click" requiere target.',
  '- "scroll" usa value "up" o "down".',
  '- "press" usa value con una tecla simple como "Enter", "Escape", "Tab", "ArrowDown".',
  '- "back" vuelve atrás si entraste a una vista equivocada.',
  '- "done" cuando el GOAL ya está cumplido por el estado actual de la página.',
  '- "wait" si la página parece estar cargando y conviene esperar.',
  '- "fail" si ningún elemento permite avanzar hacia el GOAL o si la página muestra errores insalvables.',
  '- NUNCA elijas elementos cuyo label sugiera pago/compra/checkout. Si solo quedan esos, responde "fail".',
  '- Prefiere elementos habilitados (disabled=false).',
  '- No vuelvas a escribir en un campo que ya muestra el value correcto.',
].join('\n');

const DIAGNOSE_PROMPT = [
  'Eres el módulo de diagnóstico visual de un navegador agente.',
  'Cuando una acción falla, no hay progreso, o el DOM no basta, interpreta screenshot + DOM + memoria.',
  'Responde SOLO JSON estricto:',
  '{"current_state":"...","visible_findings":["..."],"failure_reason":"...","hypotheses":["..."],"next_strategy":"...","suggested_action":{"action":"click|type|scroll|press|back|wait|done|fail","target":0,"value":null,"reason":"..."},"confidence":0.0}',
  'Reglas:',
  '- Si ves badges, colores, modales, errores, carga, bloqueos, QR o estados visuales, menciónalos en visible_findings.',
  '- Si el DOM y la imagen discrepan, prioriza la imagen pero usa selectores/labels del DOM para escoger target.',
  '- No sugieras pago/checkout/compra.',
  '- Si no hay acción segura, suggested_action debe ser fail o wait.',
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
    @Optional() private readonly db?: DatabaseService,
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
    let memory = await this.loadMemory(orgId, sessionId, goal, opts.taskId);
    let siteLearnings: SiteLearning[] = [];

    for (let step = 0; step < maxSteps; step += 1) {
      await this.waitForPageStability(sessionId, orgId);
      const snapshot = await this.perceive(sessionId, orgId);
      const siteKey = this.siteKey(snapshot.url);
      if (!siteLearnings.length && siteKey !== 'unknown') {
        siteLearnings = await this.loadSiteLearnings(orgId, siteKey);
      }
      memory = this.mergeMemory(memory, snapshot, goal, opts.taskId, siteKey);

      if (snapshot.elements.length === 0) {
        const diagnostic = await this.diagnose(orgId, fullGoal, snapshot, steps, memory, siteLearnings, 'no interactive elements yet', opts.taskId);
        memory = this.applyDiagnosis(memory, diagnostic);
        await this.saveMemory(orgId, opts.taskId, sessionId, memory);
        await this.browser.wait(sessionId, orgId, settleMs);
        steps.push({ snapshot, action: { action: 'wait', target: null, value: null, reason: 'no interactive elements yet' }, diagnostic });
        continue;
      }

      const action = await this.decide(orgId, fullGoal, snapshot, steps, memory, siteLearnings, opts.taskId);
      const stepRecord: NavStep = { snapshot, action };
      steps.push(stepRecord);
      memory = this.recordAttempt(memory, action, snapshot);

      if (action.action === 'done') {
        memory.currentState = action.reason || memory.currentState || 'goal reached';
        memory.noProgressCount = 0;
        await this.saveMemory(orgId, opts.taskId, sessionId, memory);
        return { ok: true, reason: action.reason || 'goal reached', steps, finalUrl: snapshot.url, memory };
      }
      if (action.action === 'fail') {
        const diagnostic = await this.diagnose(orgId, fullGoal, snapshot, steps, memory, siteLearnings, action.reason || 'model chose fail', opts.taskId);
        stepRecord.diagnostic = diagnostic;
        memory = this.applyDiagnosis(memory, diagnostic);
        await this.saveMemory(orgId, opts.taskId, sessionId, memory);
        if (diagnostic.suggested_action && diagnostic.suggested_action.action !== 'fail' && step < maxSteps - 1) {
          continue;
        }
        return { ok: false, reason: diagnostic.failure_reason || action.reason || 'navigator gave up', steps, finalUrl: snapshot.url, memory };
      }
      if (action.action === 'wait') {
        await this.browser.wait(sessionId, orgId, settleMs);
        await this.saveMemory(orgId, opts.taskId, sessionId, memory);
        continue;
      }

      try {
        await this.executeAction(sessionId, orgId, snapshot, action);
      } catch (error) {
        const message = (error as Error).message;
        stepRecord.error = message;
        if (/payment action|requires approval/i.test(message)) {
          memory = this.recordFailure(memory, action, snapshot, message);
          await this.saveMemory(orgId, opts.taskId, sessionId, memory);
          return { ok: false, reason: message, steps, finalUrl: snapshot.url, memory };
        }
        memory = this.recordFailure(memory, action, snapshot, message);
        const diagnostic = await this.diagnose(orgId, fullGoal, snapshot, steps, memory, siteLearnings, message, opts.taskId);
        stepRecord.diagnostic = diagnostic;
        memory = this.applyDiagnosis(memory, diagnostic);
        await this.saveMemory(orgId, opts.taskId, sessionId, memory);
        continue;
      }

      await this.browser.wait(sessionId, orgId, settleMs);
      const afterSnapshot = await this.perceive(sessionId, orgId);
      const verification = this.verifyProgress(snapshot, afterSnapshot, action);
      stepRecord.verification = verification;
      memory = this.applyVerification(memory, action, snapshot, afterSnapshot, verification);

      if (!verification.progressed || memory.noProgressCount >= 2) {
        const diagnostic = await this.diagnose(orgId, fullGoal, afterSnapshot, steps, memory, siteLearnings, verification.reason, opts.taskId);
        stepRecord.diagnostic = diagnostic;
        memory = this.applyDiagnosis(memory, diagnostic);
      } else {
        await this.saveSiteLearning(orgId, memory.siteKey, action, snapshot, afterSnapshot, memory);
      }
      await this.saveMemory(orgId, opts.taskId, sessionId, memory);
    }

    return { ok: false, reason: `max steps (${maxSteps}) reached without completing goal`, steps, memory };
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
        const cssPath = (el: Element): string => {
          const parts: string[] = [];
          let node: Element | null = el;
          while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
            const tag = node.tagName.toLowerCase();
            const id = node.getAttribute('id');
            if (id && !/[{}"'`]/.test(id)) {
              parts.unshift(`${tag}#${CSS.escape(id)}`);
              break;
            }
            const dataAttr = node.hasAttribute('data-testid')
              ? 'data-testid'
              : node.hasAttribute('data-test')
                ? 'data-test'
                : node.hasAttribute('data-qa')
                  ? 'data-qa'
                  : null;
            const dataTest = dataAttr ? node.getAttribute(dataAttr) : null;
            if (dataTest && !/[{}"'`]/.test(dataTest)) {
              parts.unshift(`${tag}[${dataAttr}="${CSS.escape(dataTest)}"]`);
              break;
            }
            const parent: Element | null = node.parentElement;
            if (!parent) {
              parts.unshift(tag);
              break;
            }
            const siblings = Array.from(parent.children) as Element[];
            const sameTag = siblings.filter((child: Element) => child.tagName === node!.tagName);
            const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : '';
            parts.unshift(`${tag}${nth}`);
            node = parent;
          }
          return parts.join(' > ');
        };
        const describeElement = (el: Element | null): string => {
          if (!el) return '';
          const he = el as HTMLElement;
          return [
            el.tagName.toLowerCase(),
            el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '',
            el.getAttribute('aria-label') ? `[aria-label=${el.getAttribute('aria-label')}]` : '',
            he.innerText ? he.innerText.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
          ].filter(Boolean).join(' ');
        };
        const sel = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]';
        const all = Array.from(document.querySelectorAll(sel));
        const elements: Array<NavElement> = [];
        let idx = 0;
        for (const el of all) {
          if (idx >= 100) break;
          if (!isVisible(el)) continue;
          el.setAttribute('data-eva-idx', String(idx));
          const he = el as HTMLElement;
          const rect = he.getBoundingClientRect();
          const style = window.getComputedStyle(he);
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
          elements.push({
            idx,
            kind,
            label,
            value,
            disabled,
            selector: cssPath(el),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            visibleText: (he.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
            styles: {
              color: style.color,
              backgroundColor: style.backgroundColor,
              borderColor: style.borderColor,
              fontWeight: style.fontWeight,
              opacity: style.opacity,
            },
            state: {
              ariaChecked: el.getAttribute('aria-checked'),
              ariaSelected: el.getAttribute('aria-selected'),
              ariaExpanded: el.getAttribute('aria-expanded'),
              focused: document.activeElement === el,
            },
          });
          idx += 1;
        }
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
        const visualHints: string[] = [];
        const bodyText = text.toLowerCase();
        if (/qr|scan|escanea|vincular|link a device/.test(bodyText)) visualHints.push('possible QR/link-device state');
        if (/captcha|verifica que eres humano|robot/.test(bodyText)) visualHints.push('possible captcha/human verification');
        if (/loading|cargando|please wait/.test(bodyText)) visualHints.push('possible loading state');
        if (/error|failed|fall[oó]|no se pudo/.test(bodyText)) visualHints.push('visible error text');
        const domHints = elements.slice(0, 30).map((e) => `#${e.idx} ${e.kind} "${e.label || e.visibleText || '(sin label)'}" ${e.selector ?? ''}`.trim());
        const fingerprintSource = JSON.stringify({
          url: location.href,
          title: document.title,
          text: text.slice(0, 600),
          elements: elements.slice(0, 20).map((e) => [e.kind, e.label, e.value, e.disabled]),
          scroll: [window.scrollX, window.scrollY],
        });
        let hash = 0;
        for (let i = 0; i < fingerprintSource.length; i += 1) {
          hash = ((hash << 5) - hash) + fingerprintSource.charCodeAt(i);
          hash |= 0;
        }
        return {
          url: location.href,
          title: document.title,
          elements,
          textSample: text,
          fingerprint: String(hash),
          activeElement: describeElement(document.activeElement),
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
          },
          visualHints,
          domHints,
        };
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
    memory: BrowserNavigationMemory,
    siteLearnings: SiteLearning[],
    taskId?: string,
  ): Promise<NavAction> {
    const recent = priorSteps.slice(-3).map((s) => `${s.action.action} ${s.action.target ?? ''} :: ${s.action.reason}`);
    const user = JSON.stringify({
      goal,
      url: snapshot.url,
      title: snapshot.title,
      page_text: snapshot.textSample,
      dom_hints: snapshot.domHints,
      visual_hints: snapshot.visualHints,
      active_element: snapshot.activeElement,
      viewport: snapshot.viewport,
      elements: snapshot.elements,
      memory,
      site_learnings: siteLearnings.slice(0, 5).map((learning) => learning.value),
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

  private async diagnose(
    orgId: string,
    goal: string,
    snapshot: PageSnapshot,
    priorSteps: NavStep[],
    memory: BrowserNavigationMemory,
    siteLearnings: SiteLearning[],
    trigger: string,
    taskId?: string,
  ): Promise<BrowserDiagnosis> {
    const input = JSON.stringify({
      trigger,
      goal,
      url: snapshot.url,
      title: snapshot.title,
      page_text: snapshot.textSample.slice(0, 3000),
      dom_hints: snapshot.domHints,
      visual_hints: snapshot.visualHints,
      active_element: snapshot.activeElement,
      viewport: snapshot.viewport,
      elements: snapshot.elements,
      memory,
      site_learnings: siteLearnings.slice(0, 5).map((learning) => learning.value),
      recent_steps: priorSteps.slice(-5).map((step) => ({
        action: step.action,
        verification: step.verification,
        error: step.error,
        diagnostic: step.diagnostic ? {
          state: step.diagnostic.current_state,
          failure: step.diagnostic.failure_reason,
          strategy: step.diagnostic.next_strategy,
        } : undefined,
      })),
    });

    try {
      const result = await this.models!.generate(input, {
        orgId,
        taskId,
        requestType: 'tools',
        budget: 'cheap',
        responseFormat: 'json',
        systemPrompt: DIAGNOSE_PROMPT,
        maxTokens: 420,
        temperature: 0,
        imageBase64: snapshot.screenshotBase64,
        imageMimeType: 'image/png',
      });
      return this.parseDiagnosis(result.text);
    } catch (error) {
      return {
        current_state: memory.currentState || 'unknown',
        visible_findings: snapshot.visualHints ?? [],
        failure_reason: `diagnosis model error: ${(error as Error).message}`,
        hypotheses: ['El navegador no pudo diagnosticar con modelo de visión.'],
        next_strategy: 'Reintentar con una observación nueva o pedir intervención si el bloqueo persiste.',
        suggested_action: { action: 'wait', target: null, value: null, reason: 'diagnosis unavailable' },
        confidence: 0,
      };
    }
  }

  private parseDiagnosis(raw: string): BrowserDiagnosis {
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { obj = JSON.parse(match[0]) as Record<string, unknown>; } catch { obj = null; }
      }
    }
    if (!obj) {
      return {
        current_state: 'unknown',
        visible_findings: [],
        failure_reason: 'unparseable diagnosis response',
        hypotheses: [],
        next_strategy: 'Tomar una observación nueva y evitar repetir la misma acción.',
        suggested_action: { action: 'wait', target: null, value: null, reason: 'unparseable diagnosis' },
        confidence: 0,
      };
    }
    const suggestedRaw = obj['suggested_action'];
    const suggested = suggestedRaw && typeof suggestedRaw === 'object'
      ? this.parseAction(JSON.stringify(suggestedRaw))
      : undefined;
    const confidenceRaw = Number(obj['confidence'] ?? 0);
    return {
      current_state: String(obj['current_state'] ?? 'unknown').slice(0, 120),
      visible_findings: this.stringArray(obj['visible_findings'], 8),
      failure_reason: String(obj['failure_reason'] ?? 'diagnosis did not explain failure').slice(0, 300),
      hypotheses: this.stringArray(obj['hypotheses'], 5),
      next_strategy: String(obj['next_strategy'] ?? 'try a different strategy').slice(0, 300),
      suggested_action: suggested,
      confidence: Number.isFinite(confidenceRaw) ? Math.min(Math.max(confidenceRaw, 0), 1) : 0,
    };
  }

  private async executeAction(sessionId: string, orgId: string, snapshot: PageSnapshot, action: NavAction): Promise<void> {
    if (action.action === 'click' || action.action === 'type') {
      const target = action.target != null
        ? snapshot.elements.find((e) => e.idx === action.target)
        : undefined;
      if (!target) {
        throw new Error(`Navigator picked invalid target ${action.target}`);
      }
      if (PAYMENT_GUARD.test(target.label) || PAYMENT_GUARD.test(target.visibleText ?? '')) {
        throw new Error(`blocked: target "${target.label || target.visibleText}" looks like a payment action (requires approval)`);
      }
      if (action.action === 'click') {
        await this.clickIdx(sessionId, orgId, target.idx);
      } else {
        await this.typeIdx(sessionId, orgId, target.idx, action.value ?? '');
      }
      return;
    }

    if (action.action === 'scroll') {
      const direction = /up/i.test(action.value ?? '') ? 'up' : 'down';
      await this.browser.evaluate<void, { direction: string }>(sessionId, orgId, ({ direction }) => {
        window.scrollBy({ top: direction === 'up' ? -Math.round(window.innerHeight * 0.75) : Math.round(window.innerHeight * 0.75), behavior: 'smooth' });
      }, { direction });
      return;
    }

    if (action.action === 'press') {
      const key = String(action.value ?? '').trim();
      if (!key) throw new Error('press action requires value key');
      await this.browser.pressKey(sessionId, orgId, key);
      return;
    }

    if (action.action === 'back') {
      await this.browser.evaluate<void>(sessionId, orgId, () => {
        window.history.back();
      });
      return;
    }
  }

  private verifyProgress(before: PageSnapshot, after: PageSnapshot, action: NavAction): NavVerification {
    if (action.action === 'wait') return { progressed: true, reason: 'wait action completed', beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint };
    if (before.url !== after.url) {
      return { progressed: true, reason: 'url changed', beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint };
    }
    if (before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint) {
      return { progressed: true, reason: 'page fingerprint changed', beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint };
    }
    if (action.action === 'type' && action.target != null) {
      const afterTarget = after.elements.find((el) => el.idx === action.target);
      if (afterTarget?.value && action.value && afterTarget.value.includes(action.value.slice(0, 20))) {
        return { progressed: true, reason: 'target input contains typed value', beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint };
      }
    }
    const beforeScroll = before.viewport?.scrollY ?? 0;
    const afterScroll = after.viewport?.scrollY ?? 0;
    if (Math.abs(afterScroll - beforeScroll) > 20) {
      return { progressed: true, reason: 'scroll position changed', beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint };
    }
    return {
      progressed: false,
      reason: `no observable progress after ${action.action}`,
      beforeFingerprint: before.fingerprint,
      afterFingerprint: after.fingerprint,
    };
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

  private async loadMemory(orgId: string, sessionId: string, goal: string, taskId?: string): Promise<BrowserNavigationMemory> {
    const fallback = this.newMemory(sessionId, goal, taskId);
    if (!this.db || !taskId) return fallback;
    try {
      const { data } = await this.db.admin
        .from('tasks')
        .select('metadata')
        .eq('id', taskId)
        .eq('org_id', orgId)
        .maybeSingle();
      const meta = (data?.metadata ?? {}) as Record<string, unknown>;
      const bySession = (meta['browser_memory'] ?? {}) as Record<string, BrowserNavigationMemory>;
      const existing = bySession[sessionId];
      if (!existing) return fallback;
      return {
        ...fallback,
        ...existing,
        goal,
        sessionId,
        taskId,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn(`Could not load browser memory: ${(error as Error).message}`);
      return fallback;
    }
  }

  private async saveMemory(orgId: string, taskId: string | undefined, sessionId: string, memory: BrowserNavigationMemory): Promise<void> {
    if (!this.db || !taskId) return;
    try {
      const { data } = await this.db.admin
        .from('tasks')
        .select('metadata')
        .eq('id', taskId)
        .eq('org_id', orgId)
        .maybeSingle();
      const meta = (data?.metadata ?? {}) as Record<string, unknown>;
      const existing = (meta['browser_memory'] ?? {}) as Record<string, BrowserNavigationMemory>;
      const nextMemory = {
        ...existing,
        [sessionId]: {
          ...memory,
          updatedAt: new Date().toISOString(),
          attemptedActions: this.cap(memory.attemptedActions, 30),
          failedActions: this.cap(memory.failedActions, 20),
          workingSelectors: this.cap(memory.workingSelectors, 20),
          failedSelectors: this.cap(memory.failedSelectors, 20),
          visualFindings: this.cap(memory.visualFindings, 30),
          hypotheses: this.cap(memory.hypotheses, 20),
        },
      };
      const keys = Object.keys(nextMemory).slice(-5);
      const trimmed = Object.fromEntries(keys.map((key) => [key, nextMemory[key]]));
      await this.db.admin
        .from('tasks')
        .update({ metadata: { ...meta, browser_memory: trimmed } })
        .eq('id', taskId)
        .eq('org_id', orgId);
    } catch (error) {
      this.logger.warn(`Could not save browser memory: ${(error as Error).message}`);
    }
  }

  private async loadSiteLearnings(orgId: string, siteKey: string): Promise<SiteLearning[]> {
    if (!this.db || siteKey === 'unknown') return [];
    try {
      const { data, error } = await this.db.admin
        .from('agent_data_log')
        .select('recorded_at, value')
        .eq('org_id', orgId)
        .eq('key', `browser:site:${siteKey}`)
        .order('recorded_at', { ascending: false })
        .limit(5);
      if (error) {
        this.logger.warn(`Could not load site learnings: ${error.message}`);
        return [];
      }
      return (data ?? []) as SiteLearning[];
    } catch (error) {
      this.logger.warn(`Could not load site learnings: ${(error as Error).message}`);
      return [];
    }
  }

  private async saveSiteLearning(
    orgId: string,
    siteKey: string,
    action: NavAction,
    before: PageSnapshot,
    after: PageSnapshot,
    memory: BrowserNavigationMemory,
  ): Promise<void> {
    if (!this.db || siteKey === 'unknown' || !['click', 'type', 'scroll', 'press', 'back'].includes(action.action)) return;
    const target = action.target != null ? before.elements.find((el) => el.idx === action.target) : undefined;
    const value = JSON.stringify({
      site: siteKey,
      goal: memory.goal.slice(0, 160),
      state: memory.currentState,
      action: action.action,
      target_label: target?.label || target?.visibleText || null,
      selector: target?.selector || null,
      reason: action.reason,
      from_url: before.url,
      to_url: after.url,
      next_strategy: memory.nextStrategy,
    });
    try {
      await this.db.admin
        .from('agent_data_log')
        .insert({ org_id: orgId, key: `browser:site:${siteKey}`, value });
    } catch (error) {
      this.logger.warn(`Could not save site learning: ${(error as Error).message}`);
    }
  }

  private newMemory(sessionId: string, goal: string, taskId?: string): BrowserNavigationMemory {
    return {
      sessionId,
      taskId,
      goal,
      siteKey: 'unknown',
      currentState: 'starting',
      lastUrl: '',
      lastFingerprint: undefined,
      noProgressCount: 0,
      attemptedActions: [],
      failedActions: [],
      workingSelectors: [],
      failedSelectors: [],
      visualFindings: [],
      hypotheses: [],
      nextStrategy: 'Observe the page and choose the safest next action.',
      updatedAt: new Date().toISOString(),
    };
  }

  private mergeMemory(
    memory: BrowserNavigationMemory,
    snapshot: PageSnapshot,
    goal: string,
    taskId: string | undefined,
    siteKey: string,
  ): BrowserNavigationMemory {
    return {
      ...memory,
      taskId,
      goal,
      siteKey,
      lastUrl: snapshot.url,
      lastFingerprint: snapshot.fingerprint,
      visualFindings: this.uniqueCap([...(memory.visualFindings ?? []), ...(snapshot.visualHints ?? [])], 30),
      updatedAt: new Date().toISOString(),
    };
  }

  private recordAttempt(memory: BrowserNavigationMemory, action: NavAction, snapshot: PageSnapshot): BrowserNavigationMemory {
    const target = action.target != null ? snapshot.elements.find((el) => el.idx === action.target) : undefined;
    const label = target ? `${target.kind}:${target.label || target.visibleText || target.selector || target.idx}` : '';
    return {
      ...memory,
      attemptedActions: this.uniqueCap([...memory.attemptedActions, `${action.action}${label ? `:${label}` : ''}:${action.reason}`], 30),
      updatedAt: new Date().toISOString(),
    };
  }

  private recordFailure(memory: BrowserNavigationMemory, action: NavAction, snapshot: PageSnapshot, reason: string): BrowserNavigationMemory {
    const target = action.target != null ? snapshot.elements.find((el) => el.idx === action.target) : undefined;
    return {
      ...memory,
      failedActions: this.uniqueCap([...memory.failedActions, `${action.action}:${action.reason}:${reason}`], 20),
      failedSelectors: target?.selector ? this.uniqueCap([...memory.failedSelectors, target.selector], 20) : memory.failedSelectors,
      noProgressCount: memory.noProgressCount + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  private applyVerification(
    memory: BrowserNavigationMemory,
    action: NavAction,
    before: PageSnapshot,
    after: PageSnapshot,
    verification: NavVerification,
  ): BrowserNavigationMemory {
    const target = action.target != null ? before.elements.find((el) => el.idx === action.target) : undefined;
    return {
      ...memory,
      currentState: verification.progressed ? `progressed: ${verification.reason}` : memory.currentState,
      lastUrl: after.url,
      lastFingerprint: after.fingerprint,
      noProgressCount: verification.progressed ? 0 : memory.noProgressCount + 1,
      workingSelectors: verification.progressed && target?.selector
        ? this.uniqueCap([...memory.workingSelectors, target.selector], 20)
        : memory.workingSelectors,
      failedSelectors: !verification.progressed && target?.selector
        ? this.uniqueCap([...memory.failedSelectors, target.selector], 20)
        : memory.failedSelectors,
      updatedAt: new Date().toISOString(),
    };
  }

  private applyDiagnosis(memory: BrowserNavigationMemory, diagnosis: BrowserDiagnosis): BrowserNavigationMemory {
    return {
      ...memory,
      currentState: diagnosis.current_state || memory.currentState,
      visualFindings: this.uniqueCap([...memory.visualFindings, ...diagnosis.visible_findings], 30),
      hypotheses: this.uniqueCap([...memory.hypotheses, ...diagnosis.hypotheses], 20),
      nextStrategy: diagnosis.next_strategy || memory.nextStrategy,
      updatedAt: new Date().toISOString(),
    };
  }

  private siteKey(rawUrl: string): string {
    try {
      const host = new URL(rawUrl).hostname.replace(/^www\./, '');
      return host || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private stringArray(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, max);
  }

  private cap<T>(items: T[], max: number): T[] {
    return items.slice(Math.max(0, items.length - max));
  }

  private uniqueCap(items: string[], max: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items.filter(Boolean)) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return this.cap(out, max);
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
