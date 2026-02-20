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
                totalCourts: 5,
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
                totalCourts: 4,
                activeCourts: ['SRC-1', 'SRC-2', 'SRC-3'],
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/venue')) {
        return {
          ok: true,
          json: async () => ({
            totalCourts: 4,
            venue: {
              facilities: [
                {
                  facilityId: 'facility-main',
                  name: 'Main Facility',
                  courts: [
                    { courtId: 'court-1', name: 'Court 1', isEnabled: true },
                    { courtId: 'court-2', name: 'Court 2', isEnabled: true },
                    { courtId: 'court-3', name: 'Court 3', isEnabled: true },
                    { courtId: 'court-4', name: 'Court 4', isEnabled: true },
                  ],
                },
              ],
            },
          }),
        };
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
                fromPools: ['C', 'D'],
                pairings: 'rankToRank',
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

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools/init')) {
        return {
          ok: true,
          json: async () => ([
            { _id: 'pool-a', name: 'A', requiredTeamCount: 4, teamIds: [] },
            { _id: 'pool-b', name: 'B', requiredTeamCount: 4, teamIds: [] },
            { _id: 'pool-c', name: 'C', requiredTeamCount: 3, teamIds: [] },
            { _id: 'pool-d', name: 'D', requiredTeamCount: 3, teamIds: [] },
          ]),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/crossover/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.includes('/api/tournaments/tour-1/schedule-plan')) {
        return { ok: true, json: async () => ({ slots: [] }) };
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
    expect(screen.getByRole('link', { name: 'Pool Play Setup' })).toHaveAttribute(
      'href',
      '/tournaments/tour-1/pool-play'
    );
    expect(screen.queryByRole('link', { name: 'Pool Play 2' })).not.toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: 'Initialize Pools from Format Template' })
    ).not.toBeInTheDocument();
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
    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some(([url]) =>
          String(url).includes('/api/tournaments/tour-1/stages/poolPlay1/pools/init')
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
    expect(
      screen.queryByText(/Crossover slots are placeholders by pool rank/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText(/No matches generated yet\./i)).toBeInTheDocument();
  });

  it('renders crossover placeholders only after pool-play matches exist and does not overwrite pool-play slots', async () => {
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
                totalCourts: 4,
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/venue')) {
        return {
          ok: true,
          json: async () => ({
            totalCourts: 4,
            venue: {
              facilities: [
                {
                  facilityId: 'facility-main',
                  name: 'Main Facility',
                  courts: [
                    { courtId: 'court-1', name: 'Court 1', isEnabled: true },
                    { courtId: 'court-2', name: 'Court 2', isEnabled: true },
                    { courtId: 'court-3', name: 'Court 3', isEnabled: true },
                    { courtId: 'court-4', name: 'Court 4', isEnabled: true },
                  ],
                },
              ],
            },
          }),
        };
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
                fromPools: ['C', 'D'],
                pairings: 'rankToRank',
              },
            ],
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools')) {
        return {
          ok: true,
          json: async () => ([
            { _id: 'pool-a', name: 'A', requiredTeamCount: 4, teamIds: [], assignedCourtId: 'court-1', homeCourt: 'Court 1' },
            { _id: 'pool-b', name: 'B', requiredTeamCount: 4, teamIds: [], assignedCourtId: 'court-2', homeCourt: 'Court 2' },
            { _id: 'pool-c', name: 'C', requiredTeamCount: 3, teamIds: [], assignedCourtId: 'court-3', homeCourt: 'Court 3' },
            { _id: 'pool-d', name: 'D', requiredTeamCount: 3, teamIds: [], assignedCourtId: 'court-4', homeCourt: 'Court 4' },
          ]),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools/init')) {
        return {
          ok: true,
          json: async () => ([
            { _id: 'pool-a', name: 'A', requiredTeamCount: 4, teamIds: [], assignedCourtId: 'court-1', homeCourt: 'Court 1' },
            { _id: 'pool-b', name: 'B', requiredTeamCount: 4, teamIds: [], assignedCourtId: 'court-2', homeCourt: 'Court 2' },
            { _id: 'pool-c', name: 'C', requiredTeamCount: 3, teamIds: [], assignedCourtId: 'court-3', homeCourt: 'Court 3' },
            { _id: 'pool-d', name: 'D', requiredTeamCount: 3, teamIds: [], assignedCourtId: 'court-4', homeCourt: 'Court 4' },
          ]),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/matches')) {
        return {
          ok: true,
          json: async () => ([
            {
              _id: 'pool-a-round4',
              stageKey: 'poolPlay1',
              roundBlock: 4,
              courtId: 'court-1',
              court: 'Court 1',
              poolName: 'A',
              teamA: { shortName: 'A1', name: 'A1' },
              teamB: { shortName: 'A2', name: 'A2' },
              refTeams: [{ shortName: 'A3', name: 'A3' }],
              status: 'scheduled',
            },
            {
              _id: 'pool-c-round3',
              stageKey: 'poolPlay1',
              roundBlock: 3,
              courtId: 'court-3',
              court: 'Court 3',
              poolName: 'C',
              teamA: { shortName: 'C1', name: 'C1' },
              teamB: { shortName: 'C2', name: 'C2' },
              refTeams: [{ shortName: 'C3', name: 'C3' }],
              status: 'scheduled',
            },
            {
              _id: 'pool-d-round3',
              stageKey: 'poolPlay1',
              roundBlock: 3,
              courtId: 'court-4',
              court: 'Court 4',
              poolName: 'D',
              teamA: { shortName: 'D1', name: 'D1' },
              teamB: { shortName: 'D2', name: 'D2' },
              refTeams: [{ shortName: 'D3', name: 'D3' }],
              status: 'scheduled',
            },
          ]),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/crossover/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.includes('/api/tournaments/tour-1/schedule-plan')) {
        return {
          ok: true,
          json: async () => ({
            slots: [
              {
                slotId: 'pool-a-round4',
                kind: 'match',
                stageKey: 'poolPlay1',
                stageLabel: 'Pool Play',
                roundBlock: 4,
                courtCode: 'court-1',
                poolName: 'A',
                matchupLabel: 'A1 vs A2',
                refLabel: 'A3',
                status: 'scheduled',
              },
              {
                slotId: 'cross-cd-1',
                kind: 'match',
                stageKey: 'crossover',
                stageLabel: 'Crossover',
                roundBlock: 4,
                courtCode: 'court-3',
                matchupLabel: 'C (#1) vs D (#1)',
                refLabel: 'C (#3)',
                status: 'scheduled_tbd',
              },
            ],
          }),
        };
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
    expect(
      screen.getByText(/Crossover slots are placeholders by pool rank/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/C \(#1\) vs D \(#1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/A1 vs A2/i)).toBeInTheDocument();
  });

  it('renders status, set summary, and links for match-backed schedule slots only', async () => {
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
                totalCourts: 4,
                activeCourts: ['court-1', 'court-2', 'court-3', 'court-4'],
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/venue')) {
        return {
          ok: true,
          json: async () => ({
            totalCourts: 4,
            venue: {
              facilities: [
                {
                  facilityId: 'facility-main',
                  name: 'Main Facility',
                  courts: [
                    { courtId: 'court-1', name: 'Court 1', isEnabled: true },
                    { courtId: 'court-2', name: 'Court 2', isEnabled: true },
                    { courtId: 'court-3', name: 'Court 3', isEnabled: true },
                    { courtId: 'court-4', name: 'Court 4', isEnabled: true },
                  ],
                },
              ],
            },
          }),
        };
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
                fromPools: ['C', 'D'],
                pairings: 'rankToRank',
              },
            ],
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools/init')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/crossover/matches')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.includes('/api/tournaments/tour-1/schedule-plan')) {
        return {
          ok: true,
          json: async () => ({
            slots: [
              {
                slotId: 'pool-a-r1',
                kind: 'match',
                stageKey: 'poolPlay1',
                stageLabel: 'Pool Play',
                roundBlock: 1,
                courtCode: 'court-1',
                poolName: 'A',
                matchupLabel: 'A1 vs A2',
                refLabel: 'A3',
                status: 'live',
                matchId: 'match-1',
                scoreboardCode: 'LIVE123',
                setSummary: {
                  setsA: 2,
                  setsB: 1,
                  setScores: [
                    { setNo: 1, a: 25, b: 18 },
                    { setNo: 2, a: 22, b: 25 },
                    { setNo: 3, a: 15, b: 11 },
                  ],
                },
              },
              {
                slotId: 'cross-cd-1',
                kind: 'match',
                stageKey: 'crossover',
                stageLabel: 'Crossover',
                roundBlock: 2,
                courtCode: 'court-2',
                matchupLabel: 'C (#1) vs D (#1)',
                refLabel: 'C (#3)',
                status: 'scheduled_tbd',
              },
            ],
          }),
        };
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
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('Sets 2-1 • 25-18, 22-25, 15-11')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Match Control' })).toHaveAttribute(
      'href',
      '/tournaments/matches/match-1/control/LIVE123?status=live'
    );
    expect(screen.getByRole('link', { name: 'Live Score' })).toHaveAttribute(
      'href',
      '/board/LIVE123/display'
    );
    expect(screen.getByText(/C \(#1\) vs D \(#1\)/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Match Control' })).toHaveLength(1);
  });

  it('deduplicates schedule courts when matches mix courtId and legacy court name', async () => {
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
                totalCourts: 4,
              },
            },
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/teams')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/venue')) {
        return {
          ok: true,
          json: async () => ({
            totalCourts: 4,
            venue: {
              facilities: [
                {
                  facilityId: 'facility-main',
                  name: 'Main Facility',
                  courts: [
                    { courtId: 'court-1', name: 'Court 1', isEnabled: true },
                    { courtId: 'court-2', name: 'Court 2', isEnabled: true },
                    { courtId: 'court-3', name: 'Court 3', isEnabled: true },
                    { courtId: 'court-4', name: 'Court 4', isEnabled: true },
                  ],
                },
              ],
            },
          }),
        };
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
                fromPools: ['C', 'D'],
                pairings: 'rankToRank',
              },
            ],
          }),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/pools/init')) {
        return { ok: true, json: async () => [] };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/poolPlay1/matches')) {
        return {
          ok: true,
          json: async () => ([
            {
              _id: 'pool-match-1',
              stageKey: 'poolPlay1',
              roundBlock: 1,
              courtId: 'court-1',
              court: 'Court 1',
              poolName: 'A',
              teamA: { shortName: 'A1', name: 'A1' },
              teamB: { shortName: 'A2', name: 'A2' },
              refTeams: [{ shortName: 'A3', name: 'A3' }],
              status: 'scheduled',
            },
          ]),
        };
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1/stages/crossover/matches')) {
        return {
          ok: true,
          json: async () => ([
            {
              _id: 'crossover-match-1',
              stageKey: 'crossover',
              roundBlock: 2,
              court: 'Court 1',
              poolName: null,
              teamA: { shortName: 'C (#1)', name: 'C (#1)' },
              teamB: { shortName: 'D (#1)', name: 'D (#1)' },
              refTeams: [{ shortName: 'C (#3)', name: 'C (#3)' }],
              status: 'scheduled',
            },
          ]),
        };
      }

      if (requestUrl.includes('/api/tournaments/tour-1/schedule-plan')) {
        return {
          ok: true,
          json: async () => ({
            slots: [
              {
                slotId: 'pool-1',
                kind: 'match',
                stageKey: 'poolPlay1',
                stageLabel: 'Pool Play',
                roundBlock: 1,
                courtCode: 'court-1',
                poolName: 'A',
                matchupLabel: 'A1 vs A2',
                refLabel: 'A3',
                status: 'scheduled',
              },
              {
                slotId: 'cross-1',
                kind: 'match',
                stageKey: 'crossover',
                stageLabel: 'Crossover',
                roundBlock: 2,
                courtCode: 'court-1',
                matchupLabel: 'C (#1) vs D (#1)',
                refLabel: 'C (#3)',
                status: 'scheduled',
              },
            ],
          }),
        };
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
    await waitFor(() => {
      expect(screen.getAllByRole('columnheader', { name: /Court 1/i })).toHaveLength(1);
    });
  });
});
