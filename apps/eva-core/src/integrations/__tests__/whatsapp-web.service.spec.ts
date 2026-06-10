import { WhatsAppWebService } from '../whatsapp-web.service';
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
    browser.evaluate.mockResolvedValueOnce('qr_required');

    const status = await service.startSession(ORG, TASK);

    expect(browser.screenshot).toHaveBeenCalledWith('session-1', ORG);
    expect(status).toEqual(expect.objectContaining({
      state: 'qr_required',
      screenshot: expect.objectContaining({ image_base64: 'iVBORw0KGgo=' }),
    }));
  });

  it('formats the latest visible chat when logged in', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in')
      .mockResolvedValueOnce({
        chat_name: 'Ana',
        preview: 'Voy en camino',
        time: '17:38',
        unread_count: 2,
        raw_lines: ['Ana', '17:38', 'Voy en camino', '2'],
      });

    const result = await service.fetchLatestMessage(ORG, TASK);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Ana');
    expect(result.text).toContain('Voy en camino');
    expect(result.text).toContain('2 mensaje');
  });
});
