import { render, screen, waitFor } from '@testing-library/react';

import TournamentPoolPlayAdmin from '../pages/TournamentPoolPlayAdmin.jsx';

let mockAuthState = {
  token: 'test-token',
  user: { id: 'user-1', email: 'owner@example.com' },
  initializing: false,
};

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('../hooks/useTournamentRealtime.js', () => ({
  useTournamentRealtime: () => {},
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'tour-1' }),
  useNavigate: () => vi.fn(),
}));

describe('TournamentPoolPlayAdmin', () => {
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

  it('shows apply-format-first guard when no applied format exists', async () => {
    globalThis.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.endsWith('/api/tournaments/tour-1')) {
        return {
          ok: true,
          json: async () => ({
            _id: 'tour-1',
            name: 'City Open',
            publicCode: 'ABC123',
            settings: {
              format: {
                formatId: null,
                activeCourts: ['SRC-1', 'SRC-2', 'SRC-3'],
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams')) {
        return { ok: true, json: async () => [] };
      }

      throw new Error(`Unhandled fetch URL: ${requestUrl}`);
    });

    render(<TournamentPoolPlayAdmin />);

    expect(await screen.findByText('Apply format first.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Format Page' })).toHaveAttribute(
      'href',
      '/tournaments/tour-1/format'
    );
  });

  it('uses non-legacy pool-play tab and stage endpoints for 14-team format', async () => {
    globalThis.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.endsWith('/api/tournaments/tour-1')) {
        return {
          ok: true,
          json: async () => ({
            _id: 'tour-1',
            name: 'City Open',
            publicCode: 'ABC123',
            settings: {
              format: {
                formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
                activeCourts: ['SRC-1', 'SRC-2', 'SRC-3'],
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournament-formats/classic_14_mixedpools_crossover_gold8_silver6_v1')) {
        return {
          ok: true,
          json: async () => ({
            id: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
            stages: [
              {
                type: 'poolPlay',
                key: 'poolPlay1',
                displayName: 'Pool Play',
                pools: [
                  { name: 'A', size: 4 },
                  { name: 'B', size: 4 },
                  { name: 'C', size: 3 },
                  { name: 'D', size: 3 },
                ],
              },
              {
                type: 'crossover',
                key: 'crossover',
                displayName: 'Crossover',
              },
              {
                type: 'playoffs',
                key: 'playoffs',
                displayName: 'Playoffs',
              },
            ],
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/crossover/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/standings?phase=phase1')) {
        return { ok: true, json: async () => ({ pools: [], overall: [] }) };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/standings?phase=cumulative')) {
        return { ok: true, json: async () => ({ pools: [], overall: [] }) };
      }

      throw new Error(`Unhandled fetch URL: ${requestUrl}`);
    });

    render(<TournamentPoolPlayAdmin />);

    expect(await screen.findByRole('heading', { name: 'Pool Play Setup' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pool Play' })).toHaveAttribute(
      'href',
      '/tournaments/tour-1/pool-play'
    );
    expect(screen.queryByRole('link', { name: 'Pool Play 2' })).not.toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: 'Initialize Pools from Format Template' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Distribute Teams by Ranking Order' })
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some(([url]) =>
          String(url).includes('/api/tournaments/tour-1/stages/poolPlay1/pools')
        )
      ).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    const tournamentFetchCount = globalThis.fetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/tournaments/tour-1')
    ).length;
    expect(tournamentFetchCount).toBeLessThanOrEqual(2);

    expect(
      globalThis.fetch.mock.calls.some(([url]) =>
        String(url).includes('/api/tournaments/tour-1/phase1/pools')
      )
    ).toBe(false);
  });
});
