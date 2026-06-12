import { TelegramAdapter } from '../telegram.adapter';

describe('TelegramAdapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends plain text without Telegram Markdown parse_mode', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ result: { message_id: 123 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new TelegramAdapter();
    const result = await adapter.sendMessage(
      { chat_id: '100' },
      'Tu último chat visible en WhatsApp es **Ana**',
      'bot-token',
    );

    expect(result).toEqual({ ok: true, externalMessageId: '123' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual(expect.objectContaining({
      chat_id: '100',
      text: 'Tu último chat visible en WhatsApp es **Ana**',
      disable_web_page_preview: true,
    }));
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('sends photos without Markdown parse_mode', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ result: { message_id: 456 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new TelegramAdapter();
    const result = await adapter.sendPhoto(
      { chat_id: '100' },
      'https://storage.example.com/qr.png',
      'Imagen generada',
      'bot-token',
    );

    expect(result).toEqual({ ok: true, externalMessageId: '456' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual(expect.objectContaining({
      chat_id: '100',
      photo: 'https://storage.example.com/qr.png',
      caption: 'Imagen generada',
    }));
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('downloads Telegram files through getFile without exposing the bot token in callers', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ ok: true, result: { file_path: 'photos/file_1.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: jest.fn().mockReturnValue('image/jpeg') },
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('image-bytes')),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new TelegramAdapter();
    const result = await adapter.downloadFile('photo-id', 'bot-token');

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      filePath: 'photos/file_1.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from('image-bytes'),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.telegram.org/botbot-token/getFile', expect.objectContaining({
      method: 'POST',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.telegram.org/file/botbot-token/photos/file_1.jpg');
  });

  describe('sendDocument', () => {
    it('sends mp4 files using sendVideo for native playback in Telegram', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: { message_id: 789 } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const adapter = new TelegramAdapter();
      const buffer = Buffer.from('fake-video-data');
      const result = await adapter.sendDocument(
        { chat_id: '100' },
        buffer,
        'platzi_course.mp4',
        '¡Aquí está tu video! 🎬',
        'bot-token',
      );

      expect(result).toEqual({ ok: true, externalMessageId: '789' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/sendVideo');
    });

    it('sends non-video files using sendDocument endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: { message_id: 101 } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const adapter = new TelegramAdapter();
      const buffer = Buffer.from('fake-pdf-data');
      const result = await adapter.sendDocument(
        { chat_id: '200' },
        buffer,
        'report.pdf',
        undefined,
        'bot-token',
      );

      expect(result).toEqual({ ok: true, externalMessageId: '101' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/sendDocument');
    });

    it('rejects oversized files (>50 MB) without calling Telegram API', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const adapter = new TelegramAdapter();
      const bigBuffer = Buffer.alloc(51 * 1024 * 1024); // 51 MB
      const result = await adapter.sendDocument(
        { chat_id: '100' },
        bigBuffer,
        'huge_video.mp4',
        undefined,
        'bot-token',
      );

      expect(result.ok).toBe(false);
      expect((result as { oversized?: boolean }).oversized).toBe(true);
      expect(result.error).toContain('supera el límite de 50 MB');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns error when chat_id is missing', async () => {
      const adapter = new TelegramAdapter();
      const result = await adapter.sendDocument(
        {},
        Buffer.from('data'),
        'file.mp4',
        undefined,
        'bot-token',
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('chat_id');
    });
  });
});
