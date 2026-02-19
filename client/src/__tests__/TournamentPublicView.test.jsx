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

function mockPublicFetch({ details, liveMatches }) {
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
      return jsonResponse(baseTournamentPayload);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/phase1/pools')) {
      return jsonResponse([]);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/matches?phase=phase1')) {
      return jsonResponse([]);
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/courts')) {
      return jsonResponse({ courts: [] });
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/standings?phase=phase1')) {
      return jsonResponse({ pools: [], overall: [] });
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/standings?phase=phase2')) {
      return jsonResponse({ pools: [], overall: [] });
    }

    if (requestUrl.endsWith('/api/tournaments/code/ABC123/standings?phase=cumulative')) {
      return jsonResponse({ pools: [], overall: [] });
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
          text: 'Concessions are open at the lobby entrance.',
          linkUrl: 'https://example.com/menu',
        },
        facilitiesInfo: 'Court 3 has a lower ceiling near the bleachers.',
        parkingInfo: 'Use lot B after 8:00 AM.',
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
    expect(screen.getByRole('heading', { name: 'Facilities / Court Notes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maps' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Food' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Parking' })).toBeInTheDocument();
    expect(screen.getByAltText('Tournament map')).toBeInTheDocument();
  });
});
