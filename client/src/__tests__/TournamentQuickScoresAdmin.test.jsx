import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TournamentQuickScoresAdmin from '../pages/TournamentQuickScoresAdmin.jsx';

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
}));

function renderQuickScoresPage() {
  return render(<TournamentQuickScoresAdmin />);
}

function buildQuickPayload(matches) {
  return {
    phase: 'phase1',
    filters: {
      roundBlocks: [{ value: 1, timeLabel: '9:00 AM' }],
      courts: [{ code: 'SRC-2', label: 'SRC Court 2', facility: 'SRC' }],
    },
    matches,
  };
}

describe('TournamentQuickScoresAdmin', () => {
  beforeEach(() => {
    mockAuthState = {
      token: 'test-token',
      user: { id: 'user-1', email: 'owner@example.com' },
      initializing: false,
    };

    globalThis.fetch = vi.fn();
  });

  it('submits normalized setScores payload on Save', async () => {
    const capturedBodies = [];
    const quickMatch = {
      matchId: 'match-1',
      phase: 'phase1',
      roundBlock: 1,
      timeLabel: '9:00 AM',
      facility: 'SRC',
      court: 'SRC-2',
      courtLabel: 'SRC Court 2',
      teamA: { teamId: 'team-a', shortName: 'ALP' },
      teamB: { teamId: 'team-b', shortName: 'BRV' },
      status: 'scheduled',
      finalizedAt: null,
      scoreSummary: { setsA: 0, setsB: 0, pointsA: 0, pointsB: 0 },
    };

    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      const asString = String(url);

      if (asString.includes('/api/tournaments/tour-1') && !asString.includes('/matches/quick')) {
        return {
          ok: true,
          json: async () => ({ _id: 'tour-1', name: 'Test Tournament', publicCode: 'ABC123' }),
        };
      }

      if (asString.includes('/api/admin/tournaments/tour-1/matches/quick')) {
        return {
          ok: true,
          json: async () => buildQuickPayload([quickMatch]),
        };
      }

      if (asString.includes('/api/admin/matches/match-1/score')) {
        capturedBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            match: { _id: 'match-1', status: 'scheduled' },
            scoreboard: { scoreboardId: 'score-1' },
          }),
        };
      }

      throw new Error(`Unhandled fetch URL: ${asString}`);
    });

    renderQuickScoresPage();

    await screen.findByText('Quick Enter Scores');

    const user = userEvent.setup();

    const input = await screen.findByPlaceholderText('25-18, 22-25, 15-11');
    await user.type(input, '25-18,22-25,15-11');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(capturedBodies).toHaveLength(1);
    });

    expect(capturedBodies[0]).toEqual({
      setScores: [
        { a: 25, b: 18 },
        { a: 22, b: 25 },
        { a: 15, b: 11 },
      ],
      applyToScoreboard: true,
      finalize: false,
    });
  });

  it('shows Unfinalize and disables score input for final matches', async () => {
    const quickMatch = {
      matchId: 'match-final',
      phase: 'phase1',
      roundBlock: 1,
      timeLabel: '9:00 AM',
      facility: 'SRC',
      court: 'SRC-2',
      courtLabel: 'SRC Court 2',
      teamA: { teamId: 'team-a', shortName: 'ALP' },
      teamB: { teamId: 'team-b', shortName: 'BRV' },
      status: 'final',
      finalizedAt: '2026-10-01T12:00:00.000Z',
      scoreSummary: { setsA: 2, setsB: 1, pointsA: 62, pointsB: 54 },
      setScores: [
        { a: 25, b: 18 },
        { a: 22, b: 25 },
        { a: 15, b: 11 },
      ],
    };

    globalThis.fetch.mockImplementation(async (url) => {
      const asString = String(url);

      if (asString.includes('/api/tournaments/tour-1') && !asString.includes('/matches/quick')) {
        return {
          ok: true,
          json: async () => ({ _id: 'tour-1', name: 'Test Tournament', publicCode: 'ABC123' }),
        };
      }

      if (asString.includes('/api/admin/tournaments/tour-1/matches/quick')) {
        return {
          ok: true,
          json: async () => buildQuickPayload([quickMatch]),
        };
      }

      throw new Error(`Unhandled fetch URL: ${asString}`);
    });

    renderQuickScoresPage();

    await screen.findByText('Quick Enter Scores');

    const input = await screen.findByDisplayValue('25-18, 22-25, 15-11');
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unfinalize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save + Finalize' })).toBeDisabled();
  });
});
