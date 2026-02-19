const {
  generateRoundRobinMatches,
  scheduleStageMatches,
} = require('../tournamentEngine/formatEngine');

describe('formatEngine round robin + scheduling', () => {
  test('pool size 3 round robin keeps legacy order and off-team refs', () => {
    const teams = [
      { _id: 'team-1', orderIndex: 1 },
      { _id: 'team-2', orderIndex: 2 },
      { _id: 'team-3', orderIndex: 3 },
    ];

    const matches = generateRoundRobinMatches(teams, 3);

    expect(matches).toHaveLength(3);
    expect(matches.map((match) => [match.teamAId, match.teamBId])).toEqual([
      ['team-1', 'team-2'],
      ['team-2', 'team-3'],
      ['team-1', 'team-3'],
    ]);
    expect(matches.map((match) => match.refTeamIds)).toEqual([
      ['team-3'],
      ['team-1'],
      ['team-2'],
    ]);
  });

  test('pool size 4 round robin is deterministic and refs are selected from off teams', () => {
    const teams = [
      { _id: 'team-1', orderIndex: 1 },
      { _id: 'team-2', orderIndex: 2 },
      { _id: 'team-3', orderIndex: 3 },
      { _id: 'team-4', orderIndex: 4 },
    ];

    const firstPass = generateRoundRobinMatches(teams, 4);
    const secondPass = generateRoundRobinMatches(teams, 4);

    expect(firstPass).toHaveLength(6);
    expect(firstPass).toEqual(secondPass);

    firstPass.forEach((match) => {
      expect(Array.isArray(match.refTeamIds)).toBe(true);
      expect(match.refTeamIds).toHaveLength(1);
      expect(match.offTeamIds).toContain(match.refTeamIds[0]);
      expect([match.teamAId, match.teamBId]).not.toContain(match.refTeamIds[0]);
    });
  });

  test('scheduling with fewer courts than pools is deterministic and non-overlapping per court', () => {
    const matchesByPool = [
      {
        poolId: 'pool-a',
        poolName: 'A',
        homeCourt: 'SRC-1',
        matches: [{ matchKey: 'A1' }, { matchKey: 'A2' }, { matchKey: 'A3' }],
      },
      {
        poolId: 'pool-b',
        poolName: 'B',
        homeCourt: 'SRC-2',
        matches: [{ matchKey: 'B1' }, { matchKey: 'B2' }, { matchKey: 'B3' }],
      },
      {
        poolId: 'pool-c',
        poolName: 'C',
        homeCourt: 'SRC-1',
        matches: [{ matchKey: 'C1' }, { matchKey: 'C2' }, { matchKey: 'C3' }],
      },
      {
        poolId: 'pool-d',
        poolName: 'D',
        homeCourt: 'SRC-2',
        matches: [{ matchKey: 'D1' }, { matchKey: 'D2' }, { matchKey: 'D3' }],
      },
    ];

    const firstSchedule = scheduleStageMatches(matchesByPool, ['SRC-1', 'SRC-2'], 1);
    const secondSchedule = scheduleStageMatches(matchesByPool, ['SRC-1', 'SRC-2'], 1);

    expect(firstSchedule).toEqual(secondSchedule);
    expect(firstSchedule).toHaveLength(12);

    const roundsByCourt = firstSchedule.reduce((lookup, match) => {
      const court = String(match.court);
      if (!lookup[court]) {
        lookup[court] = [];
      }
      lookup[court].push(Number(match.roundBlock));
      return lookup;
    }, {});

    Object.values(roundsByCourt).forEach((roundBlocks) => {
      const sorted = [...roundBlocks].sort((left, right) => left - right);
      expect(sorted).toEqual(roundBlocks);
      expect(new Set(roundBlocks).size).toBe(roundBlocks.length);
    });
  });
});
