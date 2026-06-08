import { render, screen, act } from '@testing-library/react';
import { TaskList } from '@/components/tasks/task-list';
import { WsProvider } from '@/hooks/use-ws';
import { triggerEvent, resetMockSocket } from '../__mocks__/socket.io-client';
import type { Task } from '@/lib/types';

jest.mock('socket.io-client');

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/tasks',
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'cccc-0001-0000-0000-000000000001',
    org_id: 'aaaa-0000-0000-0000-000000000001',
    created_by: 'bbbb-0000-0000-0000-000000000001',
    title: 'Analyze Q2 data',
    description: null,
    status: 'pending',
    metadata: {},
    result: null,
    error: null,
    started_at: null,
    completed_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

async function renderWithWs(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<WsProvider token="test-token">{ui}</WsProvider>);
  });
  // @ts-expect-error assigned inside act
  return result!;
}

describe('TaskList', () => {
  beforeEach(() => {
    resetMockSocket();
    mockPush.mockClear();
  });

  it('renders task rows with title and status', async () => {
    const tasks = [
      makeTask({ title: 'Task Alpha', status: 'pending' }),
      makeTask({ id: 'cccc-0002', title: 'Task Beta', status: 'running' }),
    ];
    await renderWithWs(<TaskList initialTasks={tasks} />);

    expect(screen.getByText('Task Alpha')).toBeInTheDocument();
    expect(screen.getByText('Task Beta')).toBeInTheDocument();
    expect(screen.getAllByTestId('task-row')).toHaveLength(2);
  });

  it('shows stat card labels', async () => {
    const tasks = [
      makeTask({ status: 'running' }),
      makeTask({ id: '2', status: 'completed' }),
      makeTask({ id: '3', status: 'failed' }),
    ];
    await renderWithWs(<TaskList initialTasks={tasks} />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('shows empty state when no tasks', async () => {
    await renderWithWs(<TaskList initialTasks={[]} />);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it('updates task status to "running" on task.started WS event', async () => {
    const taskId = 'cccc-0001-0000-0000-000000000001';
    await renderWithWs(<TaskList initialTasks={[makeTask({ id: taskId, status: 'pending' })]} />);

    await act(async () => {
      triggerEvent('task.started', { taskId, payload: {}, ts: Date.now() });
    });

    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('updates task status to "completed" on task.completed WS event', async () => {
    const taskId = 'cccc-0001-0000-0000-000000000001';
    await renderWithWs(<TaskList initialTasks={[makeTask({ id: taskId, status: 'running' })]} />);

    await act(async () => {
      triggerEvent('task.completed', { taskId, payload: {}, ts: Date.now() });
    });

    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('updates task status to "failed" on task.failed WS event', async () => {
    const taskId = 'cccc-0001-0000-0000-000000000001';
    await renderWithWs(<TaskList initialTasks={[makeTask({ id: taskId, status: 'running' })]} />);

    await act(async () => {
      triggerEvent('task.failed', { taskId, payload: {}, ts: Date.now() });
    });

    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('navigates to task detail on row click', async () => {
    const task = makeTask();
    await renderWithWs(<TaskList initialTasks={[task]} />);
    screen.getByTestId('task-row').click();
    expect(mockPush).toHaveBeenCalledWith(`/tasks/${task.id}`);
  });
});
