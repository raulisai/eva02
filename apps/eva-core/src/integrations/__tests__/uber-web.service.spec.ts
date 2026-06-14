import { UberWebService } from '../uber-web.service';
import { BrowserService } from '../../browser/browser.service';
import { GoogleWebLoginService } from '../google-web-login.service';
import { SmartNavigatorService } from '../../browser/smart-navigator.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SESSION = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('UberWebService', () => {
  let service: UberWebService;
  let browser: jest.Mocked<BrowserService>;
  let googleWeb: jest.Mocked<GoogleWebLoginService>;

  beforeEach(() => {
    browser = {
      open: jest.fn().mockResolvedValue({
        id: SESSION,
        current_url: 'https://m.uber.com/go/home',
        title: 'Uber',
      }),
      wait: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn(),
      clickNow: jest.fn().mockResolvedValue({}),
      typeNow: jest.fn().mockResolvedValue({}),
      typeCharacters: jest.fn().mockResolvedValue({}),
      pressKey: jest.fn().mockResolvedValue({}),
      getOrCreateProfile: jest.fn().mockResolvedValue({ id: 'profile-1', encrypted_state: 'enc-state' }),
      findLatestOpenSession: jest.fn().mockResolvedValue({ id: SESSION, metadata: {} }),
      findLatestSession: jest.fn().mockResolvedValue({
        id: SESSION,
        current_url: 'https://m.uber.com/go/home',
        metadata: {
          email: 'raul@example.com',
          last_state: 'logged_in',
          last_current_url: 'https://m.uber.com/go/home',
          last_verified_at: '2026-06-11T18:00:00.000Z',
        },
      }),
      findLatestScreenshotForProfile: jest.fn().mockResolvedValue({
        id: 'shot-1',
        org_id: ORG,
        session_id: SESSION,
        task_id: TASK,
        image_base64: 'dWJlcg==',
        mime_type: 'image/png',
        created_at: new Date().toISOString(),
      }),
      updateSessionMetadata: jest.fn().mockResolvedValue({}),
      saveProfileState: jest.fn().mockResolvedValue({}),
      screenshot: jest.fn().mockResolvedValue({
        id: 'shot-1',
        org_id: ORG,
        session_id: SESSION,
        task_id: TASK,
        image_base64: 'dWJlcg==',
        mime_type: 'image/png',
        created_at: new Date().toISOString(),
      }),
    } as unknown as jest.Mocked<BrowserService>;

    googleWeb = {
      hasCredential: jest.fn().mockResolvedValue(false),
      loginCurrentSession: jest.fn(),
    } as unknown as jest.Mocked<GoogleWebLoginService>;

    service = new UberWebService(browser, googleWeb);
  });

  it('opens Uber Web and reports Google login availability', async () => {
    browser.evaluate.mockResolvedValueOnce({
      state: 'login_required',
      googleLoginAvailable: true,
      quoteCandidates: [],
      textSample: 'Continue with Google',
    });

    const result = await service.startSession(ORG, TASK);

    expect(browser.open).toHaveBeenCalledWith(expect.objectContaining({
      service: 'uber_web',
      url: 'https://m.uber.com/go/home',
      reuse_open: true,
    }), ORG);
    expect(result.state).toBe('login_required');
    expect(result.google_login_available).toBe(true);
    expect(result.screenshot?.image_base64).toBe('dWJlcg==');
  });

  it('uses Uber Web deep link and extracts visible quote candidates', async () => {
    browser.evaluate
      .mockResolvedValueOnce(undefined)  // dismissConsentBanner
      .mockResolvedValueOnce({
        state: 'quote_ready',
        googleLoginAvailable: false,
        quoteCandidates: [
          { label: 'UberX', price: '$180', raw_lines: ['UberX', '$180'] },
        ],
        textSample: 'UberX\n$180',
      });

    const result = await service.estimateRide(ORG, {
      origin: 'Roma Norte',
      destination: 'Aeropuerto',
      taskId: TASK,
    });

    expect(browser.open).toHaveBeenCalledWith(expect.objectContaining({
      service: 'uber_web',
      url: expect.stringContaining('https://m.uber.com/ul/'),
      metadata: expect.objectContaining({ guardrail: 'quote-only-never-request-ride' }),
    }), ORG);
    expect(result.ok).toBe(true);
    expect(result.candidates).toEqual([
      { label: 'UberX', price: '$180', raw_lines: ['UberX', '$180'] },
    ]);
    expect(result.text).toContain('No pedí ni confirmé ningún viaje');
  });

  it('detects visible quote candidates from Uber page text', async () => {
    const previousDocument = (global as any).document;
    const previousLocation = (global as any).location;
    (global as any).document = {
      title: 'Uber',
      body: {
        innerText: [
          'Elige un viaje',
          'UberX',
          'Llega en 4 min',
          'MX$180 - MX$220',
          'Comfort',
          'MX$240',
        ].join('\n'),
      },
    };
    (global as any).location = { href: 'https://m.uber.com/go/product-selection' };
    browser.evaluate.mockImplementation(async (_sessionId: string, _orgId: string, fn: any, arg?: unknown) => fn(arg));

    try {
      const result = await service.estimateRide(ORG, {
        origin: 'Roma Norte',
        destination: 'Aeropuerto',
        taskId: TASK,
      });

      expect(result.ok).toBe(true);
      expect(result.reason).toBe('quote_ready');
      expect(result.candidates[0]).toEqual(expect.objectContaining({
        label: 'UberX',
        price: 'MX$180 - MX$220',
      }));
    } finally {
      (global as any).document = previousDocument;
      (global as any).location = previousLocation;
    }
  });

  it('fills the visible route form when the deep link lands on Uber home without prices', async () => {
    const noQuotes = { state: 'logged_in', googleLoginAvailable: false, quoteCandidates: [], textSample: 'Where to?', currentUrl: 'https://m.uber.com/go/home', title: 'Uber' };
    const withQuotes = { state: 'quote_ready', googleLoginAvailable: false, quoteCandidates: [{ label: 'UberX', price: '$180', raw_lines: ['UberX', '$180'] }], textSample: 'UberX\n$180', currentUrl: 'https://m.uber.com/go/product-selection', title: 'Uber' };
    browser.evaluate
      .mockResolvedValueOnce(undefined)    // dismissConsentBanner (after settleMs)
      .mockResolvedValueOnce(noQuotes)     // inspectPage in inspectAfterSettled
      .mockResolvedValueOnce(false)        // clickFirstMatchingPlaceSuggestion (origin)
      .mockResolvedValueOnce(false)        // clickFirstMatchingPlaceSuggestion (destination)
      .mockResolvedValueOnce(undefined)    // dismissConsentBanner (before "See prices")
      .mockResolvedValueOnce(true)         // JS click on "See prices" button
      .mockResolvedValueOnce(noQuotes)     // inspectAfterRouteEntry attempt 1 (still loading)
      .mockResolvedValueOnce(withQuotes);  // inspectAfterRouteEntry attempt 2 (prices ready)

    const result = await service.estimateRide(ORG, {
      origin: 'Calle 1 31, Agrícola Pantitlán',
      destination: 'El Zócalo, Ciudad de México',
      taskId: TASK,
    });

    expect(result.ok).toBe(true);
    // Fields are clicked to focus then typed char-by-char for proper React autocomplete
    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, '#rv-pudo-select-pickup', { timeout: 1200 });
    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, '#rv-pudo-select-drop0', { timeout: 1200 });
    expect(browser.pressKey).toHaveBeenCalledWith(SESSION, ORG, 'Control+a');
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, 'Calle 1 31, Agrícola Pantitlán', 50);
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, 'El Zócalo, Ciudad de México', 50);
    // "See prices" is triggered via JS evaluate (primary) — clickNow only used as fallback
    expect(browser.evaluate).toHaveBeenCalledWith(SESSION, ORG, expect.any(Function));
    expect(browser.updateSessionMetadata).toHaveBeenCalledWith(SESSION, ORG, expect.objectContaining({
      route_entry: 'dom_route_form',
    }));
  });

  it('uses the stored Google Web credential when Uber asks for Google login', async () => {
    googleWeb.hasCredential.mockResolvedValue(true);
    googleWeb.loginCurrentSession.mockResolvedValue({
      ok: true,
      state: 'logged_in',
      session_id: SESSION,
      current_url: 'https://m.uber.com/go/home',
      title: 'Uber',
      email: 'operator@example.com',
      text: 'Google Web ya está autenticado.',
    });
    browser.evaluate
      .mockResolvedValueOnce(undefined) // dismissConsentBanner (1st estimateRide)
      // Initial Uber route opens login page.
      .mockResolvedValueOnce({
        state: 'login_required',
        googleLoginAvailable: true,
        quoteCandidates: [],
        textSample: 'Continue with Google',
        currentUrl: 'https://m.uber.com/go/login',
        title: 'Uber',
      })
      // Click Continue with Google.
      .mockResolvedValueOnce(true)
      // Uber state after Google login.
      .mockResolvedValueOnce({
        state: 'logged_in',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Where to?',
        currentUrl: 'https://m.uber.com/go/home',
        title: 'Uber',
      })
      .mockResolvedValueOnce(undefined) // dismissConsentBanner (2nd estimateRide, recursive)
      // Re-open route after login and extract quote.
      .mockResolvedValueOnce({
        state: 'quote_ready',
        googleLoginAvailable: false,
        quoteCandidates: [
          { label: 'UberX', price: '$180', raw_lines: ['UberX', '$180'] },
        ],
        textSample: 'UberX\n$180',
        currentUrl: 'https://m.uber.com/go/product-selection',
        title: 'Uber',
      });

    const result = await service.estimateRide(ORG, {
      origin: 'Roma Norte',
      destination: 'Aeropuerto',
      taskId: TASK,
    });

    expect(googleWeb.loginCurrentSession).toHaveBeenCalledWith(ORG, SESSION, TASK);
    expect(browser.open).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('UberX');
  });

  it('submits verification code successfully via selectors', async () => {
    browser.evaluate.mockResolvedValueOnce({
      state: 'logged_in',
      googleLoginAvailable: false,
      quoteCandidates: [],
      textSample: 'Where to?',
    });

    const result = await service.submitLoginCode(ORG, '1234');

    expect(browser.getOrCreateProfile).toHaveBeenCalledWith(ORG, 'uber_web');
    expect(browser.findLatestOpenSession).toHaveBeenCalledWith('profile-1', ORG);
    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, expect.stringContaining('nth=0'), { timeout: 1500 });
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, '1234', 120);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('logged_in');
  });

  it('submits verification code via evaluate fallback when selectors fail', async () => {
    browser.clickNow.mockRejectedValue(new Error('Strict mode violation'));
    browser.evaluate
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        state: 'logged_in',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Where to?',
      });

    const result = await service.submitLoginCode(ORG, '1234');

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('logged_in');
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, '1234', 120);
  });

  it('starts email login, types email, and types password if requested', async () => {
    browser.evaluate
      // 1. inspectPage (initial check) -> login_required
      .mockResolvedValueOnce({
        state: 'login_required',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Sign in',
      })
      // 2. hasVisibleEmailField
      .mockResolvedValueOnce(true)
      // 3. typeEmailAndContinue (Phase 1)
      .mockResolvedValueOnce(true)
      // 4. typeEmailAndContinue (Phase 3)
      .mockResolvedValueOnce(true)
      // 5. inspectPage (after email entry) -> password_required
      .mockResolvedValueOnce({
        state: 'password_required',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Enter your password',
      })
      // 6. inspectPage (after password entry) -> code_required
      .mockResolvedValueOnce({
        state: 'code_required',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Enter code',
      })
      // 7. inspectPage (final) -> code_required
      .mockResolvedValueOnce({
        state: 'code_required',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Enter code',
      });

    const result = await service.startEmailLogin(ORG, 'raul@example.com', 'mypassword', TASK);

    expect(browser.open).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ email: 'raul@example.com' }),
    }), ORG);
    expect(JSON.stringify(browser.open.mock.calls[0][0].metadata)).not.toContain('mypassword');
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('code_required');
    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, expect.stringContaining('password'), { timeout: 1500 });
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, 'mypassword', 80);
  });

  it('submits verification code and types password if requested after code entry', async () => {
    browser.findLatestOpenSession.mockResolvedValueOnce({
      id: SESSION,
      metadata: {},
    } as any);
    (service as any).pendingPasswords.set(SESSION, 'mypassword');

    browser.evaluate
      // 1. inspectPage (after code entry) -> password_required
      .mockResolvedValueOnce({
        state: 'password_required',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Enter your password',
      })
      // 2. inspectPage (final) -> logged_in
      .mockResolvedValueOnce({
        state: 'logged_in',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Where to?',
      });

    const result = await service.submitLoginCode(ORG, '1234', TASK);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('logged_in');
    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, expect.stringContaining('password'), { timeout: 1500 });
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, 'mypassword', 80);
    expect(browser.updateSessionMetadata).toHaveBeenCalledWith(SESSION, ORG, expect.not.objectContaining({ temp_password: expect.any(String) }));
  });

  it('normalizes cmdx and cdmx typos to CDMX, México', () => {
    expect(service.normalizeAddress('Roma Norte, cmdx')).toBe('Roma Norte, CDMX, México');
    expect(service.normalizeAddress('Condesa, CDMX')).toBe('Condesa, CDMX, México');
    expect(service.normalizeAddress('Aeropuerto CDMX T2')).toBe('Aeropuerto CDMX, México T2');
    expect(service.normalizeAddress('Av. Reforma, cdmx, 06600')).toBe('Av. Reforma, CDMX, México, 06600');
  });

  it('requestRide selects ride type and clicks confirm via JS fast path', async () => {
    browser.evaluate
      // inspectPage initial
      .mockResolvedValueOnce({
        state: 'quote_ready',
        googleLoginAvailable: false,
        quoteCandidates: [{ label: 'UberX', price: '$180', raw_lines: ['UberX'] }],
        textSample: 'UberX $180',
        currentUrl: 'https://m.uber.com/looking',
        title: 'Uber',
      })
      // resilientSelectRideType JS click
      .mockResolvedValueOnce(true)
      // resilientClickRequestRide JS click
      .mockResolvedValueOnce(true)
      // inspectPage final
      .mockResolvedValueOnce({
        state: 'logged_in',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Your driver is on the way',
        currentUrl: 'https://m.uber.com/looking',
        title: 'Uber',
      });

    const result = await service.requestRide(ORG, {
      origin: 'Roma Norte',
      destination: 'Aeropuerto',
      rideType: 'UberX',
      taskId: TASK,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('ordered');
    expect(result.text).toContain('UberX');
  });

  it('requestRide falls back to SmartNavigator when JS does not find ride type', async () => {
    const smartNav = {
      available: true,
      navigate: jest.fn().mockResolvedValue({ ok: true, reason: 'goal reached', steps: [] }),
    } as unknown as jest.Mocked<SmartNavigatorService>;

    const svc = new UberWebService(browser, googleWeb, smartNav);

    browser.evaluate
      // inspectPage initial
      .mockResolvedValueOnce({
        state: 'quote_ready',
        googleLoginAvailable: false,
        quoteCandidates: [{ label: 'UberX', price: '$180', raw_lines: ['UberX'] }],
        textSample: 'UberX $180',
        currentUrl: 'https://m.uber.com/looking',
        title: 'Uber',
      })
      // resilientSelectRideType JS returns false (element not found)
      .mockResolvedValueOnce(false)
      // resilientClickRequestRide JS returns false
      .mockResolvedValueOnce(false)
      // inspectPage final
      .mockResolvedValueOnce({
        state: 'logged_in',
        googleLoginAvailable: false,
        quoteCandidates: [],
        textSample: 'Your driver is on the way',
        currentUrl: 'https://m.uber.com/looking',
        title: 'Uber',
      });

    const result = await svc.requestRide(ORG, {
      origin: 'Condesa, CDMX',
      destination: 'Aeropuerto',
      rideType: 'UberX',
      taskId: TASK,
    });

    expect(smartNav.navigate).toHaveBeenCalledTimes(2);
    expect(smartNav.navigate).toHaveBeenCalledWith(
      ORG, SESSION,
      expect.stringContaining('UberX'),
      expect.objectContaining({ maxSteps: 4 }),
    );
    expect(result.ok).toBe(true);
  });

  it('returns stored status with last screenshot and email', async () => {
    const result = await service.getStoredStatus(ORG);

    expect(browser.getOrCreateProfile).toHaveBeenCalledWith(ORG, 'uber_web');
    expect(browser.findLatestSession).toHaveBeenCalledWith('profile-1', ORG);
    expect(browser.findLatestScreenshotForProfile).toHaveBeenCalledWith('profile-1', ORG);
    expect(result).toEqual(expect.objectContaining({
      has_session: true,
      session_id: SESSION,
      state: 'logged_in',
      email: 'raul@example.com',
      screenshot: expect.objectContaining({ image_base64: 'dWJlcg==' }),
    }));
  });
});
