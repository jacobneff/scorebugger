import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TournamentPublicView from '../pages/TournamentPublicView.jsx';

vi.mock('../hooks/useTournamentRealtime.js', () => ({
  useTournamentRealtime: () => {},
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ publicCode: 'ABC123' }),
  useLocation: () => ({ search: '' }),
}));

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const baseTournamentPayload = {
  tournament: {
    id: 'tour-1',
    name: 'City Open',
    date: '2026-06-01T00:00:00.000Z',
    timezone: 'America/New_York',
    status: 'phase1',
    facilities: {},
    settings: {
      schedule: {
        dayStartTime: '09:00',
        matchDurationMinutes: 60,
        lunchStartTime: null,
        lunchDurationMinutes: 45,
      },
    },
    publicCode: 'ABC123',
  },
  teams: [],
};

function mockPublicFetch({
  details,
  liveMatches,
  tournamentPayload,
  matches,
  phase1Standings,
  phase2Standings,
  cumulativeStandings,
}) {
  const defaultTournamentPayload = {
    ...baseTournamentPayload,
    tournament: {
      ...baseTournamentPayload.tournament,
      settings: {
        ...baseTournamentPayload.tournament.settings,
      },
    },
  };
  const resolvedTournamentPayload = tournamentPayload || defaultTournamentPayload;
  const resolvedMatchPayload = Array.isArray(matches) ? matches : [];
  const resolvedPhase1StandingsPayload = phase1Standings || { pools: [], overall: [] };
  const resolvedPhase2StandingsPayload = phase2Standings || { pools: [], overall: [] };
  const resolvedCumulativeStandingsPayload = cumulativeStandings || { pools: [], overall: [] };

  globalThis.fetch = vi.fn(async (url) => {
    const requestUrl = String(url);

    if (requestUrl.includes('/api/tournaments/code/ABC123/details')) {
      return jsonResponse({
        tournament: {
          name: 'City Open',
          date: '2026-06-01T00:00:00.000Z',
          timezone: 'America/New_York',
          publicCode: 'ABC123',
        },
        details,
      });
    }

    if (requestUrl.includes('/api/tournaments/code/ABC123/live')) {
      return jsonResponse(liveMatches);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123')) {
      return jsonResponse(resolvedTournamentPayload);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/phase1/pools')) {
      return jsonResponse([]);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/matches?phase=phase1')) {
      return jsonResponse(resolvedMatchPayload);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/courts')) {
      return jsonResponse({ courts: [] });
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/standings?phase=phase1')) {
      return jsonResponse(resolvedPhase1StandingsPayload);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/standings?phase=phase2')) {
      return jsonResponse(resolvedPhase2StandingsPayload);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/standings?phase=cumulative')) {
      return jsonResponse(resolvedCumulativeStandingsPayload);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/playoffs')) {
      return jsonResponse({ matches: [], brackets: {}, opsSchedule: [] });
    }

    throw new Error(`Unhandled URL in test: ${requestUrl}`);
  });
}

describe('TournamentPublicView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows live empty state and hides empty details sections', async () => {
    mockPublicFetch({
      details: {
        specialNotes: '',
        foodInfo: { text: '', linkUrl: '' },
        facilitiesInfo: '',
        parkingInfo: '',
        mapImageUrls: [],
      },
      liveMatches: [],
    });

    const user = userEvent.setup();
    render(<TournamentPublicView />);

    expect(await screen.findByText('No matches are live right now.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(await screen.findByText('No details posted yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Special Notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Food' })).not.toBeInTheDocument();
  });

  it('renders live cards and details sections with markdown links', async () => {
    mockPublicFetch({
      details: {
        specialNotes: 'Review [Venue Rules](https://example.com/rules) before warm-up.',
        foodInfo: {
          text: 'Snacks at **Lobby**. See [Menu](https://example.com/menu-doc).',
          linkUrl: 'https://example.com/menu',
        },
        facilitiesInfo: 'Court 3 notes in [Court Guide](https://example.com/courts).',
        parkingInfo: '- Use lot B after 8:00 AM.\n- Overflow at lot C.',
        mapImageUrls: ['https://example.com/map-1.png'],
      },
      liveMatches: [
        {
          matchId: 'match-1',
          phase: 'phase1',
          phaseLabel: 'Pool Play 1',
          bracket: null,
          roundBlock: 1,
          timeLabel: '9:00 AM',
          facility: 'SRC',
          facilityLabel: 'SRC',
          courtCode: 'SRC-2',
          courtLabel: 'SRC Court 2',
          teamA: { teamId: 'team-a', shortName: 'ALP', logoUrl: null },
          teamB: { teamId: 'team-b', shortName: 'BRV', logoUrl: null },
          status: 'live',
          scoreSummary: { setsA: 1, setsB: 0, pointsA: 14, pointsB: 11 },
          completedSetScores: [{ setNo: 1, a: 25, b: 22 }],
          scoreboardCode: 'ZXC123',
        },
      ],
    });

    const user = userEvent.setup();
    render(<TournamentPublicView />);

    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('ALP vs BRV')).toBeInTheDocument();
    expect(screen.getByText('Sets 1-0 • 25-22')).toBeInTheDocument();
    expect(screen.queryByText(/Pts/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View match' })).toHaveAttribute(
      'href',
      '/board/ZXC123/display'
    );

    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(await screen.findByRole('heading', { name: 'Special Notes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Venue Rules' })).toHaveAttribute(
      'href',
      'https://example.com/rules'
    );
    expect(screen.getByRole('link', { name: 'Court Guide' })).toHaveAttribute(
      'href',
      'https://example.com/courts'
    );
    expect(screen.getByRole('link', { name: 'Menu' })).toHaveAttribute(
      'href',
      'https://example.com/menu-doc'
    );
    expect(screen.getByRole('heading', { name: 'Facilities / Court Notes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maps' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Food' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Parking' })).toBeInTheDocument();
    expect(screen.getByAltText('Tournament map')).toBeInTheDocument();
    expect(screen.getByText('Overflow at lot C.')).toBeInTheDocument();
  });

  it('uses single-pool-play standings tabs for 14-team format and defers crossover matchup labels', async () => {
    mockPublicFetch({
      details: {
        specialNotes: '',
        foodInfo: { text: '', linkUrl: '' },
        facilitiesInfo: '',
        parkingInfo: '',
        mapImageUrls: [],
      },
      liveMatches: [],
      tournamentPayload: {
        tournament: {
          ...baseTournamentPayload.tournament,
          settings: {
            ...baseTournamentPayload.tournament.settings,
            format: {
              formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
              activeCourts: ['SRC-1', 'SRC-2', 'SRC-3'],
            },
          },
        },
        teams: Array.from({ length: 14 }, (_, index) => ({
          id: `team-${index + 1}`,
          name: `Team ${index + 1}`,
          shortName: `T${index + 1}`,
          logoUrl: null,
          orderIndex: index + 1,
          seed: index + 1,
        })),
      },
      matches: [
        {
          _id: 'pool-a-1',
          phase: 'phase1',
          stageKey: 'poolPlay1',
          roundBlock: 1,
          court: 'SRC-1',
          poolName: 'A',
          teamA: { shortName: 'A1' },
          teamB: { shortName: 'A2' },
          refTeams: [{ shortName: 'A3' }],
          status: 'scheduled',
          result: null,
          scoreboardCode: 'POOLA1',
        },
        {
          _id: 'cross-1',
          phase: 'phase1',
          stageKey: 'crossover',
          roundBlock: 4,
          court: 'SRC-2',
          poolName: null,
          teamA: { shortName: 'C1' },
          teamB: { shortName: 'D1' },
          refTeams: [{ shortName: 'C2' }],
          status: 'scheduled',
          result: null,
          scoreboardCode: 'CROSS1',
        },
      ],
      phase1Standings: { pools: [], overall: [] },
      phase2Standings: { pools: [], overall: [] },
      cumulativeStandings: { pools: [], overall: [] },
    });

    const user = userEvent.setup();
    render(<TournamentPublicView />);

    await user.click(await screen.findByRole('button', { name: 'Pools + Standings' }));

    expect(await screen.findByRole('heading', { name: 'Pool Play + Crossover Schedule' })).toBeInTheDocument();
    expect(
      screen.getByText('Crossover matchup pending completion of pool-play standings.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pool Play' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pool Play 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cumulative' })).toBeInTheDocument();
  });
});
