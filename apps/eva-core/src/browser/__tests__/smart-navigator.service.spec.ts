import { Test, TestingModule } from '@nestjs/testing';
import { BrowserService } from '../browser.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { SmartNavigatorService, PageSnapshot } from '../smart-navigator.service';
import { DatabaseService } from '../../database/database.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const methodChoice: PageSnapshot = {
  url: 'https://auth.uber.com/v2',
  title: 'Sign in',
  textSample: 'Choose how to continue',
  elements: [
    { idx: 0, kind: 'button', label: 'Continue with Google', value: '', disabled: false },
    { idx: 1, kind: 'button', label: 'Continue with phone', value: '', disabled: false },
    { idx: 2, kind: 'button', label: 'Continue with email', value: '', disabled: false },
  ],
};

const emailForm: PageSnapshot = {
  url: 'https://auth.uber.com/v2/email',
  title: 'Sign in',
  textSample: 'Enter your email',
  elements: [
    { idx: 0, kind: 'email', label: 'Email address', value: '', disabled: false },
    { idx: 1, kind: 'button', label: 'Continue', value: '', disabled: false },
  ],
};

describe('SmartNavigatorService', () => {
  let service: SmartNavigatorService;
  let browser: {
    evaluate: jest.Mock;
    wait: jest.Mock;
    screenshot: jest.Mock;
    clickNow: jest.Mock;
    typeNow: jest.Mock;
    pressKey: jest.Mock;
  };
  let models: { generate: jest.Mock };
  let db: { admin: { from: jest.Mock } };

  async function build(): Promise<void> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartNavigatorService,
        { provide: BrowserService, useValue: browser },
        { provide: ModelRouterService, useValue: models },
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();
    service = module.get(SmartNavigatorService);
  }

  beforeEach(() => {
    browser = {
      evaluate: jest.fn(),
      wait: jest.fn().mockResolvedValue(undefined),
      screenshot: jest.fn().mockResolvedValue({ image_base64: 'mocked-base64' }),
      clickNow: jest.fn().mockRejectedValue(new Error('native click failed')),
      typeNow: jest.fn().mockRejectedValue(new Error('native type failed')),
      pressKey: jest.fn().mockResolvedValue(undefined),
    };
    models = { generate: jest.fn() };
    db = {
      admin: {
        from: jest.fn().mockImplementation((table: string) => {
          if (table === 'tasks') {
            const builder = {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: { metadata: {} }, error: null }),
              update: jest.fn().mockReturnThis(),
            };
            return builder;
          }
          const builder = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue({ data: [], error: null }),
            insert: jest.fn().mockResolvedValue({ error: null }),
          };
          return builder;
        }),
      },
    };
  });

  it('clicks "continue with email" then reports done — never picking a payment element', async () => {
    // perceive() calls evaluate with no arg; click/type pass an arg object.
    const snapshots = [methodChoice, emailForm];
    browser.evaluate.mockImplementation(async (_sid: string, _org: string, fn: any, arg?: unknown) => {
      const fnStr = fn ? fn.toString() : '';
      if (fnStr.includes('readyState') || fnStr.includes('spinner')) {
        return;
      }
      if (arg === undefined) return snapshots.shift() ?? emailForm;
      return true; // click/type executors
    });
    models.generate
      .mockResolvedValueOnce({ text: JSON.stringify({ action: 'click', target: 2, value: null, reason: 'email option' }), model: 'm', backend: 'google', usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ action: 'done', target: null, value: null, reason: 'email form visible' }), model: 'm', backend: 'google', usage: {} });

    await build();
    const result = await service.navigate(ORG, SESSION, 'reach the email login form', { maxSteps: 4, settleMs: 300 });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].action.action).toBe('click');
    expect(result.steps[0].action.target).toBe(2);
    // executed exactly one click between the two perceives
    const clickCalls = browser.evaluate.mock.calls.filter((c) => c[3] !== undefined);
    expect(clickCalls).toHaveLength(1);
    expect(clickCalls[0][3]).toEqual({ idx: 2 });
  });

  it('refuses to click a payment-looking element and fails safe', async () => {
    const checkoutPage: PageSnapshot = {
      url: 'https://example.com/cart',
      title: 'Cart',
      textSample: 'Your cart',
      elements: [{ idx: 0, kind: 'button', label: 'Pagar ahora', value: '', disabled: false }],
    };
    browser.evaluate.mockImplementation(async (_sid: string, _org: string, fn: any, arg?: unknown) => {
      const fnStr = fn ? fn.toString() : '';
      if (fnStr.includes('readyState') || fnStr.includes('spinner')) {
        return;
      }
      if (arg === undefined) return checkoutPage;
      return true;
    });
    models.generate.mockResolvedValue({ text: JSON.stringify({ action: 'click', target: 0, value: null, reason: 'pay' }), model: 'm', backend: 'google', usage: {} });

    await build();
    const result = await service.navigate(ORG, SESSION, 'complete the purchase', { maxSteps: 2, settleMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/payment/i);
    // never executed a click (no evaluate call with an arg)
    expect(browser.evaluate.mock.calls.filter((c) => c[3] !== undefined)).toHaveLength(0);
  });

  it('is unavailable (no-op) when no model is injected', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartNavigatorService,
        { provide: BrowserService, useValue: browser },
      ],
    }).compile();
    const noModel = module.get(SmartNavigatorService);

    expect(noModel.available).toBe(false);
    const result = await noModel.navigate(ORG, SESSION, 'anything');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unavailable/);
  });

  it('calls native clickNow and typeNow when they succeed without falling back', async () => {
    browser.evaluate.mockImplementation(async (_sid: string, _org: string, fn: any, arg?: unknown) => {
      const fnStr = fn ? fn.toString() : '';
      if (fnStr.includes('readyState') || fnStr.includes('spinner')) {
        return;
      }
      return emailForm;
    });
    browser.clickNow.mockResolvedValue(undefined);
    browser.typeNow.mockResolvedValue(undefined);
    
    models.generate.mockResolvedValueOnce({
      text: JSON.stringify({ action: 'click', target: 1, value: null, reason: 'native click' }),
      model: 'm',
      backend: 'google',
      usage: {},
    });

    await build();
    const result = await service.navigate(ORG, SESSION, 'click email continue', { maxSteps: 1, settleMs: 300 });

    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, '[data-eva-idx="1"]');
    // evaluate was only called for perceive, not for the click effect
    const evaluateCalls = browser.evaluate.mock.calls.filter((c) => c[3] !== undefined);
    expect(evaluateCalls).toHaveLength(0);
  });

  it('accepts keyboard/navigation actions emitted by the model', async () => {
    browser.evaluate.mockImplementation(async (_sid: string, _org: string, fn: any, arg?: unknown) => {
      const fnStr = fn ? fn.toString() : '';
      if (fnStr.includes('readyState') || fnStr.includes('spinner')) return;
      if (arg === undefined) return emailForm;
      return true;
    });
    models.generate.mockResolvedValueOnce({
      text: JSON.stringify({ action: 'press', target: null, value: 'ArrowDown', reason: 'select first autocomplete option' }),
      model: 'm',
      backend: 'google',
      usage: {},
    });

    await build();
    const result = await service.navigate(ORG, SESSION, 'choose the first autocomplete result', { maxSteps: 1, settleMs: 300 });

    expect(result.steps[0].action.action).toBe('press');
    expect(browser.pressKey).toHaveBeenCalledWith(SESSION, ORG, 'ArrowDown');
  });

  it('diagnoses visually and persists navigation memory when an action makes no progress', async () => {
    const samePage: PageSnapshot = {
      url: 'https://web.whatsapp.com/',
      title: 'WhatsApp',
      textSample: 'Chats',
      fingerprint: 'same',
      visualHints: ['chat list visible'],
      domHints: ['#0 button "Ana"'],
      elements: [
        { idx: 0, kind: 'button', label: 'Ana', value: '', disabled: false, selector: 'button:nth-of-type(1)' },
      ],
    };
    browser.evaluate.mockImplementation(async (_sid: string, _org: string, fn: any, arg?: unknown) => {
      const fnStr = fn ? fn.toString() : '';
      if (fnStr.includes('readyState') || fnStr.includes('spinner')) return;
      if (arg === undefined) return samePage;
      return true;
    });
    browser.clickNow.mockResolvedValue(undefined);
    models.generate
      .mockResolvedValueOnce({ text: JSON.stringify({ action: 'click', target: 0, value: null, reason: 'open Ana chat' }), model: 'm', backend: 'google', usage: {} })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          current_state: 'whatsapp_chat_list',
          visible_findings: ['Ana sigue visible; el click no abrió el chat'],
          failure_reason: 'no observable progress after click',
          hypotheses: ['selector may hit a nested inactive node'],
          next_strategy: 'try pressing Enter or click a different chat row target',
          suggested_action: { action: 'press', target: null, value: 'Enter', reason: 'activate focused row' },
          confidence: 0.72,
        }),
        model: 'm',
        backend: 'google',
        usage: {},
      });

    await build();
    const result = await service.navigate(ORG, SESSION, 'open Ana chat', { maxSteps: 1, settleMs: 300, taskId: 'task-1' });

    expect(result.ok).toBe(false);
    expect(result.steps[0].verification?.progressed).toBe(false);
    expect(result.steps[0].diagnostic?.current_state).toBe('whatsapp_chat_list');
    expect(result.memory?.nextStrategy).toContain('pressing Enter');
    const taskBuilders = db.admin.from.mock.results.map((r) => r.value).filter((builder) => builder.update);
    expect(taskBuilders.some((builder) => builder.update.mock.calls.some((call: any[]) => (
      call[0]?.metadata?.browser_memory
    )))).toBe(true);
  });

  it('loads and writes site learnings for successful browser actions', async () => {
    const after: PageSnapshot = { ...emailForm, url: 'https://auth.uber.com/v2/email', fingerprint: 'after' };
    const before: PageSnapshot = { ...methodChoice, fingerprint: 'before' };
    const snapshots = [before, after, after];
    browser.evaluate.mockImplementation(async (_sid: string, _org: string, fn: any, arg?: unknown) => {
      const fnStr = fn ? fn.toString() : '';
      if (fnStr.includes('readyState') || fnStr.includes('spinner')) return;
      if (arg === undefined) return snapshots.shift() ?? after;
      return true;
    });
    browser.clickNow.mockResolvedValue(undefined);
    models.generate
      .mockResolvedValueOnce({ text: JSON.stringify({ action: 'click', target: 2, value: null, reason: 'email option' }), model: 'm', backend: 'google', usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ action: 'done', target: null, value: null, reason: 'email form visible' }), model: 'm', backend: 'google', usage: {} });

    await build();
    const result = await service.navigate(ORG, SESSION, 'reach the email login form', { maxSteps: 3, settleMs: 300, taskId: 'task-2' });

    expect(result.ok).toBe(true);
    const dataLogBuilders = db.admin.from.mock.results.map((r) => r.value).filter((builder) => builder.insert);
    expect(dataLogBuilders.some((builder) => builder.insert.mock.calls.some((call: any[]) => call[0].key === 'browser:site:auth.uber.com'))).toBe(true);
  });
});
