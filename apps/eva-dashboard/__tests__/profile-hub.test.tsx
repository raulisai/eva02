import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileHubClient } from '@/components/profile/profile-hub-client';

const mockCoreFetch = jest.fn();

jest.mock('@/lib/core-api', () => ({
  coreFetch: (...args: unknown[]) => mockCoreFetch(...args),
}));

function renderProfile() {
  return render(
    <ProfileHubClient
      personaContext={{ personal_profile: {}, cowork_context: {} }}
      todos={[]}
      notes={[]}
      goals={[]}
      privateItems={[]}
      scheduleEvents={[]}
      places={[
        {
          id: 'place-work',
          label: 'trabajo',
          address: 'Oficina vieja',
          lat: null,
          lng: null,
          visit_count: 3,
          last_visit: null,
          typical_days: null,
        },
      ]}
    />,
  );
}

describe('ProfileHubClient', () => {
  beforeEach(() => {
    mockCoreFetch.mockReset();
  });

  it('edits an existing place address from the profile hub', async () => {
    mockCoreFetch.mockResolvedValueOnce({
      id: 'place-work',
      label: 'oficina',
      address: 'Reforma 123',
      lat: null,
      lng: null,
      visit_count: 3,
      last_visit: null,
      typical_days: null,
    });

    renderProfile();

    fireEvent.click(screen.getByLabelText('Editar trabajo'));
    fireEvent.change(screen.getByDisplayValue('trabajo'), { target: { value: 'oficina' } });
    fireEvent.change(screen.getByDisplayValue('Oficina vieja'), { target: { value: 'Reforma 123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => {
      expect(mockCoreFetch).toHaveBeenCalledWith('/agent/profile/places/place-work', {
        method: 'PATCH',
        body: JSON.stringify({ label: 'oficina', address: 'Reforma 123' }),
      });
    });
    expect(await screen.findByText('oficina')).toBeInTheDocument();
    expect(screen.getByText('Reforma 123')).toBeInTheDocument();
  });
});
