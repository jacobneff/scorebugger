import { buildFormatPreview } from '../utils/formatPreview.js';

const classic14FormatDef = {
  id: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
  name: '14 Teams: Mixed Pools + Crossover, Gold 8 + Silver 6',
  stages: [
    {
      type: 'poolPlay',
      key: 'poolPlay1',
      displayName: 'Pool Play',
      pools: [
        { name: 'A', size: 4 },
        { name: 'B', size: 4 },
        { name: 'C', size: 3 },
        { name: 'D', size: 3 },
      ],
    },
    {
      type: 'crossover',
      key: 'crossover',
      displayName: 'Crossover',
      fromPools: ['C', 'D'],
      pairings: 'rankToRank',
    },
    {
      type: 'playoffs',
      key: 'playoffs',
      displayName: 'Playoffs',
      brackets: [],
    },
  ],
};

const classic14WithPlayoffsFormatDef = {
  id: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
  name: '14 Teams: Mixed Pools + Crossover, Gold 8 + Silver 6',
  stages: [
    {
      type: 'poolPlay',
      key: 'poolPlay1',
      displayName: 'Pool Play',
      pools: [
        { name: 'A', size: 4 },
        { name: 'B', size: 4 },
        { name: 'C', size: 3 },
        { name: 'D', size: 3 },
      ],
    },
    {
      type: 'crossover',
      key: 'crossover',
      displayName: 'Crossover',
      fromPools: ['C', 'D'],
      pairings: 'rankToRank',
    },
    {
      type: 'playoffs',
      key: 'playoffs',
      displayName: 'Playoffs',
      maxConcurrentCourts: 4,
      brackets: [
        {
          name: 'Gold',
          size: 8,
          type: 'singleElim',
        },
        {
          name: 'Silver',
          size: 6,
          type: 'singleElimWithByes',
        },
      ],
    },
  ],
};

describe('buildFormatPreview', () => {
  test('uses pool-rank crossover labels and non-conflicting refs for 14-team format', () => {
    const preview = buildFormatPreview({
      formatDef: classic14FormatDef,
      totalCourts: 4,
    });

    const crossoverRows = preview.poolScheduleRows.filter((row) => row.stageLabel === 'Crossover');
    expect(crossoverRows).toHaveLength(3);

    expect(crossoverRows[0].matchLabel).toBe('C (#1) vs D (#1)');
    expect(crossoverRows[0].refLabel).toBe('C (#3)');
    expect(crossoverRows[0].byeLabel).toBeNull();

    expect(crossoverRows[1].matchLabel).toBe('C (#2) vs D (#2)');
    expect(crossoverRows[1].refLabel).toBe('D (#3)');
    expect(crossoverRows[1].byeLabel).toBeNull();

    expect(crossoverRows[2].matchLabel).toBe('C (#3) vs D (#3)');
    expect(crossoverRows[2].refLabel).toBe('D (#2)');
    expect(crossoverRows[2].byeLabel).toBe('C (#1), D (#1), C (#2)');
  });

  test('playoff preview uses winner references and enforces max concurrent playoff courts', () => {
    const preview = buildFormatPreview({
      formatDef: classic14WithPlayoffsFormatDef,
      totalCourts: 5,
    });

    const playoffRows = preview.playoffRows;
    expect(playoffRows.length).toBeGreaterThan(0);
    expect(playoffRows.every((row) => !row.matchupLabel.includes(' 0'))).toBe(true);

    const goldSemis = playoffRows.filter(
      (row) => row.bracketLabel === 'Gold' && row.roundLabel === 'R2'
    );
    expect(goldSemis.map((row) => row.matchupLabel)).toEqual([
      'W(Gold 1v8) vs W(Gold 4v5)',
      'W(Gold 3v6) vs W(Gold 2v7)',
    ]);

    const goldFinal = playoffRows.find(
      (row) => row.bracketLabel === 'Gold' && row.roundLabel === 'R3'
    );
    expect(goldFinal?.matchupLabel).toBe('W(Gold R2 M1) vs W(Gold R2 M2)');

    const silverSemis = playoffRows.filter(
      (row) => row.bracketLabel === 'Silver' && row.roundLabel === 'R2'
    );
    expect(silverSemis.map((row) => row.matchupLabel)).toEqual([
      'Silver 1 vs W(Silver 4v5)',
      'Silver 2 vs W(Silver 3v6)',
    ]);

    const silverFinal = playoffRows.find(
      (row) => row.bracketLabel === 'Silver' && row.roundLabel === 'R3'
    );
    expect(silverFinal?.matchupLabel).toBe('W(Silver R2 M1) vs W(Silver R2 M2)');

    const matchesPerRoundBlock = playoffRows.reduce((lookup, row) => {
      const key = Number(row.roundBlock);
      lookup[key] = (lookup[key] || 0) + 1;
      return lookup;
    }, {});
    const maxConcurrentMatches = Object.values(matchesPerRoundBlock).reduce(
      (maxValue, count) => Math.max(maxValue, Number(count) || 0),
      0
    );
    expect(maxConcurrentMatches).toBeLessThanOrEqual(4);
  });
});
