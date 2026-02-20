import { render, screen } from '@testing-library/react';

import TournamentTeamPublicView from '../pages/TournamentTeamPublicView.jsx';

vi.mock('../hooks/useTournamentRealtime.js', () => ({
  useTournamentRealtime: () => {},
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ tournamentCode: 'ABC123', teamCode: 'TEAM0001' }),
}));

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('TournamentTeamPublicView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders unified timeline rows for PLAY/REF/BYE/LUNCH with set-only summaries', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        tournament: {
          id: 'tour-1',
          name: 'City Open',
          publicCode: 'ABC123',
          settings: { format: { formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1' } },
        },
        team: { teamId: 'team-a', shortName: 'ALP' },
        nextUp: null,
        timeline: [
          {
            timelineId: 'play-1',
            role: 'PLAY',
            roleLabel: 'PLAY',
            iconKey: 'play',
            matchId: 'match-1',
            phase: 'phase1',
            phaseLabel: 'Pool Play 1',
            timeLabel: '9:00 AM',
            courtLabel: 'SRC Court 2',
            facilityLabel: 'SRC',
            status: 'ended',
            summaryLabel: 'vs BRV',
            opponent: { shortName: 'BRV' },
            setSummary: {
              setsA: 1,
              setsB: 1,
              setScores: [
                { setNo: 1, a: 25, b: 20 },
                { setNo: 2, a: 20, b: 25 },
              ],
            },
          },
          {
            timelineId: 'ref-1',
            role: 'REF',
            roleLabel: 'REF',
            iconKey: 'ref',
            matchId: 'match-2',
            scoreboardCode: 'REF001',
            phase: 'phase1',
            phaseLabel: 'Pool Play 1',
            timeLabel: '10:00 AM',
            courtLabel: 'SRC Court 1',
            facilityLabel: 'SRC',
            status: 'scheduled',
            summaryLabel: 'ALP vs BRV',
            matchupLabel: 'ALP vs BRV',
          },
          {
            timelineId: 'bye-1',
            role: 'BYE',
            roleLabel: 'BYE',
            iconKey: 'bye',
            phase: 'phase1',
            phaseLabel: 'Pool Play 1',
            timeLabel: '11:00 AM',
            status: 'scheduled',
            summaryLabel: 'BYE (Pool C)',
          },
          {
            timelineId: 'lunch-1',
            role: 'LUNCH',
            roleLabel: 'LUNCH',
            iconKey: 'lunch',
            phaseLabel: 'Lunch',
            timeLabel: '12:00 PM',
            status: 'scheduled',
            summaryLabel: 'Lunch Break',
          },
        ],
        matches: [],
        refs: [],
        byes: [],
      })
    );

    render(<TournamentTeamPublicView />);

    expect(await screen.findByText('Timeline')).toBeInTheDocument();
    expect(screen.getAllByText('PLAY').length).toBeGreaterThan(0);
    expect(screen.getAllByText('REF').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BYE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LUNCH').length).toBeGreaterThan(0);
    expect(screen.getByText('ENDED')).toBeInTheDocument();
    expect(screen.getByText('Sets 1-1 • 25-20, 20-25')).toBeInTheDocument();
    expect(screen.queryByText(/Pts/)).not.toBeInTheDocument();
    expect(screen.getByText('Lunch Break')).toBeInTheDocument();
  });

  it('uses the next non-ended ref assignment in Next Up context', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        tournament: {
          id: 'tour-1',
          name: 'City Open',
          publicCode: 'ABC123',
          settings: { format: { formatId: 'odu_15_5courts_v1' } },
        },
        team: { teamId: 'team-a', shortName: 'ALP' },
        nextUp: {
          matchId: 'match-next',
          phase: 'phase1',
          phaseLabel: 'Pool Play 1',
          timeLabel: '10:00 AM',
          courtLabel: 'SRC Court 1',
          facilityLabel: 'SRC',
          status: 'scheduled',
          opponent: { shortName: 'CHR' },
          scoreSummary: { setsA: 0, setsB: 0 },
          completedSetScores: [],
        },
        matches: [],
        refs: [
          {
            matchId: 'ref-ended',
            timeLabel: '9:00 AM',
            courtLabel: 'SRC Court 2',
            status: 'ended',
          },
          {
            matchId: 'ref-upcoming',
            timeLabel: '11:00 AM',
            courtLabel: 'SRC Court 3',
            status: 'scheduled',
          },
        ],
        byes: [],
      })
    );

    render(<TournamentTeamPublicView />);

    expect(await screen.findByText(/Next ref: 11:00 AM/i)).toBeInTheDocument();
  });

  it('shows REF action as Match details or Open Match Control based on admin probe', async () => {
    window.localStorage.setItem(
      'scorebugger.auth',
      JSON.stringify({
        token: 'mock-token',
        user: {
          id: 'user-1',
          email: 'owner@example.com',
        },
      })
    );

    const teamPayload = {
      tournament: {
        id: 'tour-1',
        name: 'City Open',
        publicCode: 'ABC123',
        settings: { format: { formatId: 'odu_15_5courts_v1' } },
      },
      team: { teamId: 'team-a', shortName: 'ALP' },
      nextUp: null,
      timeline: [
        {
          timelineId: 'ref-1',
          role: 'REF',
          roleLabel: 'REF',
          iconKey: 'ref',
          matchId: 'match-ref-1',
          scoreboardCode: 'REF001',
          status: 'scheduled',
          timeLabel: '10:00 AM',
          courtLabel: 'SRC Court 1',
          phase: 'phase1',
          phaseLabel: 'Pool Play 1',
          summaryLabel: 'ALP vs BRV',
        },
      ],
      matches: [],
      refs: [],
      byes: [],
    };

    globalThis.fetch = vi.fn(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.includes('/api/tournaments/code/ABC123/team/TEAM0001')) {
        return jsonResponse(teamPayload);
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1')) {
        return jsonResponse({ message: 'not authorized' }, 404);
      }

      throw new Error(`Unhandled URL in test: ${requestUrl}`);
    });

    const { unmount } = render(<TournamentTeamPublicView />);

    expect(await screen.findByRole('link', { name: 'Match details' })).toHaveAttribute(
      'href',
      '/board/REF001/display'
    );

    unmount();

    globalThis.fetch = vi.fn(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.includes('/api/tournaments/code/ABC123/team/TEAM0001')) {
        return jsonResponse(teamPayload);
      }

      if (requestUrl.endsWith('/api/tournaments/tour-1')) {
        return jsonResponse({ tournamentId: 'tour-1' }, 200);
      }

      throw new Error(`Unhandled URL in test: ${requestUrl}`);
    });

    render(<TournamentTeamPublicView />);

    expect(await screen.findByRole('link', { name: 'Open Match Control' })).toHaveAttribute(
      'href',
      '/tournaments/matches/match-ref-1/control/REF001?status=scheduled'
    );
  });
});
