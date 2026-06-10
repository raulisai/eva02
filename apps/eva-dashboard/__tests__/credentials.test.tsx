import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsClient } from '@/components/settings/credentials-client';
import type { Integration } from '@/lib/types';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }),
    },
  }),
}));

const googleIntegration: Integration = {
  id: 'int-g',
  kind: 'credential',
  provider: 'google',
  label: null,
  status: 'active',
  config: {},
  secret_hint: '••••oken',
  updated_at: new Date().toISOString(),
};

describe('CredentialsClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, email: 'raulisai97@gmail.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }),
      text: async () => '',
    }) as jest.Mock;
  });

  it('shows the Google full integration with its capabilities', () => {
    render(<CredentialsClient initialIntegrations={[]} />);

    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByText('FULL INTEGRATION')).toBeInTheDocument();
    expect(screen.getByText('Leer correos (Gmail)')).toBeInTheDocument();
    expect(screen.getByText('Calendario')).toBeInTheDocument();
    expect(screen.getByText('Uber')).toBeInTheDocument();
    expect(screen.getByText('Pedir viajes (con aprobación)')).toBeInTheDocument();
    // Secrets are password inputs
    expect(screen.getByLabelText('Google client secret')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Google refresh token')).toHaveAttribute('type', 'password');
  });

  it('tests the Google credential and shows the connected account', async () => {
    render(<CredentialsClient initialIntegrations={[googleIntegration]} />);

    fireEvent.click(screen.getByText('Test — read my Gmail profile'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/credential/google/test'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('Conectado como raulisai97@gmail.com')).toBeInTheDocument();
  });

  it('saves the Google credential as a single encrypted blob', async () => {
    render(<CredentialsClient initialIntegrations={[]} />);

    fireEvent.change(screen.getByLabelText('Google client ID'), { target: { value: 'cid.apps.googleusercontent.com' } });
    fireEvent.change(screen.getByLabelText('Google client secret'), { target: { value: 'GOCSPX-abc' } });
    fireEvent.change(screen.getByLabelText('Google refresh token'), { target: { value: '1//refresh' } });
    fireEvent.click(screen.getByText('Save credential'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    const secret = JSON.parse(body.secret);
    expect(secret).toEqual({
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'GOCSPX-abc',
      refresh_token: '1//refresh',
    });
  });
});
