import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TournamentMatchControlView from '../components/TournamentMatchControlView.jsx';

let mockToken = 'test-token';
let mockScoreboard = null;
let mockLoading = false;
let mockError = null;
const mockUpdateScoreboard = vi.fn();
const mockClearError = vi.fn();

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    token: mockToken,
  }),
}));

vi.mock('../hooks/useScoreboard.js', () => ({
  useScoreboard: () => ({
    scoreboard: mockScoreboard,
    loading: mockLoading,
    error: mockError,
    updateScoreboard: mockUpdateScoreboard,
    clearError: mockClearError,
  }),
}));

function createScoreboard(overrides = {}) {
  return {
    _id: 'board-1',
    code: 'ABC123',
    teams: [
      { name: 'Home', score: 5 },
      { name: 'Away', score: 4 },
    ],
    sets: [],
    scoring: { setTargets: [25, 25, 15] },
    ...overrides,
  };
}

describe('TournamentMatchControlView', () => {
  beforeEach(() => {
    mockToken = 'test-token';
    mockScoreboard = createScoreboard();
    mockLoading = false;
    mockError = null;
    mockUpdateScoreboard.mockReset();
    mockClearError.mockReset();
    globalThis.fetch = vi.fn();
  });

  it('shows locked score buttons in scheduled status and allows manual score inputs', () => {
    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="scheduled"
      />
    );

    expect(screen.getByRole('button', { name: 'Increase Home score' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase Away score' })).toBeDisabled();
    expect(screen.getByLabelText('Home')).toBeEnabled();
    expect(screen.getByLabelText('Away')).toBeEnabled();
  });

  it('starts a match successfully and unlocks score buttons', async () => {
    const user = userEvent.setup();
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'live' }),
    });

    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="scheduled"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Start Match' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/matches/match-1/status'),
        expect.objectContaining({
          method: 'PATCH',
        })
      );
    });

    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Home score' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Increase Away score' })).toBeEnabled();
  });

  it('keeps scoring locked when start match fails', async () => {
    const user = userEvent.setup();
    globalThis.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Unable to set live status' }),
    });

    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="scheduled"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Start Match' }));

    expect(await screen.findByText('Unable to set live status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Home score' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase Away score' })).toBeDisabled();
  });

  it('applies manual score values for catch-up scoring', async () => {
    const user = userEvent.setup();

    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="scheduled"
      />
    );

    await user.clear(screen.getByLabelText('Home'));
    await user.type(screen.getByLabelText('Home'), '12');
    await user.clear(screen.getByLabelText('Away'));
    await user.type(screen.getByLabelText('Away'), '9');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    const updater = mockUpdateScoreboard.mock.calls.at(-1)?.[0];
    expect(typeof updater).toBe('function');

    const updatePayload = updater(createScoreboard());
    expect(updatePayload.teams[0].score).toBe(12);
    expect(updatePayload.teams[1].score).toBe(9);
  });

  it('saves current score as a completed set and resets live scores', async () => {
    const user = userEvent.setup();
    mockScoreboard = createScoreboard({
      teams: [
        { name: 'Home', score: 25 },
        { name: 'Away', score: 20 },
      ],
      sets: [{ scores: [22, 25], createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="live"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Save Set' }));

    const payload = mockUpdateScoreboard.mock.calls.at(-1)?.[0];
    expect(payload.sets).toHaveLength(2);
    expect(payload.sets[1].scores).toEqual([25, 20]);
    expect(payload.teams[0].score).toBe(0);
    expect(payload.teams[1].score).toBe(0);
  });

  it('undoes last set and restores it to current score', async () => {
    const user = userEvent.setup();
    mockScoreboard = createScoreboard({
      teams: [
        { name: 'Home', score: 3 },
        { name: 'Away', score: 2 },
      ],
      sets: [
        { scores: [25, 20], createdAt: '2026-01-01T00:00:00.000Z' },
        { scores: [21, 19], createdAt: '2026-01-01T00:10:00.000Z' },
      ],
    });

    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="live"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Undo Last Set' }));

    const payload = mockUpdateScoreboard.mock.calls.at(-1)?.[0];
    expect(payload.sets).toHaveLength(1);
    expect(payload.teams[0].score).toBe(21);
    expect(payload.teams[1].score).toBe(19);
  });

  it('does not render full control panel extras', () => {
    render(
      <TournamentMatchControlView
        matchId="match-1"
        scoreboardId="board-1"
        initialStatus="live"
      />
    );

    expect(screen.queryByText('Overlay Link')).not.toBeInTheDocument();
    expect(screen.queryByText('Control Link')).not.toBeInTheDocument();
    expect(screen.queryByText('Score Colors')).not.toBeInTheDocument();
    expect(screen.queryByText('Scoreboard Title')).not.toBeInTheDocument();
    expect(screen.queryByText('Rename team')).not.toBeInTheDocument();
  });
});
