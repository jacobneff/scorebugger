export const PHASE1_POOL_ORDER = ['A', 'B', 'C', 'D', 'E'];
export const PHASE2_POOL_ORDER = ['F', 'G', 'H', 'I', 'J'];

export const PHASE1_COURT_ORDER = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];
export const PHASE2_COURT_ORDER = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

export const PHASE1_ROUND_BLOCKS = [1, 2, 3];
export const PHASE2_ROUND_BLOCKS = [4, 5, 6];

const poolOrderLookup = PHASE1_POOL_ORDER.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

const phase2PoolOrderLookup = PHASE2_POOL_ORDER.reduce((lookup, poolName, index) => {
  lookup[poolName] = index;
  return lookup;
}, {});

export const sortPhase1Pools = (pools) =>
  [...(Array.isArray(pools) ? pools : [])].sort((poolA, poolB) => {
    const orderA = poolOrderLookup[poolA?.name] ?? Number.MAX_SAFE_INTEGER;
    const orderB = poolOrderLookup[poolB?.name] ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return String(poolA?.name || '').localeCompare(String(poolB?.name || ''));
  });

export const sortPhase2Pools = (pools) =>
  [...(Array.isArray(pools) ? pools : [])].sort((poolA, poolB) => {
    const orderA = phase2PoolOrderLookup[poolA?.name] ?? Number.MAX_SAFE_INTEGER;
    const orderB = phase2PoolOrderLookup[poolB?.name] ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return String(poolA?.name || '').localeCompare(String(poolB?.name || ''));
  });

export const formatTeamLabel = (team) => {
  if (!team) {
    return 'TBD';
  }

  const baseName = team.shortName || team.name || 'TBD';
  const seedSuffix =
    Number.isFinite(Number(team.seed)) && team.seed !== null ? ` (#${Number(team.seed)})` : '';
  return `${baseName}${seedSuffix}`;
};

export const buildScheduleLookup = (matches) => {
  const lookup = {};

  (Array.isArray(matches) ? matches : []).forEach((match) => {
    const roundBlock = Number(match?.roundBlock);
    const court = match?.court;

    if (!Number.isFinite(roundBlock) || !court) {
      return;
    }

    lookup[`${roundBlock}-${court}`] = match;
  });

  return lookup;
};

export const buildPhase1ScheduleLookup = (matches) => buildScheduleLookup(matches);
export const buildPhase2ScheduleLookup = (matches) => buildScheduleLookup(matches);
