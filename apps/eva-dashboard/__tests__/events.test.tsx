import { render, screen, act } from '@testing-library/react';
import { EventFeed } from '@/components/events/event-feed';
import { WsProvider } from '@/hooks/use-ws';
import { triggerEvent, resetMockSocket } from '../__mocks__/socket.io-client';

jest.mock('socket.io-client');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/events',
}));

async function renderFeed() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <WsProvider token="test-token">
        <EventFeed />
      </WsProvider>,
    );
  });
  // @ts-expect-error assigned inside act
  return result!;
}

describe('EventFeed', () => {
  beforeEach(() => resetMockSocket());

  it('renders column headers', async () => {
    await renderFeed();
    expect(screen.getByText('TIME')).toBeInTheDocument();
    expect(screen.getByText('EVENT')).toBeInTheDocument();
    expect(screen.getByText('TASK ID')).toBeInTheDocument();
    expect(screen.getByText('PAYLOAD')).toBeInTheDocument();
  });

  it('shows connected status after WS connects', async () => {
    await renderFeed();
    // After the auto-connect microtask, the footer changes from "disconnected" to something live
    expect(screen.queryByText('disconnected')).not.toBeInTheDocument();
  });

  it('shows "stream live" when connected with no events', async () => {
    await renderFeed();
    expect(screen.getByText(/stream live/i)).toBeInTheDocument();
  });

  it('displays new events as they arrive via WebSocket', async () => {
    await renderFeed();

    await act(async () => {
      triggerEvent('task.created', {
        taskId: 'cccc-0001',
        payload: { title: 'My task' },
        ts: Date.now(),
      });
    });

    expect(screen.getByText('task.created')).toBeInTheDocument();
  });

  it('appends multiple events in newest-first order', async () => {
    await renderFeed();
    const ts = Date.now();

    await act(async () => {
      triggerEvent('task.created',   { taskId: 't1', payload: {}, ts: ts - 2000 });
      triggerEvent('task.started',   { taskId: 't1', payload: {}, ts: ts - 1000 });
      triggerEvent('task.completed', { taskId: 't1', payload: {}, ts });
    });

    const rows = screen.getAllByText(/task\./);
    expect(rows[0].textContent).toBe('task.completed');
    expect(rows[1].textContent).toBe('task.started');
    expect(rows[2].textContent).toBe('task.created');
  });

  it('shows task ID truncated to 8 chars', async () => {
    await renderFeed();

    await act(async () => {
      triggerEvent('task.started', {
        taskId: '12345678-abcd-0000-0000-000000000001',
        payload: {},
        ts: Date.now(),
      });
    });

    expect(screen.getByText('12345678')).toBeInTheDocument();
  });
});
