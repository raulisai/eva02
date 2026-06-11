import { UberWebService } from '../uber-web.service';
import { BrowserService } from '../../browser/browser.service';
import { GoogleWebLoginService } from '../google-web-login.service';

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
      typeCharacters: jest.fn().mockResolvedValue({}),
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
    browser.evaluate.mockResolvedValueOnce({
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
