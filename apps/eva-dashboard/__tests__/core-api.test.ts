import { coreFetch } from '@/lib/core-api';

const getSession = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}));

describe('coreFetch', () => {
  const response = (status: number, body: string, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: jest.fn().mockResolvedValue(body),
  });

  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } } });
    global.fetch = jest.fn();
  });

  it('accepts a successful 204 response without parsing JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response(204, ''));

    await expect(coreFetch('/dev-studio/session/test', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('accepts a successful empty response body', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response(200, ''));

    await expect(coreFetch('/dev-studio/session/test')).resolves.toBeUndefined();
  });

  it('still parses successful JSON responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response(
      200,
      JSON.stringify({ ok: true }),
      { 'content-type': 'application/json' },
    ));

    await expect(coreFetch<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true });
  });
});
