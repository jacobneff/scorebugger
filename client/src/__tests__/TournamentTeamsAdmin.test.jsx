import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TournamentTeamsAdmin from '../pages/TournamentTeamsAdmin.jsx';

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

describe('TournamentTeamsAdmin', () => {
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

  it('uses label-only location UI and clears coordinates on save', async () => {
    const patchBodies = [];
    const tournament = {
      _id: 'tour-1',
      name: 'City Open',
      date: '2026-06-01T00:00:00.000Z',
      timezone: 'America/New_York',
      publicCode: 'ABC123',
      status: 'setup',
      details: {},
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
        return {
          ok: true,
          json: async () => [
            {
              _id: 'team-1',
              name: 'Rockets',
              shortName: 'Rockets',
              logoUrl: null,
              location: {
                label: 'Norfolk, VA',
                latitude: 36.8863,
                longitude: -76.3057,
              },
              orderIndex: 1,
            },
          ],
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams/links') && method === 'GET') {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournament-teams/team-1') && method === 'PATCH') {
        patchBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            _id: 'team-1',
            name: 'Rockets',
            shortName: 'Rockets',
            location: {
              label: 'Virginia Beach, VA',
              latitude: null,
              longitude: null,
            },
          }),
        };
      }

      throw new Error(`Unhandled fetch URL: ${requestUrl}`);
    });

    render(<TournamentTeamsAdmin />);

    expect(await screen.findByText('Your Tournaments')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Google Maps search/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Latitude$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Longitude$/i)).not.toBeInTheDocument();

    const user = userEvent.setup();
    const rowLocationInput = await screen.findByDisplayValue('Norfolk, VA');
    await user.clear(rowLocationInput);
    await user.type(rowLocationInput, 'Virginia Beach, VA');
    await user.click(screen.getByRole('button', { name: 'Save team fields' }));

    await waitFor(() => {
      expect(patchBodies).toHaveLength(1);
    });

    expect(patchBodies[0]).toEqual({
      location: {
        label: 'Virginia Beach, VA',
        latitude: null,
        longitude: null,
      },
    });
  });
});
