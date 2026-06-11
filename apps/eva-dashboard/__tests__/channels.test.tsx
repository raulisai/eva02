import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChannelsClient } from '@/components/settings/channels-client';
import type { Integration } from '@/lib/types';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }),
    },
  }),
}));

const telegram: Integration = {
  id: 'int-1',
  kind: 'channel',
  provider: 'telegram',
  label: null,
  status: 'active',
  config: { allowed_user_ids: '123' },
  secret_hint: '••••abcd',
  updated_at: new Date().toISOString(),
};

const wearOverview = {
  status: 'active',
  enabled_commands: ['agent.ask', 'wear.notify'],
  commands: [
    {
      id: 'agent.ask', direction: 'watch_to_core', label: 'Ask EVA',
      description: 'Voice/text query', category: 'agent', approval_level: 0,
      example: { request_type: 'ask' },
    },
    {
      id: 'wear.open_app', direction: 'core_to_watch', label: 'Open app',
      description: 'Launch an app on the watch', category: 'apps', approval_level: 1,
      example: { action: 'wear.open_app', payload: { package: 'com.ubercab' } },
    },
  ],
  devices: [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'Galaxy Watch', status: 'pending_pairing', created_at: new Date().toISOString() },
  ],
  endpoints: { websocket: '/eva (Socket.io, auth: { token })', fast_path: 'POST /wear-fast-path/request' },
};

function mockFetchForOverview() {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    const href = String(url);
    if (href.includes('/wear/overview')) {
      return { ok: true, json: async () => wearOverview, text: async () => '' };
    }
    if (href.includes('/integrations?kind=channel')) {
      return {
        ok: true,
        json: async () => [{ ...telegram, provider: 'whatsapp', label: 'WhatsApp Web', status: 'active' }],
        text: async () => '',
      };
    }
    if (href.includes('/integrations/uber/start-session')) {
      return {
        ok: true,
        json: async () => ({
          state: 'login_required',
          google_login_available: true,
          screenshot: { image_base64: 'dWJlcg==', mime_type: 'image/png' },
        }),
        text: async () => '',
      };
    }
    if (href.includes('/integrations/uber/start-google-login')) {
      return {
        ok: true,
        json: async () => ({
          ok: false,
          reason: 'google_mfa_required',
          text: 'Google pidió verificación en dos pasos. Te envié screenshot.',
          session: {
            state: 'login_required',
            google_login_available: true,
            screenshot: { image_base64: 'dWJlcmdvb2dsZQ==', mime_type: 'image/png' },
          },
        }),
        text: async () => '',
      };
    }
    if (href.includes('/integrations/whatsapp/start-session')) {
      return {
        ok: true,
        json: async () => ({
          state: 'qr_required',
          screenshot: { image_base64: 'cXI=', mime_type: 'image/png' },
        }),
        text: async () => '',
      };
    }
    if (href.includes('/integrations/whatsapp/validate')) {
      return {
        ok: true,
        json: async () => ({ state: 'logged_in' }),
        text: async () => '',
      };
    }
    if (href.includes('/integrations/whatsapp/test-screenshot')) {
      return {
        ok: true,
        json: async () => ({
          state: 'logged_in',
          screenshot: { image_base64: 'd2E=', mime_type: 'image/png' },
        }),
        text: async () => '',
      };
    }
    return {
      ok: true,
      json: async () => ({ ...telegram, secret_hint: '••••wxyz', has_secret: true }),
      text: async () => '',
    };
  }) as jest.Mock;
}

describe('ChannelsClient', () => {
  beforeEach(() => mockFetchForOverview());

  it('shows the wearOS watch as the primary channel with its command catalog', async () => {
    render(<ChannelsClient initialIntegrations={[telegram]} />);

    expect(await screen.findByText('PRIMARY CHANNEL')).toBeInTheDocument();
    expect(await screen.findByText('agent.ask')).toBeInTheDocument();
    expect(screen.getByText('wear.open_app')).toBeInTheDocument();
    expect(screen.getByText('Galaxy Watch')).toBeInTheDocument();
    expect(screen.getByText('Register device')).toBeInTheDocument();
    expect(screen.getByText(/POST \/wear-fast-path\/request/)).toBeInTheDocument();
    // watch→core command toggle reflects enabled state
    expect(screen.getByRole('switch', { name: 'Toggle Ask EVA' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Toggle Open app' })).toHaveAttribute('aria-checked', 'false');
  });

  it('renders the telegram channel with masked token state', async () => {
    render(<ChannelsClient initialIntegrations={[telegram]} />);
    fireEvent.click(screen.getByText('Telegram'));

    expect(screen.getByRole('heading', { name: 'Telegram' })).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('token ••••abcd')).toBeInTheDocument();
    expect(screen.getByLabelText('Bot token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Allowed Telegram user IDs')).toHaveValue('123');
  });

  it('saves the bot token through eva-core, never exposing it afterwards', async () => {
    render(<ChannelsClient initialIntegrations={[telegram]} />);
    fireEvent.click(screen.getByText('Telegram'));

    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '123456:new-token' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/channel/telegram'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const putCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url, init]) => String(url).includes('/integrations/channel/telegram') && init?.method === 'PUT',
    );
    expect(JSON.parse(putCall![1].body).secret).toBe('123456:new-token');
    expect(screen.getByLabelText('Bot token')).toHaveValue('');
    expect(await screen.findByText(/Saved\. Token stored encrypted/)).toBeInTheDocument();
  });

  it('shows placeholder state for channels that are not wired yet', () => {
    render(<ChannelsClient initialIntegrations={[]} />);

    fireEvent.click(screen.getByText('Discord'));
    expect(screen.getByText(/not wired into eva-core yet/)).toBeInTheDocument();
  });

  it('opens the Uber Web login profile and shows the Google login hint', async () => {
    render(<ChannelsClient initialIntegrations={[]} />);

    fireEvent.click(screen.getByText('Uber Web'));
    fireEvent.click(screen.getByText('Open Uber Web login'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/uber/start-session'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText(/choose Continue with Google/)).toBeInTheDocument();
    expect(screen.getByAltText('Uber Web session screenshot')).toHaveAttribute('src', 'data:image/png;base64,dWJlcg==');
  });

  it('starts Uber login with the stored Google Web credential and shows the manual 2FA screenshot', async () => {
    render(<ChannelsClient initialIntegrations={[]} />);

    fireEvent.click(screen.getByText('Uber Web'));
    fireEvent.click(screen.getByText('Login with Google credential'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/uber/start-google-login'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText(/verificación en dos pasos/)).toBeInTheDocument();
    expect(screen.getByAltText('Uber Web session screenshot')).toHaveAttribute('src', 'data:image/png;base64,dWJlcmdvb2dsZQ==');
  });

  it('opens, validates, and captures the WhatsApp Web profile', async () => {
    render(<ChannelsClient initialIntegrations={[]} />);

    fireEvent.click(screen.getByText('WhatsApp'));
    fireEvent.click(screen.getByText('Connect WhatsApp Web'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/whatsapp/start-session'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByAltText('WhatsApp Web QR')).toHaveAttribute('src', 'data:image/png;base64,cXI=');

    fireEvent.click(screen.getByText('Validar'));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/whatsapp/validate'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText(/validado y conectado/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Test captura'));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/whatsapp/test-screenshot'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByAltText('WhatsApp Web session screenshot')).toHaveAttribute('src', 'data:image/png;base64,d2E=');
  });
});
