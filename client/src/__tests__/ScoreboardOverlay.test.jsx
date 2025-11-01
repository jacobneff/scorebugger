import { render, screen } from '@testing-library/react';
import ScoreboardOverlay, { normalizeSet, sanitizeTeam } from '../components/ScoreboardOverlay.jsx';

describe('normalizeSet', () => {
  it('returns sanitized scores from an array', () => {
    expect(normalizeSet({ scores: ['7', -12] })).toEqual([7, 0]);
  });

  it('falls back to home/away properties when scores array missing', () => {
    expect(normalizeSet({ home: '9', away: undefined })).toEqual([9, 0]);
  });
});

describe('sanitizeTeam', () => {
  it('applies defaults and clamps negative scores', () => {
    const team = sanitizeTeam(
      { name: '  Tigers  ', color: '#123123', score: -4 },
      0
    );

    expect(team).toMatchObject({
      name: 'Tigers',
      color: '#123123',
      score: 0,
    });
  });

  it('falls back to default team when missing data', () => {
    const team = sanitizeTeam({}, 1);
    expect(team).toMatchObject({
      name: 'Away',
      score: 0,
    });
  });
});

describe('ScoreboardOverlay', () => {
  it('renders nothing without a scoreboard', () => {
    const { container } = render(<ScoreboardOverlay scoreboard={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders sanitized teams, sets, and live column', () => {
    const scoreboard = {
      teams: [
        {
          name: '  bulldogs  ',
          color: '#112233',
          teamTextColor: '#ffeeaa',
          setColor: '#445566',
          scoreTextColor: '#ffffff',
          score: 13,
        },
        {
          name: '',
          score: '9',
        },
      ],
      sets: [
        { scores: ['25', '18'] },
        { home: '15', away: '10' },
        { scores: [22, 24] },
        { scores: [19, 21] },
      ],
      servingTeamIndex: 1,
    };

    render(<ScoreboardOverlay scoreboard={scoreboard} />);

    const servingIcon = screen.getByLabelText(/serving$/i);
    expect(servingIcon).toHaveAttribute('aria-label', 'Away serving');

    expect(screen.getByText('BULLDOGS')).toBeInTheDocument();
    expect(screen.getByText('AWAY')).toBeInTheDocument();

    const liveHeaders = screen.getAllByText('Set 5');
    expect(liveHeaders).toHaveLength(2);
    const liveColumn = liveHeaders[0].closest('.overlay-grid-cell');
    expect(liveColumn).not.toBeNull();
    expect(liveColumn).toHaveClass('is-live');

    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });
});
