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
});
