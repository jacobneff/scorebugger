import { describe, expect, it } from 'vitest';

import {
  buildTwoPassPoolPatchPlan,
  computePoolSwapPreview,
  computeTeamDragPreview,
} from '../utils/phase1PoolDnd.js';

const makeTeam = (id) => ({
  _id: id,
  shortName: id.toUpperCase(),
  name: id.toUpperCase(),
});

const createFixture = () => {
  const teamMap = {
    t1: makeTeam('t1'),
    t2: makeTeam('t2'),
    t3: makeTeam('t3'),
    t4: makeTeam('t4'),
    t5: makeTeam('t5'),
    t6: makeTeam('t6'),
    t7: makeTeam('t7'),
  };

  return {
    teams: Object.values(teamMap),
    pools: [
      {
        _id: 'pool-a',
        name: 'A',
        teamIds: [teamMap.t1, teamMap.t2, teamMap.t3],
      },
      {
        _id: 'pool-b',
        name: 'B',
        teamIds: [teamMap.t4, teamMap.t5, teamMap.t6],
      },
    ],
  };
};

const idsForPool = (pools, poolId) =>
  pools.find((pool) => pool._id === poolId).teamIds.map((team) => String(team._id));

describe('phase1PoolDnd', () => {
  it('swaps positions when dropping on another team in the same pool', () => {
    const fixture = createFixture();

    const result = computeTeamDragPreview({
      pools: fixture.pools,
      teams: fixture.teams,
      activeTeamId: 't1',
      overId: 't2',
    });

    expect(result?.poolIdsToPersist).toEqual(['pool-a']);
    expect(idsForPool(result.nextPools, 'pool-a')).toEqual(['t2', 't1', 't3']);
  });

  it('swaps teams across pools when dropping on a team in another pool', () => {
    const fixture = createFixture();

    const result = computeTeamDragPreview({
      pools: fixture.pools,
      teams: fixture.teams,
      activeTeamId: 't1',
      overId: 't4',
    });

    expect(result?.poolIdsToPersist).toEqual(['pool-a', 'pool-b']);
    expect(idsForPool(result.nextPools, 'pool-a')).toEqual(['t4', 't2', 't3']);
    expect(idsForPool(result.nextPools, 'pool-b')).toEqual(['t1', 't5', 't6']);
  });

  it('rejects dropping a bank team onto a full pool container', () => {
    const fixture = createFixture();

    const result = computeTeamDragPreview({
      pools: fixture.pools,
      teams: fixture.teams,
      activeTeamId: 't7',
      overId: 'pool-a',
    });

    expect(result).toEqual({
      error: 'A pool can include at most 3 teams. Move one out first.',
    });
  });

  it('supports pool-header swap only when both pools are full', () => {
    const fixture = createFixture();

    const success = computePoolSwapPreview({
      pools: fixture.pools,
      sourcePoolId: 'pool-a',
      targetPoolId: 'pool-b',
      requireFull: true,
    });

    expect(success?.poolIdsToPersist).toEqual(['pool-a', 'pool-b']);
    expect(idsForPool(success.nextPools, 'pool-a')).toEqual(['t4', 't5', 't6']);
    expect(idsForPool(success.nextPools, 'pool-b')).toEqual(['t1', 't2', 't3']);

    const notFullPools = [
      fixture.pools[0],
      {
        ...fixture.pools[1],
        teamIds: fixture.pools[1].teamIds.slice(0, 2),
      },
    ];

    const failure = computePoolSwapPreview({
      pools: notFullPools,
      sourcePoolId: 'pool-a',
      targetPoolId: 'pool-b',
      requireFull: true,
    });

    expect(failure).toEqual({
      error: 'Both pools must have exactly 3 teams to swap all 3 at once.',
    });
  });

  it('allows adding a fourth team when pool requires four teams', () => {
    const fixture = createFixture();
    const pools = [
      {
        ...fixture.pools[0],
        requiredTeamCount: 4,
      },
      fixture.pools[1],
    ];

    const result = computeTeamDragPreview({
      pools,
      teams: fixture.teams,
      activeTeamId: 't7',
      overId: 'pool-a',
    });

    expect(result?.poolIdsToPersist).toEqual(['pool-a']);
    expect(idsForPool(result.nextPools, 'pool-a')).toEqual(['t1', 't2', 't3', 't7']);
  });

  it('supports swapping full four-team pools', () => {
    const fixture = createFixture();
    const pools = [
      {
        ...fixture.pools[0],
        requiredTeamCount: 4,
        teamIds: [...fixture.pools[0].teamIds, makeTeam('t7')],
      },
      {
        ...fixture.pools[1],
        requiredTeamCount: 4,
        teamIds: [...fixture.pools[1].teamIds, makeTeam('t8')],
      },
    ];

    const result = computePoolSwapPreview({
      pools,
      sourcePoolId: 'pool-a',
      targetPoolId: 'pool-b',
      requireFull: true,
    });

    expect(result?.poolIdsToPersist).toEqual(['pool-a', 'pool-b']);
    expect(idsForPool(result.nextPools, 'pool-a')).toEqual(['t4', 't5', 't6', 't8']);
    expect(idsForPool(result.nextPools, 'pool-b')).toEqual(['t1', 't2', 't3', 't7']);
  });

  it('blocks swapping pools with different required capacities', () => {
    const fixture = createFixture();
    const pools = [
      {
        ...fixture.pools[0],
        requiredTeamCount: 4,
        teamIds: [...fixture.pools[0].teamIds, makeTeam('t7')],
      },
      {
        ...fixture.pools[1],
        requiredTeamCount: 3,
      },
    ];

    const result = computePoolSwapPreview({
      pools,
      sourcePoolId: 'pool-a',
      targetPoolId: 'pool-b',
      requireFull: true,
    });

    expect(result).toEqual({
      error: 'Both pools must require the same team count to swap all teams (4 vs 3).',
    });
  });

  it('builds two-pass persistence updates for cross-pool swaps', () => {
    const fixture = createFixture();
    const swapResult = computeTeamDragPreview({
      pools: fixture.pools,
      teams: fixture.teams,
      activeTeamId: 't1',
      overId: 't4',
    });

    const plan = buildTwoPassPoolPatchPlan({
      previousPools: fixture.pools,
      nextPools: swapResult.nextPools,
      poolIdsToPersist: swapResult.poolIdsToPersist,
    });

    expect(plan.passOne).toEqual([
      {
        poolId: 'pool-a',
        teamIds: ['t2', 't3'],
      },
      {
        poolId: 'pool-b',
        teamIds: ['t5', 't6'],
      },
    ]);
    expect(plan.passTwo).toEqual([
      {
        poolId: 'pool-a',
        teamIds: ['t4', 't2', 't3'],
      },
      {
        poolId: 'pool-b',
        teamIds: ['t1', 't5', 't6'],
      },
    ]);
  });
});
