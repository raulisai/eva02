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
  coreFetch: jest.fn().mockResolvedValue({ private_context_hint: 'saved' }),
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
    relationship_map: [
      {
        id: 'mom',
        display_name: 'Maria',
        relation: 'mama',
        aliases: ['mamá', 'madre'],
      },
    ],
  },
  private_context_hint: '12 words stored encrypted',
};

describe('SoulEditor', () => {
  beforeEach(() => {
    upsert.mockClear();
    (coreFetch as jest.Mock).mockClear();
  });

  it('keeps agent identity separate from user profile by default', () => {
    render(<SoulEditor orgId="org-1" initialSoul={soul} />);

    expect(screen.getByRole('tab', { name: /Agente EVA/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Identidad del agente')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre del agente')).toHaveValue('EVA');
    expect(screen.queryByText('Datos personales')).not.toBeInTheDocument();
  });

  it('shows the user profile as its own section', () => {
    render(<SoulEditor orgId="org-1" initialSoul={soul} />);

    fireEvent.click(screen.getByRole('tab', { name: /Mi perfil/i }));

    expect(screen.getByText('Informacion del usuario')).toBeInTheDocument();
    expect(screen.getByText('Datos personales')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Diego')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Maria')).toBeInTheDocument();
    expect(screen.queryByLabelText('Nombre del agente')).not.toBeInTheDocument();
  });

  it('saves private context through eva-core instead of direct Supabase fields', async () => {
    render(<SoulEditor orgId="org-1" initialSoul={soul} />);

    fireEvent.click(screen.getByRole('tab', { name: /Privado/i }));
    fireEvent.change(screen.getByPlaceholderText(/Datos que EVA puede usar/i), {
      target: { value: 'Dato sensible de prueba' },
    });
    fireEvent.click(screen.getByText('Save private vault'));

    await waitFor(() => {
      expect(coreFetch).toHaveBeenCalledWith('/agent/soul/private-context', {
        method: 'POST',
        body: expect.stringContaining('Dato sensible de prueba'),
      });
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: 'org-1',
        persona_context: expect.any(Object),
      }),
      { onConflict: 'org_id' },
    );
  });
});
