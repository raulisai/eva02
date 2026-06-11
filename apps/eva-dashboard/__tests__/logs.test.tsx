import { act, render, screen } from '@testing-library/react';
import { LogConsoleContent } from '@/components/debug/log-console';
import { WsProvider } from '@/hooks/use-ws';
import { resetMockSocket, triggerEvent } from '../__mocks__/socket.io-client';

jest.mock('socket.io-client');

async function renderLogs() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <WsProvider token="test-token">
        <LogConsoleContent />
      </WsProvider>,
    );
  });
  // @ts-expect-error assigned inside act
  return result!;
}

describe('LogConsoleContent', () => {
  beforeEach(() => resetMockSocket());

  it('renders live browser debug logs with module, action, and selector details', async () => {
    await renderLogs();

    await act(async () => {
      triggerEvent('task.log', {
        taskId: 'cccccccc-0000-0000-0000-000000000001',
        payload: {
          message: 'clicked button[aria-label="Pay"]',
          scope: 'browser',
          module: 'BrowserService',
          action: 'browser.click',
          selector: 'button[aria-label="Pay"]',
        },
        ts: Date.now(),
      });
    });

    expect(screen.getByText('browser.click')).toBeInTheDocument();
    expect(screen.getByText('BrowserService')).toBeInTheDocument();
    expect(screen.getByText('clicked button[aria-label="Pay"]')).toBeInTheDocument();
    expect(screen.getAllByText(/button\[aria-label/).length).toBeGreaterThan(0);
  });

  it('redacts sensitive payload fields before rendering details', async () => {
    await renderLogs();

    await act(async () => {
      triggerEvent('task.log', {
        payload: {
          message: 'token check',
          scope: 'pipeline',
          access_token: 'secret-token',
          nested: { password: 'secret-password' },
        },
        ts: Date.now(),
      });
    });

    expect(screen.getByText('token check')).toBeInTheDocument();
    expect(screen.getAllByText(/\[redacted\]/).length).toBeGreaterThan(0);
    expect(screen.queryByText('secret-token')).not.toBeInTheDocument();
    expect(screen.queryByText('secret-password')).not.toBeInTheDocument();
  });
});
