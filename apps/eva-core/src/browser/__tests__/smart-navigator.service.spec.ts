import { Test, TestingModule } from '@nestjs/testing';
import { BrowserService } from '../browser.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { SmartNavigatorService, PageSnapshot } from '../smart-navigator.service';

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
  };
  let models: { generate: jest.Mock };

  async function build(): Promise<void> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartNavigatorService,
        { provide: BrowserService, useValue: browser },
        { provide: ModelRouterService, useValue: models },
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
    };
    models = { generate: jest.fn() };
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
});
