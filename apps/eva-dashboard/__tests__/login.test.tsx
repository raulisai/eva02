import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '@/app/login/page';

// Mock supabase browser client
const mockSignIn = jest.fn();
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mockSignIn,
    },
  }),
}));

const mockReplace = jest.fn();
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh, push: jest.fn() }),
  usePathname: () => '/login',
}));

describe('LoginPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders email, password fields and sign-in button', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('shows EVA branding', () => {
    render(<LoginPage />);
    expect(screen.getByText('EVA')).toBeInTheDocument();
    expect(screen.getByText(/command center/i)).toBeInTheDocument();
  });

  it('redirects to /tasks on successful sign-in', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'op@eva.io');
    await user.type(screen.getByLabelText(/password/i), 'secret');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith({ email: 'op@eva.io', password: 'secret' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/tasks'));
  });

  it('shows error message on auth failure', async () => {
    mockSignIn.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'bad@eva.io');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid login credentials'));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('disables button while loading', async () => {
    // Never resolves during test
    mockSignIn.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'op@eva.io');
    await user.type(screen.getByLabelText(/password/i), 'secret');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
  });
});
