const {
  cacheTournamentMatches,
  getCachedTournamentMatchEntry,
  resetTournamentRealtimeState,
} = require('../services/tournamentRealtime');

describe('tournament realtime cache', () => {
  beforeEach(() => {
    resetTournamentRealtimeState();
  });

  test('generating matches primes scoreboard cache entries', () => {
    cacheTournamentMatches(
      [
        { _id: 'match-1', scoreboardId: 'board-1' },
        { _id: 'match-2', scoreboardId: 'board-2' },
      ],
      'AB12CD'
    );

    expect(getCachedTournamentMatchEntry('board-1')).toEqual({
      tournamentCode: 'AB12CD',
      matchId: 'match-1',
    });
    expect(getCachedTournamentMatchEntry('board-2')).toEqual({
      tournamentCode: 'AB12CD',
      matchId: 'match-2',
    });
  });
});
