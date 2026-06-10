import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlaygroundClient } from '@/components/playground/playground-client';
import type { Task } from '@/lib/types';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token' } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: jest.fn().mockResolvedValue({ data: null }) }),
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
    // Appears both in the header and as the user bubble in the conversation
    expect(screen.getAllByText('Resume mis notificaciones').length).toBeGreaterThanOrEqual(2);

    // Conversation shows the user order and the working indicator;
    // the action log console is live from the start.
    expect(screen.getByTestId('conversation')).toBeInTheDocument();
    expect(screen.getByText('EVA está trabajando…')).toBeInTheDocument();
    expect(screen.getByTestId('action-log')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the agent to start…')).toBeInTheDocument();
  });
});
