const DEFAULT_15_TEAM_FORMAT_ID = 'odu_15_5courts_v1';

const buildSeedRange = (start, end) =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);

const FORMAT_DEFINITIONS = Object.freeze([
  {
    id: 'classic_12_3x4_gold8_silver4_v1',
    name: '12 Teams: 3x4 Pools, Gold 8 + Silver 4',
    description:
      'Three pools of four in Pool Play 1, then Gold 8-team and Silver 4-team single elimination brackets.',
    supportedTeamCounts: [12],
    minCourts: 3,
    stages: [
      {
        type: 'poolPlay',
        key: 'poolPlay1',
        displayName: 'Pool Play 1',
        pools: [
          { name: 'A', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'B', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'C', size: 4, preferredCourtGroup: 'ANY' },
        ],
        roundRobin: true,
        refs: { policy: 'offTeamSamePool' },
      },
      {
        type: 'playoffs',
        key: 'playoffs',
        displayName: 'Playoffs',
        brackets: [
          {
            name: 'Gold',
            size: 8,
            seedsFromOverall: buildSeedRange(1, 8),
            type: 'singleElim',
          },
          {
            name: 'Silver',
            size: 4,
            seedsFromOverall: buildSeedRange(9, 12),
            type: 'singleElim',
          },
        ],
      },
    ],
  },
  {
    id: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
    name: '14 Teams: Mixed Pools + Crossover, Gold 8 + Silver 6',
    description:
      'Two 4-team pools and two 3-team pools, rank-to-rank crossover for 3-team pools, then Gold 8 and Silver 6 playoffs.',
    supportedTeamCounts: [14],
    minCourts: 3,
    stages: [
      {
        type: 'poolPlay',
        key: 'poolPlay1',
        displayName: 'Pool Play 1',
        pools: [
          { name: 'A', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'B', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'C', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'D', size: 3, preferredCourtGroup: 'ANY' },
        ],
        roundRobin: true,
        refs: { policy: 'offTeamSamePool' },
      },
      {
        type: 'crossover',
        key: 'crossover',
        displayName: 'Crossover',
        fromPools: ['C', 'D'],
        pairings: 'rankToRank',
        refs: { policy: 'tbd' },
      },
      {
        type: 'playoffs',
        key: 'playoffs',
        displayName: 'Playoffs',
        brackets: [
          {
            name: 'Gold',
            size: 8,
            seedsFromOverall: buildSeedRange(1, 8),
            type: 'singleElim',
          },
          {
            name: 'Silver',
            size: 6,
            seedsFromOverall: buildSeedRange(9, 14),
            type: 'singleElimWithByes',
          },
        ],
      },
    ],
  },
  {
    id: DEFAULT_15_TEAM_FORMAT_ID,
    name: 'ODU 15-Team Classic',
    description:
      'Legacy ODU flow: Pool Play 1 (A-E), Pool Play 2 (F-J) with rematch balancing, then Gold/Silver/Bronze 5-team ops brackets.',
    supportedTeamCounts: [15],
    minCourts: 3,
    stages: [
      {
        type: 'poolPlay',
        key: 'poolPlay1',
        displayName: 'Pool Play 1',
        pools: [
          { name: 'A', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'B', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'C', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'D', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'E', size: 3, preferredCourtGroup: 'ANY' },
        ],
        roundRobin: true,
        refs: { policy: 'offTeamSamePool' },
      },
      {
        type: 'poolPlay',
        key: 'poolPlay2',
        displayName: 'Pool Play 2',
        pools: [
          { name: 'F', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'G', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'H', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'I', size: 3, preferredCourtGroup: 'ANY' },
          { name: 'J', size: 3, preferredCourtGroup: 'ANY' },
        ],
        roundRobin: true,
        refs: { policy: 'offTeamSamePool' },
      },
      {
        type: 'playoffs',
        key: 'playoffs',
        displayName: 'Playoffs',
        brackets: [
          {
            name: 'Gold',
            size: 5,
            seedsFromOverall: buildSeedRange(1, 5),
            type: 'oduFiveTeamOps',
          },
          {
            name: 'Silver',
            size: 5,
            seedsFromOverall: buildSeedRange(6, 10),
            type: 'oduFiveTeamOps',
          },
          {
            name: 'Bronze',
            size: 5,
            seedsFromOverall: buildSeedRange(11, 15),
            type: 'oduFiveTeamOps',
          },
        ],
      },
    ],
  },
  {
    id: 'classic_16_4x4_all16_v1',
    name: '16 Teams: 4x4 Pools + 16-Team Playoffs',
    description:
      'Four pools of four in Pool Play 1, then all teams advance to a 16-team single elimination bracket.',
    supportedTeamCounts: [16],
    minCourts: 3,
    stages: [
      {
        type: 'poolPlay',
        key: 'poolPlay1',
        displayName: 'Pool Play 1',
        pools: [
          { name: 'A', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'B', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'C', size: 4, preferredCourtGroup: 'ANY' },
          { name: 'D', size: 4, preferredCourtGroup: 'ANY' },
        ],
        roundRobin: true,
        refs: { policy: 'offTeamSamePool' },
      },
      {
        type: 'playoffs',
        key: 'playoffs',
        displayName: 'Playoffs',
        brackets: [
          {
            name: 'All',
            size: 16,
            seedsFromOverall: buildSeedRange(1, 16),
            type: 'singleElim',
          },
        ],
      },
    ],
  },
]);

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function listFormats() {
  return FORMAT_DEFINITIONS.map((formatDef) => clone(formatDef));
}

function getFormat(formatId) {
  if (typeof formatId !== 'string' || !formatId.trim()) {
    return null;
  }

  const normalizedId = formatId.trim();
  const formatDef = FORMAT_DEFINITIONS.find((entry) => entry.id === normalizedId);
  return formatDef ? clone(formatDef) : null;
}

function suggestFormats(teamCount, courtCount) {
  const normalizedTeamCount = toPositiveInteger(teamCount);
  const normalizedCourtCount = toPositiveInteger(courtCount);

  if (!normalizedTeamCount || !normalizedCourtCount) {
    return [];
  }

  return FORMAT_DEFINITIONS.filter((formatDef) => {
    if (!Array.isArray(formatDef.supportedTeamCounts)) {
      return false;
    }

    if (!formatDef.supportedTeamCounts.includes(normalizedTeamCount)) {
      return false;
    }

    if (
      Number.isFinite(Number(formatDef.minCourts)) &&
      normalizedCourtCount < Number(formatDef.minCourts)
    ) {
      return false;
    }

    if (
      Number.isFinite(Number(formatDef.maxCourts)) &&
      normalizedCourtCount > Number(formatDef.maxCourts)
    ) {
      return false;
    }

    return true;
  }).map((formatDef) => clone(formatDef));
}

module.exports = {
  DEFAULT_15_TEAM_FORMAT_ID,
  getFormat,
  listFormats,
  suggestFormats,
};
