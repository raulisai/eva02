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

describe('ChannelsClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...telegram, secret_hint: '••••wxyz', has_secret: true }),
      text: async () => '',
    }) as jest.Mock;
  });

  it('renders the telegram channel with masked token state', () => {
    render(<ChannelsClient initialIntegrations={[telegram]} />);

    expect(screen.getByRole('heading', { name: 'Telegram' })).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('token ••••abcd')).toBeInTheDocument();
    expect(screen.getByLabelText('Bot token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Allowed Telegram user IDs')).toHaveValue('123');
  });

  it('saves the bot token through eva-core, never exposing it afterwards', async () => {
    render(<ChannelsClient initialIntegrations={[telegram]} />);

    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '123456:new-token' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/channel/telegram'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.secret).toBe('123456:new-token');
    expect(screen.getByLabelText('Bot token')).toHaveValue('');
    expect(await screen.findByText(/Saved\. Token stored encrypted/)).toBeInTheDocument();
  });

  it('shows placeholder state for channels that are not wired yet', () => {
    render(<ChannelsClient initialIntegrations={[]} />);

    fireEvent.click(screen.getByText('Discord'));
    expect(screen.getByText(/not wired into eva-core yet/)).toBeInTheDocument();
  });
});
