import { RappiWebService } from '../rappi-web.service';
import { BrowserService } from '../../browser/browser.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SESSION = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('RappiWebService', () => {
  let service: RappiWebService;
  let browser: jest.Mocked<BrowserService>;

  beforeEach(() => {
    browser = {
      open: jest.fn().mockResolvedValue({
        id: SESSION,
        current_url: 'https://www.rappi.com.mx/',
        title: 'Rappi',
      }),
      wait: jest.fn().mockResolvedValue({}),
      evaluate: jest.fn(),
      clickNow: jest.fn().mockResolvedValue({}),
      typeCharacters: jest.fn().mockResolvedValue({}),
      getOrCreateProfile: jest.fn().mockResolvedValue({ id: 'profile-rappi', encrypted_state: null }),
      findLatestOpenSession: jest.fn().mockResolvedValue({ id: SESSION }),
      saveProfileState: jest.fn().mockResolvedValue({}),
      screenshot: jest.fn().mockResolvedValue({
        id: 'shot-1',
        org_id: ORG,
        session_id: SESSION,
        task_id: TASK,
        image_base64: 'cmFwcGk=',
        mime_type: 'image/png',
        created_at: new Date().toISOString(),
      }),
    } as unknown as jest.Mocked<BrowserService>;

    service = new RappiWebService(browser);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getStatus
  // ──────────────────────────────────────────────────────────────────────────
  it('reports has_session=false when no encrypted_state in profile', async () => {
    browser.getOrCreateProfile.mockResolvedValueOnce({ id: 'profile-rappi', encrypted_state: null } as any);
    const result = await service.getProfile(ORG);
    expect(result.encrypted_state).toBeNull();
  });

  it('reports has_session=true when profile has encrypted_state', async () => {
    browser.getOrCreateProfile.mockResolvedValueOnce({ id: 'profile-rappi', encrypted_state: 'enc123' } as any);
    const result = await service.getProfile(ORG);
    expect(result.encrypted_state).toBe('enc123');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // startEmailLogin — already logged in
  // ──────────────────────────────────────────────────────────────────────────
  it('returns already_logged_in and saves profile state when session is active', async () => {
    browser.evaluate.mockResolvedValueOnce({
      state: 'logged_in',
      textSample: 'Mi cuenta',
      currentUrl: 'https://www.rappi.com.mx/',
    });

    const result = await service.startEmailLogin(ORG, 'test@example.com', TASK);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('already_logged_in');
    expect(browser.saveProfileState).toHaveBeenCalledWith(SESSION, ORG);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // startEmailLogin — email entered → code_required
  // ──────────────────────────────────────────────────────────────────────────
  it('enters email with Playwright native click and reports code_required', async () => {
    browser.evaluate
      // 1. inspectPage → not logged in
      .mockResolvedValueOnce({ state: 'email_required', textSample: 'correo electrónico', currentUrl: 'https://rappi.com.mx/login/email' })
      // 2. hasVisibleEmailField → true
      .mockResolvedValueOnce(true)
      // 3. inspectPage after email → code_required
      .mockResolvedValueOnce({ state: 'code_required', textSample: 'código de verificación', currentUrl: 'https://rappi.com.mx/login/email' });

    const result = await service.startEmailLogin(ORG, 'raul@example.com', TASK);

    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, expect.stringContaining('email'), { timeout: 1500 });
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, 'raul@example.com', 80);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('code_required');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // submitLoginCode — success via Playwright selector
  // ──────────────────────────────────────────────────────────────────────────
  it('submits verification code successfully via Playwright selectors', async () => {
    browser.evaluate.mockResolvedValueOnce({
      state: 'logged_in',
      textSample: 'Mi cuenta',
      currentUrl: 'https://www.rappi.com.mx/',
    });

    const result = await service.submitLoginCode(ORG, '123456');

    expect(browser.getOrCreateProfile).toHaveBeenCalledWith(ORG, 'rappi_web');
    expect(browser.findLatestOpenSession).toHaveBeenCalledWith('profile-rappi', ORG);
    expect(browser.clickNow).toHaveBeenCalledWith(SESSION, ORG, expect.stringContaining('nth=0'), { timeout: 1500 });
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, '123456', 120);
    expect(browser.saveProfileState).toHaveBeenCalledWith(SESSION, ORG);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('logged_in');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // submitLoginCode — success via evaluate fallback
  // ──────────────────────────────────────────────────────────────────────────
  it('submits verification code via evaluate fallback when selectors fail', async () => {
    browser.clickNow.mockRejectedValue(new Error('Strict mode violation'));
    browser.evaluate
      .mockResolvedValueOnce(true)         // fallback evaluate → found input
      .mockResolvedValueOnce({             // inspectPage after submit → logged_in
        state: 'logged_in',
        textSample: 'Mi cuenta',
        currentUrl: 'https://www.rappi.com.mx/',
      });

    const result = await service.submitLoginCode(ORG, '654321');

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('logged_in');
    expect(browser.typeCharacters).toHaveBeenCalledWith(SESSION, ORG, '654321', 120);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // submitLoginCode — invalid code
  // ──────────────────────────────────────────────────────────────────────────
  it('reports invalid_code when Rappi still shows code_required after submission', async () => {
    browser.evaluate.mockResolvedValueOnce({
      state: 'code_required',
      textSample: 'código de verificación',
      currentUrl: 'https://rappi.com.mx/login/email',
    });

    const result = await service.submitLoginCode(ORG, '000000');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_code');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // submitLoginCode — no active session
  // ──────────────────────────────────────────────────────────────────────────
  it('returns no_active_session when no open Rappi session exists', async () => {
    browser.findLatestOpenSession.mockResolvedValueOnce(null);

    const result = await service.submitLoginCode(ORG, '123456');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_active_session');
    expect(browser.typeCharacters).not.toHaveBeenCalled();
  });
});
