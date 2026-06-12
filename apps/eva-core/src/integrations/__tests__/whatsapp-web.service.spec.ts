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
      typeNow: jest.fn().mockResolvedValue({}),
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
        chat_name: 'Ana',
        preview: 'Voy en camino',
        time: '17:38',
        unread_count: 2,
        latest_from_me: false,
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
        chat_name: 'Ana',
        preview: 'Voy llegando',
        time: '9:16 pm',
        unread_count: 2,
        latest_from_me: false,
      }, {
        chat_name: 'Luis',
        preview: 'Gracias',
        time: '8:00 pm',
        unread_count: 0,
        latest_from_me: true,
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
        chat_name: 'Ana',
        preview: 'Me avisas cuando llegues',
        time: '9:16 pm',
        unread_count: 0,
        latest_from_me: false,
      }, {
        chat_name: 'Luis',
        preview: 'Ya quedó',
        time: '9:10 pm',
        unread_count: 0,
        latest_from_me: true,
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
      .mockResolvedValueOnce('logged_in') // startSession: detectState
      .mockResolvedValueOnce({ opened: false, actualContactName: null }) // selectContact: alreadyOpen
      .mockResolvedValueOnce('[data-eva-click-target="click-row"]') // selectContact: rowSelector
      .mockResolvedValueOnce({ opened: true, actualContactName: 'Michael Sec' }) // selectContact: verifyOpened after click
      .mockResolvedValueOnce(['[2:09 pm] Michael Sec: Hola']); // extractOpenChatMessages

    const result = await service.fetchContactMessages(ORG, 'Michael Sec', TASK);

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Michael Sec');
    expect(result.text).toContain('Hola');
  });

  it('searches for and retrieves messages for a contact that is not immediately visible', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in') // startSession: detectState
      .mockResolvedValueOnce({ opened: false, actualContactName: null }) // selectContact: alreadyOpen
      .mockResolvedValueOnce(null) // selectContact: rowSelector (not visible)
      .mockResolvedValueOnce(undefined) // selectContact: clearSearchInput
      .mockResolvedValueOnce('[data-eva-click-target="click-search"]') // selectContact: searchRowSelector
      .mockResolvedValueOnce({ opened: true, actualContactName: 'Michael Sec' }) // selectContact: verifyOpened after search click
      .mockResolvedValueOnce(['[2:09 pm] Michael Sec: Hola']); // extractOpenChatMessages

    const result = await service.fetchContactMessages(ORG, 'Michael Sec', TASK);

    expect(browser.typeNow).toHaveBeenCalledWith('session-1', ORG, expect.any(String), 'Michael Sec', { timeout: 1500 });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Michael Sec');
    expect(result.text).toContain('Hola');
  });

  it('returns contact_not_found if the contact cannot be found', async () => {
    browser.evaluate
      .mockResolvedValueOnce('logged_in') // startSession: detectState
      .mockResolvedValueOnce({ opened: false, actualContactName: null }) // selectContact: alreadyOpen
      .mockResolvedValueOnce(null) // selectContact: rowSelector (not visible)
      .mockResolvedValueOnce(undefined) // selectContact: clearSearchInput
      .mockResolvedValueOnce(null) // selectContact: searchRowSelector (not found)
      .mockResolvedValueOnce(undefined) // selectContact: clearSearchInput for fallback
      .mockResolvedValueOnce(null) // selectContact: secondAttemptSelector (not found)
      .mockResolvedValueOnce(['Michael Sec', 'Luis']); // selectContact: getVisibleResults fallback

    const result = await service.fetchContactMessages(ORG, 'Michael Sec', TASK);

    expect(result.ok).toBe(false);
    expect(result.text).toContain('No pude encontrar');
    expect(result.text).toContain('Michael Sec, Luis');
  });

  describe('sendMessage', () => {
    it('successfully sends a message when contact is found', async () => {
      browser.evaluate
        .mockResolvedValueOnce('logged_in') // startSession: detectState
        .mockResolvedValueOnce({ opened: false, actualContactName: null }) // selectContact: alreadyOpen
        .mockResolvedValueOnce('[data-eva-click-target="click-row"]') // selectContact: rowSelector
        .mockResolvedValueOnce({ opened: true, actualContactName: 'Michael Sec' }) // selectContact: verifyOpened after click
        .mockResolvedValueOnce(true); // sendMessage: focus/clear message input

      const result = await service.sendMessage(ORG, 'Michael Sec', 'Hola', TASK);

      expect(result.ok).toBe(true);
      expect(result.text).toContain('Mensaje enviado con éxito');
      expect(browser.typeCharacters).toHaveBeenCalledWith('session-1', ORG, 'Hola', 50);
    });

    it('returns error if contact is not found', async () => {
      browser.evaluate
        .mockResolvedValueOnce('logged_in') // startSession: detectState
        .mockResolvedValueOnce({ opened: false, actualContactName: null }) // selectContact: alreadyOpen
        .mockResolvedValueOnce(null) // selectContact: rowSelector (not visible)
        .mockResolvedValueOnce(undefined) // selectContact: clearSearchInput
        .mockResolvedValueOnce(null) // selectContact: searchRowSelector (not found)
        .mockResolvedValueOnce(undefined) // selectContact: clearSearchInput for fallback
        .mockResolvedValueOnce(null) // selectContact: secondAttemptSelector (not found)
        .mockResolvedValueOnce(['Michael Sec', 'Luis']); // selectContact: getVisibleResults fallback

      const result = await service.sendMessage(ORG, 'Michael Sec', 'Hola', TASK);

      expect(result.ok).toBe(false);
      expect(result.text).toContain('No pude encontrar el contacto');
      expect(result.text).toContain('Michael Sec, Luis');
    });
  });

  describe('browser-side contact matching scoring', () => {
    // Exact copy of browser-evaluated getMatchScore logic for testing
    function getMatchScore(chatName: string | null | undefined, query: string | null | undefined): number {
      if (!chatName || !query) return 0;
      const clean = (s: string) => s.normalize("NFD")
                                     .replace(/[\u0300-\u036f]/g, "")
                                     .toLowerCase()
                                     .replace(/[^a-z0-9\s]/gi, " ")
                                     .replace(/\s+/g, " ")
                                     .trim();
      const c = clean(chatName);
      const q = clean(query);
      if (!c || !q) return 0;
      if (c === q) return 1.0;
      if (c.includes(q)) {
        return 0.8 + (q.length / c.length) * 0.15;
      }
      const cWords = c.split(/\s+/);
      const qWords = q.split(/\s+/);
      const allMatched = qWords.every((qw: string) => cWords.some((cw: string) => cw.startsWith(qw) || cw.includes(qw)));
      if (allMatched) {
        return 0.7 + (qWords.length / cWords.length) * 0.1;
      }
      const initials = cWords.map((w: string) => w[0]).join('');
      if (initials.startsWith(q)) return 0.6;
      
      const s1 = c.replace(/\s+/g, '');
      const s2 = q.replace(/\s+/g, '');
      if (s1 === s2) return 0.95;
      if (s1.length < 2 || s2.length < 2) return 0;
      
      const getBigrams = (s: string) => {
        const bigrams = new Set<string>();
        for (let i = 0; i < s.length - 1; i++) {
          bigrams.add(s.substring(i, i + 2));
        }
        return bigrams;
      };
      const bigrams1 = getBigrams(s1);
      const bigrams2 = getBigrams(s2);
      let intersection = 0;
      for (const b of bigrams1) {
        if (bigrams2.has(b)) intersection++;
      }
      const dice = (2 * intersection) / (bigrams1.size + bigrams2.size);
      return dice > 0.45 ? dice * 0.7 : 0;
    }

    it('matches exact case-insensitive names and ignores accents/emojis', () => {
      expect(getMatchScore('Jair Monr 🚀', 'jair monr')).toBe(1.0);
      expect(getMatchScore('Sofía', 'sofia')).toBe(1.0);
    });

    it('assigns high score for substring matches', () => {
      const score = getMatchScore('Jair Monr', 'jair mon');
      expect(score).toBeGreaterThanOrEqual(0.8);
      expect(score).toBeLessThan(1.0);
    });

    it('assigns moderate score for fuzzy matching close names (Dice)', () => {
      const score = getMatchScore('Jair Monr', 'jayr monr');
      expect(score).toBeGreaterThanOrEqual(0.35); // Above threshold
    });

    it('returns 0 or low score for completely unrelated names', () => {
      expect(getMatchScore('Contacts', 'jair monr')).toBe(0);
      expect(getMatchScore('Messages', 'jair monr')).toBe(0);
      expect(getMatchScore('Ana', 'jair monr')).toBeLessThan(0.35);
    });
  });
});

