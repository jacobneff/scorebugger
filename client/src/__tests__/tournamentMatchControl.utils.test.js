import {
  MATCH_STATUS,
  buildTournamentMatchControlHref,
  getMatchStatusMeta,
  normalizeMatchStatus,
} from '../utils/tournamentMatchControl.js';

describe('normalizeMatchStatus', () => {
  it('normalizes known statuses', () => {
    expect(normalizeMatchStatus('LIVE')).toBe(MATCH_STATUS.LIVE);
    expect(normalizeMatchStatus('ENDED')).toBe(MATCH_STATUS.ENDED);
    expect(normalizeMatchStatus(' final ')).toBe(MATCH_STATUS.FINAL);
    expect(normalizeMatchStatus('scheduled')).toBe(MATCH_STATUS.SCHEDULED);
  });

  it('falls back to scheduled for unknown values', () => {
    expect(normalizeMatchStatus('')).toBe(MATCH_STATUS.SCHEDULED);
    expect(normalizeMatchStatus('done')).toBe(MATCH_STATUS.SCHEDULED);
    expect(normalizeMatchStatus(null)).toBe(MATCH_STATUS.SCHEDULED);
  });
});

describe('getMatchStatusMeta', () => {
  it('returns live status metadata', () => {
    expect(getMatchStatusMeta('live')).toEqual({
      value: MATCH_STATUS.LIVE,
      label: 'Live',
      badgeClassName: 'phase1-status-badge--live',
    });
  });

  it('returns finalized metadata for final', () => {
    expect(getMatchStatusMeta('final')).toEqual({
      value: MATCH_STATUS.FINAL,
      label: 'Finalized',
      badgeClassName: 'phase1-status-badge--final',
    });
  });

  it('returns ended metadata for ended', () => {
    expect(getMatchStatusMeta('ended')).toEqual({
      value: MATCH_STATUS.ENDED,
      label: 'Ended',
      badgeClassName: 'phase1-status-badge--ended',
    });
  });
});

describe('buildTournamentMatchControlHref', () => {
  it('builds dedicated tournament control route with lifecycle query params', () => {
    expect(
      buildTournamentMatchControlHref({
        matchId: 'match-123',
        scoreboardKey: 'abc123',
        status: 'live',
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: null,
      })
    ).toBe(
      '/tournaments/matches/match-123/control/abc123?status=live&startedAt=2026-01-01T10%3A00%3A00.000Z'
    );
  });

  it('returns empty string when required ids are missing', () => {
    expect(
      buildTournamentMatchControlHref({
        matchId: '',
        scoreboardKey: 'abc123',
        status: 'scheduled',
      })
    ).toBe('');

    expect(
      buildTournamentMatchControlHref({
        matchId: 'match-123',
        scoreboardKey: '',
        status: 'scheduled',
      })
    ).toBe('');
  });
});
