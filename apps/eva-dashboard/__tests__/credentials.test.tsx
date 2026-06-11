import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsClient } from '@/components/settings/credentials-client';
import { ToastProvider } from '@/components/ui/toast';
import type { Integration } from '@/lib/types';

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

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

const googleWebIntegration: Integration = {
  id: 'int-gw',
  kind: 'credential',
  provider: 'google_web',
  label: null,
  status: 'active',
  config: { purpose: 'browser_login' },
  secret_hint: 'ra••••@gmail.com',
  updated_at: new Date().toISOString(),
};

const fullOkResponse = {
  ok: true,
  email: 'raulisai97@gmail.com',
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  services: {
    gmail:    { ok: true },
    calendar: { ok: true },
    drive:    { ok: true },
  },
};

const partialResponse = {
  ok: false,
  email: 'raulisai97@gmail.com',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  services: {
    gmail:    { ok: true },
    calendar: { ok: false, error: 'Request had insufficient authentication scopes.' },
    drive:    { ok: false, error: 'Request had insufficient authentication scopes.' },
  },
};

describe('CredentialsClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => fullOkResponse,
      text: async () => '',
    }) as jest.Mock;
  });

  it('shows the Google full integration with its capabilities', () => {
    renderWithToast(<CredentialsClient initialIntegrations={[]} />);

    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByText('FULL INTEGRATION')).toBeInTheDocument();
    expect(screen.getByText('Leer correos (Gmail)')).toBeInTheDocument();
    expect(screen.getByText('Calendario')).toBeInTheDocument();
    expect(screen.getByText('Google Web Login')).toBeInTheDocument();
    expect(screen.getByText('Uber')).toBeInTheDocument();
    expect(screen.getByText('Pedir viajes (con aprobación)')).toBeInTheDocument();
    expect(screen.getByLabelText('Google client secret')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Google refresh token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Google Web password')).toHaveAttribute('type', 'password');
  });

  it('calls /test/full and shows per-service status when all services pass', async () => {
    renderWithToast(<CredentialsClient initialIntegrations={[googleIntegration]} />);

    fireEvent.click(screen.getByText('Test Gmail · Calendar · Drive'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/credential/google/test/full'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(await screen.findByText('Conectado como raulisai97@gmail.com')).toBeInTheDocument();
    // Service badges — queried by title attribute (text is mixed with an icon child)
    expect(await screen.findByTitle('Gmail: acceso confirmado')).toBeInTheDocument();
    expect(await screen.findByTitle('Calendar: acceso confirmado')).toBeInTheDocument();
    expect(await screen.findByTitle('Drive: acceso confirmado')).toBeInTheDocument();
  });

  it('shows which services fail when scopes are missing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => partialResponse,
      text: async () => '',
    }) as jest.Mock;

    renderWithToast(<CredentialsClient initialIntegrations={[googleIntegration]} />);

    fireEvent.click(screen.getByText('Test Gmail · Calendar · Drive'));

    // Still shows account (email is set in partial response)
    expect(await screen.findByText('Conectado como raulisai97@gmail.com')).toBeInTheDocument();

    // Gmail is ok, Calendar and Drive show the specific error in their title
    expect(await screen.findByTitle('Gmail: acceso confirmado')).toBeInTheDocument();
    expect(await screen.findByTitle(/Calendar: Request had insufficient/)).toBeInTheDocument();
    expect(await screen.findByTitle(/Drive: Request had insufficient/)).toBeInTheDocument();
  });

  it('shows a clear toast error when the refresh token is rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, scopes: [], error: 'Token has been expired or revoked.', services: undefined }),
      text: async () => '',
    }) as jest.Mock;

    renderWithToast(<CredentialsClient initialIntegrations={[googleIntegration]} />);

    fireEvent.click(screen.getByText('Test Gmail · Calendar · Drive'));

    // Toast renders in the ToastProvider — text includes the API error message
    expect(await screen.findByText(/Token has been expired or revoked/)).toBeInTheDocument();
    // Account panel must NOT appear (setGoogleAccount(null) was called)
    expect(screen.queryByText(/Conectado como/)).not.toBeInTheDocument();
  });

  it('saves the Google credential as a single encrypted blob', async () => {
    renderWithToast(<CredentialsClient initialIntegrations={[]} />);

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

  it('saves Google Web email/password separately for browser login', async () => {
    renderWithToast(<CredentialsClient initialIntegrations={[]} />);

    fireEvent.change(screen.getByLabelText('Google Web email'), { target: { value: 'operator@example.com' } });
    fireEvent.change(screen.getByLabelText('Google Web password'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByText('Save web login'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(String(url)).toContain('/integrations/credential/google_web');
    expect(JSON.parse(body.secret)).toEqual({
      email: 'operator@example.com',
      password: 'secret-password',
    });
  });

  it('starts the Google Web login test and renders the 2FA screenshot', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        state: 'mfa_required',
        text: 'Google pidió verificación en dos pasos para raulisai97@gmail.com.',
        screenshot: { image_base64: 'Z29vZ2xl', mime_type: 'image/png' },
      }),
      text: async () => '',
    }) as jest.Mock;

    renderWithToast(<CredentialsClient initialIntegrations={[googleWebIntegration]} />);

    fireEvent.click(screen.getByText('Test browser login'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/google-web/start-session'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect((await screen.findAllByText(/verificación en dos pasos/)).length).toBeGreaterThan(0);
    expect(screen.getByAltText('Google Web login screenshot')).toHaveAttribute('src', 'data:image/png;base64,Z29vZ2xl');
  });
});
