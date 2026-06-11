import { parseWhatsAppChatRows, WhatsAppWebService } from '../whatsapp-web.service';
import { BrowserService } from '../../browser/browser.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('WhatsAppWebService', () => {
  let service: WhatsAppWebService;
  let browser: jest.Mocked<BrowserService>;

  beforeEach(() => {
    browser = {
      open: jest.fn().mockResolvedValue({
        id: 'session-1',
        current_url: 'https://web.whatsapp.com/',
        title: 'WhatsApp',
      }),
      wait: jest.fn().mockResolvedValue({ sessionId: 'session-1', waited_ms: 4000 }),
      screenshot: jest.fn().mockResolvedValue({
        id: 'shot-1',
        org_id: ORG,
        session_id: 'session-1',
        task_id: TASK,
        image_base64: 'iVBORw0KGgo=',
        mime_type: 'image/png',
        created_at: new Date().toISOString(),
      }),
      evaluate: jest.fn(),
      saveProfileState: jest.fn().mockResolvedValue({}),
      typeCharacters: jest.fn().mockResolvedValue({}),
      clickNow: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<BrowserService>;

    service = new WhatsAppWebService(browser);
  });

  it('opens WhatsApp Web with the persistent whatsapp profile', async () => {
    browser.evaluate.mockResolvedValueOnce('logged_in');

    const status = await service.startSession(ORG, TASK);

    expect(browser.open).toHaveBeenCalledWith(expect.objectContaining({
      service: 'whatsapp_web',
      url: 'https://web.whatsapp.com/',
      task_id: TASK,
      reuse_open: true,
    }), ORG);
    expect(browser.screenshot).not.toHaveBeenCalled();
    expect(status.state).toBe('logged_in');
  });

  it('returns a QR screenshot when WhatsApp Web is not linked', async () => {
    browser.evaluate
      .mockResolvedValueOnce('qr_required')
      // captureQrScreenshot extracts the QR canvas via evaluate (not screenshot)
      .mockResolvedValueOnce({ image_base64: 'iVBORw0KGgo=', mime_type: 'image/png' });

    const status = await service.startSession(ORG, TASK);

    expect(browser.screenshot).not.toHaveBeenCalled();
    expect(status).toEqual(expect.objectContaining({
      state: 'qr_required',
      screenshot: expect.objectContaining({ image_base64: 'iVBORw0KGgo=' }),
    }));
  });

  it('formats the latest visible chat when logged in', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in')
      .mockResolvedValueOnce([{
        titles: ['Ana'],
        lines: ['Ana', '17:38', 'Voy en camino', '2'],
        aria_labels: ['2 unread messages'],
        text: 'Ana\n17:38\nVoy en camino\n2',
      }]);

    const result = await service.fetchLatestMessage(ORG, TASK);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Ana');
    expect(result.text).toContain('Voy en camino');
    expect(result.text).toContain('2 mensaje');
  });

  it('captures a test screenshot when the linked session is logged in', async () => {
    browser.evaluate.mockResolvedValueOnce('logged_in');

    const result = await service.captureSessionScreenshot(ORG, TASK);

    expect(result.state).toBe('logged_in');
    expect(browser.screenshot).toHaveBeenCalledWith('session-1', ORG);
    expect(result.screenshot?.image_base64).toBe('iVBORw0KGgo=');
  });

  it('parses chat rows without mistaking unread labels for chat names', () => {
    const chats = parseWhatsAppChatRows([{
      titles: ['Ana'],
      lines: ['2 unread messages', 'Ana', '9:16 pm', '(You)', 'Ya voy saliendo', '2'],
      aria_labels: ['2 unread messages'],
      text: '2 unread messages\nAna\n9:16 pm\n(You)\nYa voy saliendo\n2',
    }]);

    expect(chats).toEqual([expect.objectContaining({
      chat_name: 'Ana',
      preview: 'Ya voy saliendo',
      time: '9:16 pm',
      unread_count: 2,
      latest_from_me: true,
    })]);
  });

  it('classifies visible chats as answered when the latest preview is from me', () => {
    const chats = parseWhatsAppChatRows([{
      titles: ['Ana'],
      lines: ['Ana', '9:16 pm', '(You)', 'Ya voy saliendo'],
      aria_labels: [],
      text: 'Ana\n9:16 pm\n(You)\nYa voy saliendo',
    }, {
      titles: ['Luis'],
      lines: ['Luis', '9:10 pm', 'Me avisas cuando llegues'],
      aria_labels: [],
      text: 'Luis\n9:10 pm\nMe avisas cuando llegues',
    }]);

    expect(chats).toEqual([
      expect.objectContaining({ chat_name: 'Ana', latest_from_me: true }),
      expect.objectContaining({ chat_name: 'Luis', latest_from_me: false }),
    ]);
  });

  it('returns visible unread WhatsApp chats separately from latest-message requests', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in')
      .mockResolvedValueOnce([{
        titles: ['Ana'],
        lines: ['2 unread messages', 'Ana', '9:16 pm', 'Voy llegando', '2'],
        aria_labels: ['2 unread messages'],
        text: '2 unread messages\nAna\n9:16 pm\nVoy llegando\n2',
      }, {
        titles: ['Luis'],
        lines: ['Luis', '8:00 pm', 'Gracias'],
        aria_labels: [],
        text: 'Luis\n8:00 pm\nGracias',
      }]);

    const result = await service.fetchUnreadMessages(ORG, TASK);

    expect(result.ok).toBe(true);
    expect(result.unread).toHaveLength(1);
    expect(result.text).toContain('Ana');
    expect(result.text).toContain('2 sin leer');
  });

  it('returns unanswered and answered WhatsApp chats separately', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in')
      .mockResolvedValueOnce([{
        titles: ['Ana'],
        lines: ['Ana', '9:16 pm', 'Me avisas cuando llegues'],
        aria_labels: [],
        text: 'Ana\n9:16 pm\nMe avisas cuando llegues',
      }, {
        titles: ['Luis'],
        lines: ['Luis', '9:10 pm', '(You)', 'Ya quedó'],
        aria_labels: [],
        text: 'Luis\n9:10 pm\n(You)\nYa quedó',
      }]);

    const result = await service.fetchUnansweredMessages(ORG, TASK);

    expect(result.ok).toBe(true);
    expect(result.pending).toEqual([expect.objectContaining({ chat_name: 'Ana' })]);
    expect(result.answered).toEqual([expect.objectContaining({ chat_name: 'Luis' })]);
    expect(result.text).toContain('Chats visibles sin responder');
    expect(result.text).toContain('Ya contestados visibles');
  });

  it('opens and retrieves messages for a contact that is already visible in the list', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in') // detectState
      .mockResolvedValueOnce({ open: false, actualContactName: null }) // alreadyOpen (check header)
      .mockResolvedValueOnce({ clicked: true, actualContactName: 'Michael Sec' }) // clickedVisible
      .mockResolvedValueOnce(['[2:09 pm] Michael Sec: Hola']); // extractOpenChatMessages

    const result = await service.fetchContactMessages(ORG, 'Michael Sec', TASK);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Michael Sec');
    expect(result.text).toContain('Hola');
  });

  it('searches for and retrieves messages for a contact that is not immediately visible', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in') // detectState
      .mockResolvedValueOnce({ open: false, actualContactName: null }) // alreadyOpen
      .mockResolvedValueOnce({ clicked: false, actualContactName: null }) // clickedVisible
      .mockResolvedValueOnce(true) // searchFocused
      .mockResolvedValueOnce({ clicked: true, actualContactName: 'Michael Sec' }) // clickedSearchResult
      .mockResolvedValueOnce(['[2:09 pm] Michael Sec: Hola']); // extractOpenChatMessages

    const result = await service.fetchContactMessages(ORG, 'Michael Sec', TASK);

    expect(browser.typeCharacters).toHaveBeenCalledWith('session-1', ORG, 'Michael Sec', 80);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Michael Sec');
    expect(result.text).toContain('Hola');
  });

  it('returns contact_not_found if the contact cannot be found', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in') // detectState
      .mockResolvedValueOnce({ open: false, actualContactName: null }) // alreadyOpen
      .mockResolvedValueOnce({ clicked: false, actualContactName: null }) // clickedVisible
      .mockResolvedValueOnce(true) // searchFocused
      .mockResolvedValueOnce({ clicked: false, actualContactName: null }) // clickedSearchResult
      .mockResolvedValueOnce(true) // focus/clear search box fallback
      .mockResolvedValueOnce({ clicked: false, actualContactName: null }); // secondAttempt fallback

    const result = await service.fetchContactMessages(ORG, 'Michael Sec', TASK);

    expect(result.ok).toBe(false);
    expect(result.text).toContain('No pude encontrar');
  });
});
