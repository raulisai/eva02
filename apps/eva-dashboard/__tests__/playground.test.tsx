import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlaygroundClient } from '@/components/playground/playground-client';
import type { EvaEvent, Task, TaskStatus } from '@/lib/types';

const mockWsState: {
  events: EvaEvent[];
  taskPatches: Record<string, TaskStatus>;
} = {
  events: [],
  taskPatches: {},
};

jest.mock('@/hooks/use-ws', () => ({
  useWs: () => ({
    connected: true,
    events: mockWsState.events,
    taskPatches: mockWsState.taskPatches,
    patchTaskStatus: jest.fn(),
  }),
}));

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }),
    },
    from: () => ({
      select: () => ({
        eq: function eq() { return this; },
        maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      }),
    }),
  }),
}));

const task: Task = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  org_id: 'org',
  created_by: 'user',
  title: 'Resume mis notificaciones',
  description: 'Resume mis notificaciones',
  status: 'planning',
  metadata: { source: 'playground' },
  result: null,
  error: null,
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('PlaygroundClient', () => {
  beforeEach(() => {
    mockWsState.events = [];
    mockWsState.taskPatches = {};
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => task,
      text: async () => '',
    }) as jest.Mock;
  });

  it('submits an order and renders the pipeline with the active stage', async () => {
    render(<PlaygroundClient />);

    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'Resume mis notificaciones' } });
    fireEvent.click(screen.getByText('Run'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/tasks'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(await screen.findByTestId('pipeline')).toBeInTheDocument();
    ['Received', 'Planning', 'Executing', 'Approval', 'Done'].forEach((stage) => {
      expect(screen.getByText(stage)).toBeInTheDocument();
    });
    // The order shows as the user bubble in the conversation
    expect(screen.getByText('Resume mis notificaciones')).toBeInTheDocument();
    // Non-terminal task is flagged as running in background; chat input stays free
    expect(screen.getByText('en segundo plano')).toBeInTheDocument();
    expect(screen.getByLabelText('Order')).not.toBeDisabled();

    // Conversation shows the user order and the working indicator;
    // the action log console is live from the start.
    expect(screen.getByTestId('conversation')).toBeInTheDocument();
    expect(screen.getByText('EVA está trabajando…')).toBeInTheDocument();
    expect(screen.getByTestId('action-log')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the agent to start…')).toBeInTheDocument();
  });

  it('renders the final model answer for a simple greeting path', async () => {
    const greetingTask = {
      ...task,
      title: 'hola',
      description: 'hola',
      status: 'running' as const,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => greetingTask,
      text: async () => '',
    }) as jest.Mock;

    const { rerender } = render(<PlaygroundClient />);

    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'hola' } });
    fireEvent.click(screen.getByText('Run'));

    await screen.findByText('hola');

    mockWsState.events = [
      {
        type: 'task.result',
        orgId: 'org',
        taskId: greetingTask.id,
        payload: { text: 'Hola, aqui estoy. ¿Que hacemos?', model: 'claude-haiku', latency_ms: 42 },
        ts: Date.now(),
      },
    ];
    mockWsState.taskPatches = { [greetingTask.id]: 'completed' };
    rerender(<PlaygroundClient />);

    expect(await screen.findByText('Hola, aqui estoy. ¿Que hacemos?')).toBeInTheDocument();
    expect(screen.queryByText('EVA está trabajando…')).not.toBeInTheDocument();
  });

  it('sends explicit feedback for a completed answer', async () => {
    const completedTask = {
      ...task,
      status: 'completed' as const,
      result: { text: 'Listo, ya lo hice.' },
    };
    mockWsState.events = [];
    mockWsState.taskPatches = {};
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => completedTask,
      text: async () => '',
    }) as jest.Mock;

    render(<PlaygroundClient />);

    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'haz una prueba' } });
    fireEvent.click(screen.getByText('Run'));

    expect(await screen.findByText('Listo, ya lo hice.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Mark answer helpful'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/agent/feedback'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"reaction":"positive"'),
        }),
      );
    });
    expect(await screen.findByText('feedback saved')).toBeInTheDocument();
  });
});
