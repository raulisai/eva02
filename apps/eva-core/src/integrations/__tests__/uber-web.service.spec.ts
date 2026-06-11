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
});
