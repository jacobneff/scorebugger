import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TournamentDetailsAdmin from '../pages/TournamentDetailsAdmin.jsx';

let mockAuthState = {
  token: 'test-token',
  user: { id: 'user-1', email: 'owner@example.com' },
  initializing: false,
};

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'tour-1' }),
  useNavigate: () => vi.fn(),
}));

describe('TournamentDetailsAdmin', () => {
  beforeEach(() => {
    mockAuthState = {
      token: 'test-token',
      user: { id: 'user-1', email: 'owner@example.com' },
      initializing: false,
    };
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads route tournament details and saves via PATCH /details', async () => {
    const patchBodies = [];
    const tournament = {
      _id: 'tour-1',
      name: 'City Open',
      date: '2026-06-01T00:00:00.000Z',
      timezone: 'America/New_York',
      publicCode: 'ABC123',
      status: 'setup',
      details: {
        specialNotes: 'Old note',
        foodInfo: { text: 'Snacks', linkUrl: '' },
        facilitiesInfo: 'Court notes',
        parkingInfo: 'Lot B',
        mapImageUrls: [],
      },
    };

    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      const requestUrl = String(url);
      const method = options.method || 'GET';

      if (requestUrl.endsWith('/api/tournaments') && method === 'GET') {
        return { ok: true, json: async () => [tournament] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1') && method === 'GET') {
        return { ok: true, json: async () => tournament };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams') && method === 'GET') {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams/links') && method === 'GET') {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/details') && method === 'PATCH') {
        const body = JSON.parse(options.body);
        patchBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            details: {
              specialNotes: body.specialNotes,
              facilitiesInfo: body.facilitiesInfo,
              parkingInfo: body.parkingInfo,
              foodInfo: body.foodInfo,
              mapImageUrls: body.mapImageUrls,
            },
          }),
        };
      }

      throw new Error(`Unhandled fetch URL: ${requestUrl}`);
    });

    render(<TournamentDetailsAdmin />);

    const user = userEvent.setup();
    const specialNotesInput = await screen.findByLabelText('Special Notes (markdown supported)');
    expect(screen.queryByText('Your Tournaments')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tournament Hub' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All services' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Team Setup' })).toHaveAttribute('href', '/tournaments/tour-1/teams');
    expect(screen.getByRole('link', { name: 'Scheduling' })).toHaveAttribute('href', '/tournaments/tour-1/format');
    expect(screen.getByRole('link', { name: 'Quick Scores' })).toHaveAttribute('href', '/tournaments/tour-1/quick-scores');
    expect(screen.getByRole('link', { name: 'Public View' })).toHaveAttribute('href', '/t/ABC123');
    await user.clear(specialNotesInput);
    await user.type(specialNotesInput, 'Bring your own water.');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(patchBodies).toHaveLength(1);
    });

    expect(patchBodies[0]).toEqual(
      expect.objectContaining({
        specialNotes: 'Bring your own water.',
      })
    );
  });
});
