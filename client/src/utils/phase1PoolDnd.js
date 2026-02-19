export const MAX_PHASE1_POOL_SIZE = 3;
export const TEAM_BANK_CONTAINER_ID = 'team-bank';
export const POOL_SWAP_DRAG_PREFIX = 'pool-swap:';
export const POOL_SWAP_TARGET_PREFIX = 'pool-swap-target:';

const toIdString = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
};

const toPoolIdList = (pools) =>
  (Array.isArray(pools) ? pools : [])
    .map((pool) => toIdString(pool?._id))
    .filter(Boolean);

const extractTeamId = (team) => {
  if (!team) {
    return '';
  }

  if (typeof team === 'string') {
    return toIdString(team);
  }

  if (typeof team === 'object' && team._id !== undefined && team._id !== null) {
    return toIdString(team._id);
  }

  return toIdString(team);
};

const toTeamIdList = (pool) =>
  Array.isArray(pool?.teamIds)
    ? pool.teamIds.map((team) => extractTeamId(team)).filter(Boolean)
    : [];

const getPoolCapacity = (pool, fallback = MAX_PHASE1_POOL_SIZE) => {
  const parsed = Number(pool?.requiredTeamCount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

const findPoolById = (pools, poolId) =>
  (Array.isArray(pools) ? pools : []).find((pool) => toIdString(pool?._id) === poolId) || null;

const findPoolByTeamId = (pools, teamId) =>
  (Array.isArray(pools) ? pools : []).find((pool) =>
    toTeamIdList(pool).includes(teamId)
  ) || null;

const findTeamInPools = (pools, teamId) => {
  const ownerPool = findPoolByTeamId(pools, teamId);
  if (!ownerPool) {
    return null;
  }

  const existingTeam =
    (Array.isArray(ownerPool.teamIds) ? ownerPool.teamIds : []).find(
      (team) => extractTeamId(team) === teamId
    ) || null;

  if (existingTeam && typeof existingTeam === 'object') {
    return existingTeam;
  }

  return null;
};

const findTeamInTeams = (teams, teamId) =>
  (Array.isArray(teams) ? teams : []).find((team) => toIdString(team?._id) === teamId) || null;

const buildAssignedTeamIdSet = (pools) => {
  const ids = new Set();
  (Array.isArray(pools) ? pools : []).forEach((pool) => {
    toTeamIdList(pool).forEach((teamId) => ids.add(teamId));
  });
  return ids;
};

const isTeamInBank = (teams, pools, teamId) => {
  const assigned = buildAssignedTeamIdSet(pools);
  if (assigned.has(teamId)) {
    return false;
  }
  return Boolean(findTeamInTeams(teams, teamId));
};

const resolveContainerId = ({ id, pools, teams }) => {
  const normalized = toIdString(id);
  if (!normalized) {
    return null;
  }

  if (normalized === TEAM_BANK_CONTAINER_ID) {
    return TEAM_BANK_CONTAINER_ID;
  }

  if (findPoolById(pools, normalized)) {
    return normalized;
  }

  const owningPool = findPoolByTeamId(pools, normalized);
  if (owningPool?._id) {
    return toIdString(owningPool._id);
  }

  if (isTeamInBank(teams, pools, normalized)) {
    return TEAM_BANK_CONTAINER_ID;
  }

  return null;
};

const unique = (values) => {
  const seen = new Set();
  const result = [];

  values.forEach((value) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    result.push(value);
  });

  return result;
};

export const clonePoolsForDnd = (pools) =>
  (Array.isArray(pools) ? pools : []).map((pool) => ({
    ...pool,
    teamIds: Array.isArray(pool.teamIds) ? [...pool.teamIds] : [],
  }));

export const buildTeamBankFromPools = (teams, pools) => {
  const assignedTeamIds = buildAssignedTeamIdSet(pools);
  return (Array.isArray(teams) ? teams : []).filter(
    (team) => !assignedTeamIds.has(toIdString(team?._id))
  );
};

export const collectChangedPoolIds = (previousPools, nextPools) => {
  const previousById = new Map(
    (Array.isArray(previousPools) ? previousPools : []).map((pool) => [toIdString(pool?._id), pool])
  );
  const nextById = new Map(
    (Array.isArray(nextPools) ? nextPools : []).map((pool) => [toIdString(pool?._id), pool])
  );

  const orderedPoolIds = unique([...toPoolIdList(previousPools), ...toPoolIdList(nextPools)]);

  return orderedPoolIds.filter((poolId) => {
    const previousTeamIds = toTeamIdList(previousById.get(poolId));
    const nextTeamIds = toTeamIdList(nextById.get(poolId));
    return previousTeamIds.join('|') !== nextTeamIds.join('|');
  });
};

const hasCrossPoolMoves = (previousPools, nextPools, poolIds) => {
  const previousById = new Map(
    (Array.isArray(previousPools) ? previousPools : []).map((pool) => [toIdString(pool?._id), pool])
  );
  const nextById = new Map(
    (Array.isArray(nextPools) ? nextPools : []).map((pool) => [toIdString(pool?._id), pool])
  );

  const teamPoolBefore = new Map();
  const teamPoolAfter = new Map();

  poolIds.forEach((poolId) => {
    toTeamIdList(previousById.get(poolId)).forEach((teamId) => {
      teamPoolBefore.set(teamId, poolId);
    });
    toTeamIdList(nextById.get(poolId)).forEach((teamId) => {
      teamPoolAfter.set(teamId, poolId);
    });
  });

  return Array.from(teamPoolBefore.keys()).some((teamId) => {
    if (!teamPoolAfter.has(teamId)) {
      return false;
    }
    return teamPoolBefore.get(teamId) !== teamPoolAfter.get(teamId);
  });
};

export const buildTwoPassPoolPatchPlan = ({
  previousPools,
  nextPools,
  poolIdsToPersist,
}) => {
  const poolIds = unique(
    (Array.isArray(poolIdsToPersist) ? poolIdsToPersist : []).map((poolId) => toIdString(poolId))
  );

  const previousById = new Map(
    (Array.isArray(previousPools) ? previousPools : []).map((pool) => [toIdString(pool?._id), pool])
  );
  const nextById = new Map(
    (Array.isArray(nextPools) ? nextPools : []).map((pool) => [toIdString(pool?._id), pool])
  );

  const passTwo = poolIds.map((poolId) => ({
    poolId,
    teamIds: toTeamIdList(nextById.get(poolId)),
  }));

  if (poolIds.length <= 1 || !hasCrossPoolMoves(previousPools, nextPools, poolIds)) {
    return {
      passOne: [],
      passTwo,
    };
  }

  const passOne = poolIds
    .map((poolId) => {
      const previousTeamIds = toTeamIdList(previousById.get(poolId));
      const nextTeamIdSet = new Set(toTeamIdList(nextById.get(poolId)));
      const retainedTeamIds = previousTeamIds.filter((teamId) => nextTeamIdSet.has(teamId));
      if (retainedTeamIds.length === previousTeamIds.length) {
        return null;
      }

      return {
        poolId,
        teamIds: retainedTeamIds,
      };
    })
    .filter(Boolean);

  return {
    passOne,
    passTwo,
  };
};

export const computeTeamDragPreview = ({ pools, teams, activeTeamId, overId }) => {
  const normalizedActiveTeamId = toIdString(activeTeamId);
  const normalizedOverId = toIdString(overId);

  if (!normalizedActiveTeamId || !normalizedOverId) {
    return null;
  }

  const sourceContainerId = resolveContainerId({
    id: normalizedActiveTeamId,
    pools,
    teams,
  });
  const targetContainerId = resolveContainerId({
    id: normalizedOverId,
    pools,
    teams,
  });

  if (!sourceContainerId || !targetContainerId) {
    return null;
  }

  if (
    sourceContainerId === TEAM_BANK_CONTAINER_ID &&
    targetContainerId === TEAM_BANK_CONTAINER_ID
  ) {
    return null;
  }

  const nextPools = clonePoolsForDnd(pools);
  const sourcePool = findPoolById(nextPools, sourceContainerId);
  const targetPool = findPoolById(nextPools, targetContainerId);
  const sourceTeamIndex = sourcePool
    ? sourcePool.teamIds.findIndex((team) => toIdString(team?._id) === normalizedActiveTeamId)
    : -1;
  const targetTeamIndex = targetPool
    ? targetPool.teamIds.findIndex((team) => toIdString(team?._id) === normalizedOverId)
    : -1;
  const overIsTeamCard = targetTeamIndex >= 0;
  const touchedPoolIds = [];

  const draggedTeam = sourcePool
    ? sourcePool.teamIds[sourceTeamIndex]
    : findTeamInTeams(teams, normalizedActiveTeamId) || findTeamInPools(pools, normalizedActiveTeamId);

  if (!draggedTeam) {
    return null;
  }

  if (targetContainerId === TEAM_BANK_CONTAINER_ID) {
    if (!sourcePool || sourceTeamIndex < 0) {
      return null;
    }

    sourcePool.teamIds.splice(sourceTeamIndex, 1);
    touchedPoolIds.push(sourceContainerId);
  } else if (targetPool) {
    if (overIsTeamCard) {
      if (sourcePool) {
        if (sourceContainerId === targetContainerId) {
          if (sourceTeamIndex === targetTeamIndex || sourceTeamIndex < 0) {
            return null;
          }

          const sourceTeam = sourcePool.teamIds[sourceTeamIndex];
          sourcePool.teamIds[sourceTeamIndex] = targetPool.teamIds[targetTeamIndex];
          targetPool.teamIds[targetTeamIndex] = sourceTeam;
          touchedPoolIds.push(sourceContainerId);
        } else {
          if (sourceTeamIndex < 0) {
            return null;
          }

          const targetTeam = targetPool.teamIds[targetTeamIndex];
          sourcePool.teamIds[sourceTeamIndex] = targetTeam;
          targetPool.teamIds[targetTeamIndex] = draggedTeam;
          touchedPoolIds.push(sourceContainerId, targetContainerId);
        }
      } else {
        const maxTeams = getPoolCapacity(targetPool);
        if (targetPool.teamIds.length >= maxTeams) {
          return { error: `A pool can include at most ${maxTeams} teams. Move one out first.` };
        }

        targetPool.teamIds.splice(targetTeamIndex, 0, draggedTeam);
        touchedPoolIds.push(targetContainerId);
      }
    } else if (sourcePool) {
      if (sourceTeamIndex < 0) {
        return null;
      }

      if (sourceContainerId === targetContainerId) {
        return null;
      } else {
        const maxTeams = getPoolCapacity(targetPool);
        if (targetPool.teamIds.length >= maxTeams) {
          return { error: `A pool can include at most ${maxTeams} teams. Move one out first.` };
        }

        const [team] = sourcePool.teamIds.splice(sourceTeamIndex, 1);
        targetPool.teamIds.push(team);
        touchedPoolIds.push(sourceContainerId, targetContainerId);
      }
    } else {
      const maxTeams = getPoolCapacity(targetPool);
      if (targetPool.teamIds.length >= maxTeams) {
        return { error: `A pool can include at most ${maxTeams} teams. Move one out first.` };
      }

      targetPool.teamIds.push(draggedTeam);
      touchedPoolIds.push(targetContainerId);
    }
  } else {
    return null;
  }

  const changedPoolIds = collectChangedPoolIds(pools, nextPools);
  const poolIdsToPersist = unique(
    touchedPoolIds.filter((poolId) => changedPoolIds.includes(poolId))
  );

  if (poolIdsToPersist.length === 0) {
    return null;
  }

  return {
    nextPools,
    poolIdsToPersist,
  };
};

export const buildPoolSwapDragId = (poolId) =>
  `${POOL_SWAP_DRAG_PREFIX}${toIdString(poolId)}`;

export const buildPoolSwapTargetId = (poolId) =>
  `${POOL_SWAP_TARGET_PREFIX}${toIdString(poolId)}`;

export const parsePoolSwapDragPoolId = (id) => {
  const normalized = toIdString(id);
  if (!normalized.startsWith(POOL_SWAP_DRAG_PREFIX)) {
    return null;
  }
  return normalized.slice(POOL_SWAP_DRAG_PREFIX.length) || null;
};

export const parsePoolSwapTargetPoolId = (id) => {
  const normalized = toIdString(id);
  if (!normalized.startsWith(POOL_SWAP_TARGET_PREFIX)) {
    return null;
  }
  return normalized.slice(POOL_SWAP_TARGET_PREFIX.length) || null;
};

export const computePoolSwapPreview = ({
  pools,
  sourcePoolId,
  targetPoolId,
  requireFull = true,
  maxTeamsPerPool = MAX_PHASE1_POOL_SIZE,
}) => {
  const normalizedSourcePoolId = toIdString(sourcePoolId);
  const normalizedTargetPoolId = toIdString(targetPoolId);

  if (!normalizedSourcePoolId || !normalizedTargetPoolId) {
    return null;
  }

  if (normalizedSourcePoolId === normalizedTargetPoolId) {
    return null;
  }

  const sourcePool = findPoolById(pools, normalizedSourcePoolId);
  const targetPool = findPoolById(pools, normalizedTargetPoolId);

  if (!sourcePool || !targetPool) {
    return null;
  }

  if (
    requireFull &&
    (toTeamIdList(sourcePool).length !== maxTeamsPerPool ||
      toTeamIdList(targetPool).length !== maxTeamsPerPool)
  ) {
    return {
      error: `Both pools must have exactly ${maxTeamsPerPool} teams to swap all ${maxTeamsPerPool} at once.`,
    };
  }

  const nextPools = clonePoolsForDnd(pools);
  const sourcePoolDraft = findPoolById(nextPools, normalizedSourcePoolId);
  const targetPoolDraft = findPoolById(nextPools, normalizedTargetPoolId);

  if (!sourcePoolDraft || !targetPoolDraft) {
    return null;
  }

  const sourceTeams = [...sourcePoolDraft.teamIds];
  sourcePoolDraft.teamIds = [...targetPoolDraft.teamIds];
  targetPoolDraft.teamIds = sourceTeams;

  const changedPoolIds = collectChangedPoolIds(pools, nextPools);
  const poolIdsToPersist = unique(
    [normalizedSourcePoolId, normalizedTargetPoolId].filter((poolId) =>
      changedPoolIds.includes(poolId)
    )
  );

  if (poolIdsToPersist.length === 0) {
    return null;
  }

  return {
    nextPools,
    poolIdsToPersist,
  };
};
