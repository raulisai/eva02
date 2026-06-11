import { BrowserService } from '../../browser/browser.service';
import { IntegrationsService } from '../integrations.service';
import { GoogleWebLoginService } from '../google-web-login.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SESSION = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('GoogleWebLoginService', () => {
  let service: GoogleWebLoginService;
  let browser: jest.Mocked<BrowserService>;
  let integrations: jest.Mocked<IntegrationsService>;

  beforeEach(() => {
    browser = {
      open: jest.fn().mockResolvedValue({
        id: SESSION,
        current_url: 'https://accounts.google.com/signin/v2/identifier',
        title: 'Sign in',
      }),
      wait: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn(),
      screenshot: jest.fn().mockResolvedValue({
        id: 'shot-1',
        org_id: ORG,
        session_id: SESSION,
        task_id: TASK,
        image_base64: 'Z29vZ2xl',
        mime_type: 'image/png',
        created_at: new Date().toISOString(),
      }),
      typeNow: jest.fn().mockResolvedValue({ sessionId: SESSION, selector: 'input' }),
    } as unknown as jest.Mocked<BrowserService>;

    integrations = {
      getSecret: jest.fn().mockResolvedValue(JSON.stringify({
        email: 'operator@example.com',
        password: 'secret-password',
      })),
    } as unknown as jest.Mocked<IntegrationsService>;

    service = new GoogleWebLoginService(browser, integrations);
  });

  it('does not open the browser when the encrypted Google Web credential is missing', async () => {
    integrations.getSecret.mockResolvedValueOnce(null);

    const result = await service.startSession(ORG, TASK);

    expect(result.state).toBe('no_credential');
    expect(result.ok).toBe(false);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('fills email and password, then stops with screenshot when Google asks for 2FA', async () => {
    browser.evaluate
      .mockResolvedValueOnce({
        state: 'email_required',
        currentUrl: 'https://accounts.google.com/signin/v2/identifier',
        title: 'Sign in',
        emailSelector: '#identifierId',
        textSample: 'Email or phone',
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        state: 'password_required',
        currentUrl: 'https://accounts.google.com/signin/v2/challenge/pwd',
        title: 'Welcome',
        passwordSelector: 'input[name="Passwd"]',
        textSample: 'Enter your password',
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        state: 'mfa_required',
        currentUrl: 'https://accounts.google.com/signin/v2/challenge/ipp',
        title: '2-Step Verification',
        textSample: '2-Step Verification',
      });

    const result = await service.startSession(ORG, TASK);

    expect(browser.typeNow).toHaveBeenCalledWith(SESSION, ORG, '#identifierId', 'operator@example.com');
    expect(browser.typeNow).toHaveBeenCalledWith(SESSION, ORG, 'input[name="Passwd"]', 'secret-password');
    expect(result.state).toBe('mfa_required');
    expect(result.ok).toBe(false);
    expect(result.screenshot?.image_base64).toBe('Z29vZ2xl');
    expect(result.text).toContain('verificación en dos pasos');
  });

  it('returns logged_in when the existing browser profile is already authenticated', async () => {
    browser.evaluate.mockResolvedValueOnce({
      state: 'logged_in',
      currentUrl: 'https://myaccount.google.com/',
      title: 'Google Account',
      textSample: 'Manage your Google Account',
    });

    const result = await service.startSession(ORG, TASK);

    expect(result.ok).toBe(true);
    expect(result.state).toBe('logged_in');
    expect(browser.typeNow).not.toHaveBeenCalled();
  });
});
