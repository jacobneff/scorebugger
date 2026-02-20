const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const TournamentTeam = require('../models/TournamentTeam');

const PLAYOFF_BRACKETS = ['gold', 'silver', 'bronze'];

const PLAYOFF_BRACKET_LABELS = {
  gold: 'Gold',
  silver: 'Silver',
  bronze: 'Bronze',
};
const PLAYOFF_BRACKET_OVERALL_SEED_OFFSET = {
  gold: 0,
  silver: 5,
  bronze: 10,
};

const PLAYOFF_ROUND_LABELS = {
  R1: 'Round 1',
  R2: 'Round 2',
  R3: 'Final',
};

const PLAYOFF_ROUND_BLOCK_LABELS = {
  7: 'Playoff Round 1',
  8: 'Playoff Round 2',
  9: 'Playoff Round 3 (Finals)',
};

const PLAYOFF_ROUND_BLOCK_COURTS = {
  7: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'],
  8: ['VC-1', 'VC-2', 'SRC-1', 'SRC-2', 'SRC-3'],
  9: ['VC-1', 'VC-2', 'SRC-1', 'SRC-2', 'SRC-3'],
};
const EARTH_RADIUS_KM = 6371;
const UNIVERSITY_REFERENCE_COORDINATES = Object.freeze({
  // Default host-campus coordinates (ODU area). Can be promoted to tournament config later.
  latitude: 36.8864,
  longitude: -76.3058,
});
const BRONZE_FINAL_MATCH_KEY = 'bronze:R3:final';
const BRONZE_FINAL_REF_SOURCE_KEYS = ['bronze:R1:2v3', 'bronze:R2:1vW45'];

const PLAYOFF_MATCH_TEMPLATES = [
  {
    bracket: 'gold',
    bracketRound: 'R1',
    bracketMatchKey: 'gold:R1:4v5',
    seedA: 4,
    seedB: 5,
    roundBlock: 7,
    facility: 'SRC',
    court: 'SRC-1',
    teamASeed: 4,
    teamBSeed: 5,
    round1Ref: { bracket: 'bronze', seed: 1 },
  },
  {
    bracket: 'gold',
    bracketRound: 'R1',
    bracketMatchKey: 'gold:R1:2v3',
    seedA: 2,
    seedB: 3,
    roundBlock: 7,
    facility: 'VC',
    court: 'VC-1',
    teamASeed: 2,
    teamBSeed: 3,
    round1Ref: { bracket: 'silver', seed: 1 },
  },
  {
    bracket: 'gold',
    bracketRound: 'R2',
    bracketMatchKey: 'gold:R2:1vW45',
    seedA: 1,
    seedB: 4,
    roundBlock: 8,
    facility: 'VC',
    court: 'VC-1',
    teamASeed: 1,
    teamBFromMatchKey: 'gold:R1:4v5',
    teamBFromSlot: 'winner',
  },
  {
    bracket: 'gold',
    bracketRound: 'R3',
    bracketMatchKey: 'gold:R3:final',
    seedA: null,
    seedB: null,
    roundBlock: 9,
    facility: 'VC',
    court: 'VC-1',
    teamAFromMatchKey: 'gold:R2:1vW45',
    teamAFromSlot: 'winner',
    teamBFromMatchKey: 'gold:R1:2v3',
    teamBFromSlot: 'winner',
  },
  {
    bracket: 'silver',
    bracketRound: 'R1',
    bracketMatchKey: 'silver:R1:4v5',
    seedA: 4,
    seedB: 5,
    roundBlock: 7,
    facility: 'SRC',
    court: 'SRC-2',
    teamASeed: 4,
    teamBSeed: 5,
    round1Ref: { bracket: 'bronze', seed: 2 },
  },
  {
    bracket: 'silver',
    bracketRound: 'R1',
    bracketMatchKey: 'silver:R1:2v3',
    seedA: 2,
    seedB: 3,
    roundBlock: 7,
    facility: 'VC',
    court: 'VC-2',
    teamASeed: 2,
    teamBSeed: 3,
    round1Ref: { bracket: 'gold', seed: 1 },
  },
  {
    bracket: 'silver',
    bracketRound: 'R2',
    bracketMatchKey: 'silver:R2:1vW45',
    seedA: 1,
    seedB: 4,
    roundBlock: 8,
    facility: 'VC',
    court: 'VC-2',
    teamASeed: 1,
    teamBFromMatchKey: 'silver:R1:4v5',
    teamBFromSlot: 'winner',
  },
  {
    bracket: 'silver',
    bracketRound: 'R3',
    bracketMatchKey: 'silver:R3:final',
    seedA: null,
    seedB: null,
    roundBlock: 9,
    facility: 'VC',
    court: 'VC-2',
    teamAFromMatchKey: 'silver:R2:1vW45',
    teamAFromSlot: 'winner',
    teamBFromMatchKey: 'silver:R1:2v3',
    teamBFromSlot: 'winner',
  },
  {
    bracket: 'bronze',
    bracketRound: 'R1',
    bracketMatchKey: 'bronze:R1:4v5',
    seedA: 4,
    seedB: 5,
    roundBlock: 7,
    facility: 'SRC',
    court: 'SRC-3',
    teamASeed: 4,
    teamBSeed: 5,
    round1Ref: { bracket: 'bronze', seed: 3 },
  },
  {
    bracket: 'bronze',
    bracketRound: 'R1',
    bracketMatchKey: 'bronze:R1:2v3',
    seedA: 2,
    seedB: 3,
    roundBlock: 8,
    facility: 'SRC',
    court: 'SRC-1',
    teamASeed: 2,
    teamBSeed: 3,
  },
  {
    bracket: 'bronze',
    bracketRound: 'R2',
    bracketMatchKey: 'bronze:R2:1vW45',
    seedA: 1,
    seedB: 4,
    roundBlock: 8,
    facility: 'SRC',
    court: 'SRC-2',
    teamASeed: 1,
    teamBFromMatchKey: 'bronze:R1:4v5',
    teamBFromSlot: 'winner',
  },
  {
    bracket: 'bronze',
    bracketRound: 'R3',
    bracketMatchKey: 'bronze:R3:final',
    seedA: null,
    seedB: null,
    roundBlock: 9,
    facility: 'SRC',
    court: 'SRC-1',
    teamAFromMatchKey: 'bronze:R2:1vW45',
    teamAFromSlot: 'winner',
    teamBFromMatchKey: 'bronze:R1:2v3',
    teamBFromSlot: 'winner',
  },
];

const DEFAULT_REF_SOURCE_BY_MATCH_KEY = {
  'gold:R2:1vW45': { sourceMatchKey: 'gold:R1:2v3', slot: 'loser' },
  'silver:R2:1vW45': { sourceMatchKey: 'silver:R1:2v3', slot: 'loser' },
  'bronze:R1:2v3': { sourceMatchKey: 'gold:R1:4v5', slot: 'loser' },
  'bronze:R2:1vW45': { sourceMatchKey: 'silver:R1:4v5', slot: 'loser' },
  'gold:R3:final': { sourceMatchKey: 'gold:R2:1vW45', slot: 'loser' },
  'silver:R3:final': { sourceMatchKey: 'silver:R2:1vW45', slot: 'loser' },
  'bronze:R3:final': { sourceMatchKey: 'bronze:R2:1vW45', slot: 'loser' },
};

const ROUND_ORDER = {
  R1: 1,
  R2: 2,
  R3: 3,
};

const normalizeBracket = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const toOverallSeed = (bracket, bracketSeed) => {
  const normalizedBracket = normalizeBracket(bracket);
  const parsedSeed = Number(bracketSeed);
  const offset = PLAYOFF_BRACKET_OVERALL_SEED_OFFSET[normalizedBracket];

  if (!Number.isFinite(parsedSeed) || !Number.isFinite(offset)) {
    return null;
  }

  return offset + parsedSeed;
};

const toIdString = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return value._id.toString();
  }

  return value.toString();
};

const sameId = (left, right) => toIdString(left) === toIdString(right);

const resolveTeamName = (team) => team?.shortName || team?.name || 'TBD';

const normalizeCoordinate = (value, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const calculateDistanceKm = (origin, destination) => {
  if (!origin || !destination) {
    return Number.POSITIVE_INFINITY;
  }

  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(destination.latitude);
  const deltaLatitude = toRadians(destination.latitude - origin.latitude);
  const deltaLongitude = toRadians(destination.longitude - origin.longitude);

  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

function resolveTeamCoordinates(team) {
  if (!team || typeof team !== 'object') {
    return null;
  }

  const latitude = normalizeCoordinate(team?.location?.latitude, -90, 90);
  const longitude = normalizeCoordinate(team?.location?.longitude, -180, 180);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
}

const buildSeedLookup = (entries) => {
  const lookup = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const teamId = toIdString(entry?.teamId);
    if (!teamId) {
      return;
    }

    const seed = Number(entry?.bracketSeed);
    if (!Number.isFinite(seed)) {
      return;
    }

    lookup.set(seed, {
      ...entry,
      teamId,
    });
  });
  return lookup;
};

function buildPlayoffSeedAssignments(overallStandings) {
  const ordered = Array.isArray(overallStandings)
    ? [...overallStandings]
        .filter((entry) => toIdString(entry?.teamId))
        .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
    : [];

  const topFifteen = ordered.slice(0, 15);

  if (topFifteen.length < 15) {
    return {
      ok: false,
      missing: [`Cumulative standings resolved ${topFifteen.length}/15 teams`],
      brackets: null,
    };
  }

  const seen = new Set();
  const duplicateIds = [];

  topFifteen.forEach((entry) => {
    const teamId = toIdString(entry.teamId);
    if (seen.has(teamId)) {
      duplicateIds.push(teamId);
      return;
    }
    seen.add(teamId);
  });

  if (duplicateIds.length > 0) {
    return {
      ok: false,
      missing: ['Cumulative standings contain duplicate team ids'],
      brackets: null,
    };
  }

  const buildBracketEntries = (startIndex) =>
    topFifteen.slice(startIndex, startIndex + 5).map((entry, offset) => ({
      teamId: toIdString(entry.teamId),
      name: entry.name || '',
      shortName: entry.shortName || '',
      seed: entry.seed ?? null,
      overallRank: entry.rank ?? startIndex + offset + 1,
      bracketSeed: offset + 1,
    }));

  return {
    ok: true,
    missing: [],
    brackets: {
      gold: buildBracketEntries(0),
      silver: buildBracketEntries(5),
      bronze: buildBracketEntries(10),
    },
  };
}

function buildMatchLabel(match) {
  const bracket = normalizeBracket(match?.bracket);
  const bracketLabel = PLAYOFF_BRACKET_LABELS[bracket] || bracket || 'Bracket';

  if (match?.bracketRound === 'R3') {
    return `${bracketLabel} Final`;
  }

  if (match?.bracketRound === 'R2') {
    return `${bracketLabel} 1 vs W(4/5)`;
  }

  if (Number.isFinite(Number(match?.seedA)) && Number.isFinite(Number(match?.seedB))) {
    return `${bracketLabel} ${Number(match.seedA)}v${Number(match.seedB)}`;
  }

  return `${bracketLabel} ${match?.bracketRound || ''}`.trim();
}

function buildPlayoffBracketView(matches) {
  const bracketState = PLAYOFF_BRACKETS.reduce((lookup, bracket) => {
    lookup[bracket] = {
      bracket,
      label: PLAYOFF_BRACKET_LABELS[bracket],
      seeds: [],
      rounds: {
        R1: [],
        R2: [],
        R3: [],
      },
    };
    return lookup;
  }, {});

  const seedBuckets = PLAYOFF_BRACKETS.reduce((lookup, bracket) => {
    lookup[bracket] = new Map();
    return lookup;
  }, {});

  (Array.isArray(matches) ? matches : []).forEach((match) => {
    const bracket = normalizeBracket(match?.bracket);
    if (!bracketState[bracket]) {
      return;
    }

    const round = match?.bracketRound;
    if (round && bracketState[bracket].rounds[round]) {
      bracketState[bracket].rounds[round].push(match);
    }

    const seedA = Number(match?.seedA);
    const seedB = Number(match?.seedB);

    if (Number.isFinite(seedA) && match?.teamAId && match?.teamA) {
      const overallSeedA = toOverallSeed(bracket, seedA);
      seedBuckets[bracket].set(seedA, {
        seed: overallSeedA ?? seedA,
        bracketSeed: seedA,
        overallSeed: overallSeedA,
        teamId: toIdString(match.teamAId),
        team: match.teamA,
      });
    }
    if (Number.isFinite(seedB) && match?.teamBId && match?.teamB) {
      const overallSeedB = toOverallSeed(bracket, seedB);
      seedBuckets[bracket].set(seedB, {
        seed: overallSeedB ?? seedB,
        bracketSeed: seedB,
        overallSeed: overallSeedB,
        teamId: toIdString(match.teamBId),
        team: match.teamB,
      });
    }
  });

  PLAYOFF_BRACKETS.forEach((bracket) => {
    bracketState[bracket].seeds = Array.from(seedBuckets[bracket].values()).sort(
      (left, right) =>
        (left.bracketSeed ?? left.seed ?? Number.MAX_SAFE_INTEGER) -
        (right.bracketSeed ?? right.seed ?? Number.MAX_SAFE_INTEGER)
    );

    Object.keys(bracketState[bracket].rounds).forEach((round) => {
      bracketState[bracket].rounds[round].sort((left, right) => {
        const leftSeedA = Number(left?.seedA);
        const rightSeedA = Number(right?.seedA);
        return leftSeedA - rightSeedA;
      });
    });
  });

  return bracketState;
}

function buildPlayoffOpsSchedule(matches) {
  const templateBySlot = new Map(
    PLAYOFF_MATCH_TEMPLATES.map((template) => [`${template.roundBlock}:${template.court}`, template])
  );
  const matchBySlot = new Map(
    (Array.isArray(matches) ? matches : []).map((match) => [`${match.roundBlock}:${match.court}`, match])
  );

  return [7, 8, 9].map((roundBlock) => ({
    roundBlock,
    label: PLAYOFF_ROUND_BLOCK_LABELS[roundBlock],
    slots: (PLAYOFF_ROUND_BLOCK_COURTS[roundBlock] || []).map((court) => {
      const match = matchBySlot.get(`${roundBlock}:${court}`) || null;
      const template = templateBySlot.get(`${roundBlock}:${court}`) || null;
      const facility = court.startsWith('SRC-') ? 'SRC' : 'VC';
      const matchForLabel = match || template;

      return {
        roundBlock,
        facility,
        court,
        matchId: match?._id || null,
        matchLabel: matchForLabel ? buildMatchLabel(matchForLabel) : 'Empty',
        bracket: match?.bracket || template?.bracket || null,
        bracketRound: match?.bracketRound || template?.bracketRound || null,
        teams: {
          a: match?.teamA ? resolveTeamName(match.teamA) : 'TBD',
          b: match?.teamB ? resolveTeamName(match.teamB) : 'TBD',
        },
        refs:
          Array.isArray(match?.refTeams) && match.refTeams.length > 0
            ? match.refTeams.map((team) => resolveTeamName(team))
            : [],
        status: match?.status || null,
      };
    }),
  }));
}

function createPlayoffMatchPlan(bracketSeeds) {
  const byBracketSeed = Object.fromEntries(
    PLAYOFF_BRACKETS.map((bracket) => [bracket, buildSeedLookup(bracketSeeds[bracket])])
  );

  return PLAYOFF_MATCH_TEMPLATES.map((template) => {
    const seedLookup = byBracketSeed[template.bracket] || new Map();
    const teamASeedEntry = Number.isFinite(Number(template.teamASeed))
      ? seedLookup.get(Number(template.teamASeed))
      : null;
    const teamBSeedEntry = Number.isFinite(Number(template.teamBSeed))
      ? seedLookup.get(Number(template.teamBSeed))
      : null;
    const round1RefSeedEntry = template.round1Ref
      ? (byBracketSeed[template.round1Ref.bracket] || new Map()).get(Number(template.round1Ref.seed))
      : null;

    return {
      ...template,
      teamAId: teamASeedEntry?.teamId || null,
      teamBId: teamBSeedEntry?.teamId || null,
      refTeamIds: round1RefSeedEntry?.teamId ? [round1RefSeedEntry.teamId] : [],
      title: `${PLAYOFF_BRACKET_LABELS[template.bracket]} ${PLAYOFF_ROUND_LABELS[template.bracketRound]}`,
      teamAName: teamASeedEntry ? resolveTeamName(teamASeedEntry) : 'TBD',
      teamBName: teamBSeedEntry ? resolveTeamName(teamBSeedEntry) : 'TBD',
    };
  });
}

async function loadTournamentTeamLookup(tournamentId) {
  const teams = await TournamentTeam.find({ tournamentId })
    .select('_id name shortName location')
    .lean();
  return new Map(teams.map((team) => [toIdString(team._id), team]));
}

function resolveDependentTeamId(matchesById, sourceMatchId, sourceSlot) {
  const sourceId = toIdString(sourceMatchId);
  if (!sourceId || !sourceSlot) {
    return null;
  }

  const sourceMatch = matchesById.get(sourceId);
  if (!sourceMatch || !sourceMatch.result) {
    return null;
  }

  if (sourceSlot === 'winner') {
    return sourceMatch.result.winnerTeamId || null;
  }

  if (sourceSlot === 'loser') {
    return sourceMatch.result.loserTeamId || null;
  }

  return null;
}

function clearFinalization(match) {
  match.result = null;
  match.status = 'scheduled';
  match.finalizedAt = null;
  match.finalizedBy = null;
}

async function syncScoreboardParticipants(match, teamsById, { resetState = false } = {}) {
  if (!match?.scoreboardId) {
    return;
  }

  const scoreboard = await Scoreboard.findById(match.scoreboardId);

  if (!scoreboard) {
    return;
  }

  const teamA = teamsById.get(toIdString(match.teamAId));
  const teamB = teamsById.get(toIdString(match.teamBId));
  const nextNames = [resolveTeamName(teamA), resolveTeamName(teamB)];
  let changed = false;

  if (!Array.isArray(scoreboard.teams) || scoreboard.teams.length !== 2) {
    scoreboard.teams = [{ name: nextNames[0], score: 0 }, { name: nextNames[1], score: 0 }];
    changed = true;
  } else {
    scoreboard.teams.forEach((team, index) => {
      if ((team?.name || '') !== nextNames[index]) {
        scoreboard.teams[index].name = nextNames[index];
        changed = true;
      }

      if (resetState && Number(team?.score || 0) !== 0) {
        scoreboard.teams[index].score = 0;
        changed = true;
      }
    });
  }

  if (resetState && Array.isArray(scoreboard.sets) && scoreboard.sets.length > 0) {
    scoreboard.sets = [];
    changed = true;
  }

  if (changed) {
    await scoreboard.save();
  }
}

function resolveTeamIdFromRefRule(refRule, matchesByKey) {
  if (!refRule) {
    return null;
  }

  const sourceMatch = matchesByKey.get(refRule.sourceMatchKey);
  if (!sourceMatch || !sourceMatch.result) {
    return null;
  }

  if (refRule.slot === 'winner') {
    return sourceMatch.result.winnerTeamId || null;
  }

  if (refRule.slot === 'loser') {
    return sourceMatch.result.loserTeamId || null;
  }

  return null;
}

function resolveBronzeFinalRefTeamId(matchesByKey, teamsById) {
  const candidateTeamIds = BRONZE_FINAL_REF_SOURCE_KEYS.map((sourceMatchKey) =>
    resolveTeamIdFromRefRule(
      {
        sourceMatchKey,
        slot: 'loser',
      },
      matchesByKey
    )
  )
    .map((teamId) => toIdString(teamId))
    .filter(Boolean);
  const uniqueCandidateTeamIds = [...new Set(candidateTeamIds)];

  if (uniqueCandidateTeamIds.length === 0) {
    return null;
  }

  if (uniqueCandidateTeamIds.length === 1) {
    return uniqueCandidateTeamIds[0];
  }

  const rankedCandidates = uniqueCandidateTeamIds
    .map((teamId) => {
      const team = teamsById.get(teamId);
      const coordinates = resolveTeamCoordinates(team);
      const distanceToUniversity = calculateDistanceKm(coordinates, UNIVERSITY_REFERENCE_COORDINATES);

      return {
        teamId,
        distanceToUniversity,
      };
    })
    .filter((entry) => Number.isFinite(entry.distanceToUniversity))
    .sort((left, right) => {
      if (left.distanceToUniversity !== right.distanceToUniversity) {
        return left.distanceToUniversity - right.distanceToUniversity;
      }

      return String(left.teamId).localeCompare(String(right.teamId));
    });

  if (rankedCandidates.length === 0) {
    return null;
  }

  return rankedCandidates[0].teamId;
}

function resolveSuggestedRefTeamId(match, matchesByKey, teamsById) {
  if (match?.bracketMatchKey === BRONZE_FINAL_MATCH_KEY) {
    const bronzeFinalRefTeamId = resolveBronzeFinalRefTeamId(matchesByKey, teamsById);
    if (bronzeFinalRefTeamId) {
      return bronzeFinalRefTeamId;
    }
  }

  const refRule = DEFAULT_REF_SOURCE_BY_MATCH_KEY[match?.bracketMatchKey];
  return resolveTeamIdFromRefRule(refRule, matchesByKey);
}

async function recomputePlayoffBracketProgression(tournamentId, bracket, options = {}) {
  const normalizedBracket = normalizeBracket(bracket);
  const allowUnknownBracket = options?.allowUnknownBracket === true;
  const hasManagedRefRules = PLAYOFF_BRACKETS.includes(normalizedBracket);

  if (!normalizedBracket) {
    return {
      updatedMatchIds: [],
      clearedMatchIds: [],
    };
  }

  if (!hasManagedRefRules && !allowUnknownBracket) {
    return {
      updatedMatchIds: [],
      clearedMatchIds: [],
    };
  }

  const allMatches = await Match.find({
    tournamentId,
    phase: 'playoffs',
  }).sort({
    roundBlock: 1,
    createdAt: 1,
  });

  const matches = allMatches.filter((match) => normalizeBracket(match?.bracket) === normalizedBracket);

  if (matches.length === 0) {
    return {
      updatedMatchIds: [],
      clearedMatchIds: [],
    };
  }

  const matchesById = new Map(allMatches.map((match) => [toIdString(match._id), match]));
  const matchesByKey = new Map(
    allMatches
      .filter((match) => typeof match.bracketMatchKey === 'string' && match.bracketMatchKey.trim())
      .map((match) => [match.bracketMatchKey, match])
  );
  const teamsById = await loadTournamentTeamLookup(tournamentId);

  const ordered = [...matches].sort((left, right) => {
    const roundCompare = (ROUND_ORDER[left.bracketRound] || 99) - (ROUND_ORDER[right.bracketRound] || 99);
    if (roundCompare !== 0) {
      return roundCompare;
    }

    if ((left.roundBlock || 0) !== (right.roundBlock || 0)) {
      return (left.roundBlock || 0) - (right.roundBlock || 0);
    }

    return String(left.court || '').localeCompare(String(right.court || ''));
  });

  const matchesNeedingSave = new Map();
  const matchesWithParticipantChange = new Map();
  const clearedMatchIds = new Set();

  ordered.forEach((match) => {
    let participantChanged = false;

    if (match.teamAFromMatchId && match.teamAFromSlot) {
      const nextTeamAId = resolveDependentTeamId(matchesById, match.teamAFromMatchId, match.teamAFromSlot);
      if (!sameId(nextTeamAId, match.teamAId)) {
        match.teamAId = nextTeamAId || null;
        participantChanged = true;
      }
    }

    if (match.teamBFromMatchId && match.teamBFromSlot) {
      const nextTeamBId = resolveDependentTeamId(matchesById, match.teamBFromMatchId, match.teamBFromSlot);
      if (!sameId(nextTeamBId, match.teamBId)) {
        match.teamBId = nextTeamBId || null;
        participantChanged = true;
      }
    }

    if (participantChanged) {
      if (match.status === 'final' || match.result) {
        clearFinalization(match);
        clearedMatchIds.add(toIdString(match._id));
      } else if (match.status !== 'scheduled') {
        match.status = 'scheduled';
      }

      matchesWithParticipantChange.set(toIdString(match._id), match);
      matchesNeedingSave.set(toIdString(match._id), match);
    }

    const hasManagedRefRule =
      hasManagedRefRules &&
      Boolean(DEFAULT_REF_SOURCE_BY_MATCH_KEY[match?.bracketMatchKey]);
    if (Number(match.roundBlock) > 7 && hasManagedRefRule) {
      const suggestedRefTeamId = toIdString(resolveSuggestedRefTeamId(match, matchesByKey, teamsById));
      const currentRefTeamIds = Array.isArray(match.refTeamIds)
        ? match.refTeamIds.map((teamId) => toIdString(teamId)).filter(Boolean)
        : [];

      if (suggestedRefTeamId) {
        if (currentRefTeamIds.length !== 1 || currentRefTeamIds[0] !== suggestedRefTeamId) {
          match.refTeamIds = [suggestedRefTeamId];
          matchesNeedingSave.set(toIdString(match._id), match);
        }
      } else if (currentRefTeamIds.length > 0) {
        match.refTeamIds = [];
        matchesNeedingSave.set(toIdString(match._id), match);
      }
    }
  });

  for (const match of matchesWithParticipantChange.values()) {
    await syncScoreboardParticipants(match, teamsById, { resetState: true });
  }

  for (const match of matchesNeedingSave.values()) {
    await match.save();
  }

  return {
    updatedMatchIds: Array.from(matchesNeedingSave.keys()),
    clearedMatchIds: Array.from(clearedMatchIds),
  };
}

module.exports = {
  PLAYOFF_BRACKETS,
  PLAYOFF_BRACKET_LABELS,
  PLAYOFF_MATCH_TEMPLATES,
  PLAYOFF_ROUND_BLOCK_COURTS,
  PLAYOFF_ROUND_BLOCK_LABELS,
  buildMatchLabel,
  buildPlayoffBracketView,
  buildPlayoffOpsSchedule,
  buildPlayoffSeedAssignments,
  createPlayoffMatchPlan,
  loadTournamentTeamLookup,
  recomputePlayoffBracketProgression,
  resolveTeamName,
  toIdString,
};
