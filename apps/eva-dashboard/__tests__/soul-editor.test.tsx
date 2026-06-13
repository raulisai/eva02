import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SoulEditor } from '@/components/soul/soul-editor';
import { coreFetch } from '@/lib/core-api';
import type { AgentSoul } from '@/lib/types';

const upsert = jest.fn().mockResolvedValue({ error: null });

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      upsert,
    }),
  }),
}));

jest.mock('@/lib/core-api', () => ({
  coreFetch: jest.fn(),
}));

const soul: AgentSoul = {
  id: 'soul-1',
  org_id: 'org-1',
  name: 'EVA',
  persona: 'Agente cuidadosa',
  directives: ['Always answer in Spanish'],
  autonomy_level: 1,
  model_prefs: {},
  persona_context: {
    personal_profile: { full_name: 'Diego' },
    cowork_context: { projects: 'EVA' },
  },
};

describe('SoulEditor', () => {
  beforeEach(() => {
    upsert.mockClear();
    (coreFetch as jest.Mock).mockClear();
  });

  it('renders only agent identity controls', () => {
    render(<SoulEditor orgId="org-1" initialSoul={soul} />);

    expect(screen.getByText('Identidad del agente')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre del agente')).toHaveValue('EVA');
    expect(screen.getByLabelText('Personalidad y comportamiento')).toHaveValue('Agente cuidadosa');
    expect(screen.queryByText('Datos personales')).not.toBeInTheDocument();
    expect(screen.queryByText('Boveda Privada')).not.toBeInTheDocument();
  });

  it('saves agent identity without calling private profile endpoints', async () => {
    render(<SoulEditor orgId="org-1" initialSoul={soul} />);

    fireEvent.change(screen.getByLabelText('Nombre del agente'), {
      target: { value: 'EVA Prime' },
    });
    fireEvent.click(screen.getByText('Save agent soul'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          name: 'EVA Prime',
          persona_context: soul.persona_context,
        }),
        { onConflict: 'org_id' },
      );
    });
    expect(coreFetch).not.toHaveBeenCalled();
  });
});
