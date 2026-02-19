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
  });

  it('renders set-only summary and ended status chips', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        tournament: {
          name: 'City Open',
          publicCode: 'ABC123',
          settings: { format: { formatId: 'odu_15_5courts_v1' } },
        },
        team: { teamId: 'team-a', shortName: 'ALP' },
        nextUp: null,
        matches: [
          {
            matchId: 'match-1',
            phase: 'phase1',
            phaseLabel: 'Pool Play 1',
            timeLabel: '9:00 AM',
            courtLabel: 'SRC Court 2',
            facilityLabel: 'SRC',
            status: 'ended',
            opponent: { shortName: 'BRV' },
            scoreSummary: { setsA: 1, setsB: 1, pointsA: 45, pointsB: 42 },
            completedSetScores: [
              { setNo: 1, a: 25, b: 20 },
              { setNo: 2, a: 20, b: 25 },
            ],
            refBy: [],
          },
        ],
        refs: [],
        byes: [],
      })
    );

    render(<TournamentTeamPublicView />);

    expect(await screen.findByText('ENDED')).toBeInTheDocument();
    expect(screen.getByText('Sets 1-1 • 25-20, 20-25')).toBeInTheDocument();
    expect(screen.queryByText(/Pts/)).not.toBeInTheDocument();
  });

  it('uses the next non-ended ref assignment in Next Up context', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        tournament: {
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
});
