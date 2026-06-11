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

const emptyBrowserStatus = {
  ok: true,
  has_session: false,
  session_id: null,
  state: null,
  current_url: null,
};

function mockCoreFetch(handler?: (href: string, init?: RequestInit) => unknown) {
  global.fetch = jest.fn().mockImplementation(async (url, init) => {
    const href = String(url);
    if (href.includes('/integrations/uber/status') || href.includes('/integrations/rappi/status')) {
      return {
        ok: true,
        json: async () => emptyBrowserStatus,
        text: async () => '',
      };
    }
    const handled = handler?.(href, init);
    return {
      ok: true,
      json: async () => handled ?? fullOkResponse,
      text: async () => '',
    };
  }) as jest.Mock;
}

describe('CredentialsClient', () => {
  beforeEach(() => {
    mockCoreFetch();
  });

  it('shows the Google full integration with its capabilities', () => {
    renderWithToast(<CredentialsClient initialIntegrations={[]} />);

    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByText('FULL INTEGRATION')).toBeInTheDocument();
    expect(screen.getByText('Leer correos (Gmail)')).toBeInTheDocument();
    expect(screen.getByText('Calendario')).toBeInTheDocument();
    expect(screen.getByText('Google Web Login')).toBeInTheDocument();
    expect(screen.getByText('Uber')).toBeInTheDocument();
    expect(screen.getByText('Pedir viaje (con aprobación)')).toBeInTheDocument();
    expect(screen.getByLabelText('Google client secret')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Google refresh token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Google cookies JSON')).toBeInTheDocument();
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
    mockCoreFetch(() => partialResponse);

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
    mockCoreFetch(() => ({ ok: false, scopes: [], error: 'Token has been expired or revoked.', services: undefined }));

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

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/credential/google'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
      String(url).includes('/integrations/credential/google'),
    );
    const body = JSON.parse(init.body);
    const secret = JSON.parse(body.secret);
    expect(secret).toEqual({
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'GOCSPX-abc',
      refresh_token: '1//refresh',
    });
  });

  it('imports Google Web cookies as a browser session', async () => {
    renderWithToast(<CredentialsClient initialIntegrations={[]} />);

    fireEvent.change(screen.getByLabelText('Google cookies JSON'), {
      target: { value: '[{"name":"SID","value":"abc","domain":".google.com","path":"/"}]' },
    });
    fireEvent.click(screen.getByText('Importar sesión'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/google-web/import-session'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const [url, init] = (global.fetch as jest.Mock).mock.calls.find(([callUrl]) =>
      String(callUrl).includes('/integrations/google-web/import-session'),
    );
    const body = JSON.parse(init.body);
    expect(String(url)).toContain('/integrations/google-web/import-session');
    expect(body.cookies).toEqual([
      { name: 'SID', value: 'abc', domain: '.google.com', path: '/' },
    ]);
  });

  it('starts the Google Web login test and renders the 2FA screenshot', async () => {
    mockCoreFetch((href) => {
      if (href.includes('/integrations/google-web/start-session')) return {
        ok: false,
        state: 'mfa_required',
        text: 'Google pidió verificación en dos pasos para raulisai97@gmail.com.',
        screenshot: { image_base64: 'Z29vZ2xl', mime_type: 'image/png' },
      };
      return fullOkResponse;
    });

    renderWithToast(<CredentialsClient initialIntegrations={[googleWebIntegration]} />);

    fireEvent.click(screen.getAllByText('Verificar sesión')[0]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/integrations/google-web/start-session'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect((await screen.findAllByText(/verificación en dos pasos/)).length).toBeGreaterThan(0);
    expect(screen.getByAltText('Google Web session screenshot')).toHaveAttribute('src', 'data:image/png;base64,Z29vZ2xl');
  });

  it('rehydrates saved Uber email, status, and last screenshot', async () => {
    global.fetch = jest.fn().mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/integrations/uber/status')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            has_session: true,
            session_id: 'session-uber',
            state: 'logged_in',
            current_url: 'https://m.uber.com/go/home',
            email: 'eva02.ia@gmail.com',
            last_verified_at: '2026-06-11T18:00:00.000Z',
            screenshot: { image_base64: 'dWJlcg==', mime_type: 'image/png' },
          }),
          text: async () => '',
        };
      }
      if (href.includes('/integrations/rappi/status')) {
        return {
          ok: true,
          json: async () => emptyBrowserStatus,
          text: async () => '',
        };
      }
      return {
        ok: true,
        json: async () => fullOkResponse,
        text: async () => '',
      };
    }) as jest.Mock;

    renderWithToast(<CredentialsClient initialIntegrations={[]} />);

    expect(await screen.findByDisplayValue('eva02.ia@gmail.com')).toBeInTheDocument();
    expect(await screen.findByText(/Sesión guardada: activa/)).toBeInTheDocument();
    expect(screen.getByAltText('Uber screenshot')).toHaveAttribute('src', 'data:image/png;base64,dWJlcg==');
  });
});
