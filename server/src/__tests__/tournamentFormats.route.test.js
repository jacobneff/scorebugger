const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentFormatRoutes = require('../routes/tournamentFormats');
const Match = require('../models/Match');
const Pool = require('../models/Pool');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const User = require('../models/User');

const FORMAT_12_ID = 'classic_12_3x4_gold8_silver4_v1';
const FORMAT_14_ID = 'classic_14_mixedpools_crossover_gold8_silver6_v1';
const FORMAT_15_ID = 'odu_15_5courts_v1';
const FORMAT_16_ID = 'classic_16_4x4_all16_v1';

const PHASE1_POOL_NAMES = ['A', 'B', 'C', 'D', 'E'];
const PHASE2_POOL_NAMES = ['F', 'G', 'H', 'I', 'J'];
const PHASE1_HOME_COURTS = {
  A: 'SRC-1',
  B: 'SRC-2',
  C: 'SRC-3',
  D: 'VC-1',
  E: 'VC-2',
};
const PHASE2_HOME_COURTS = {
  F: 'SRC-1',
  G: 'SRC-2',
  H: 'SRC-3',
  I: 'VC-1',
  J: 'VC-2',
};

describe('tournament format routes + apply-format flow', () => {
  let mongo;
  let app;
  let user;
  let token;
  let publicCodeCounter = 1;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'tournament-format-route-tests',
    });
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));

    user = await User.create({
      email: 'owner@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });

    token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);

    app = express();
    app.use(express.json());
    app.use('/api/tournaments', tournamentRoutes);
    app.use('/api/tournament-formats', tournamentFormatRoutes);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const authHeader = () => ({
    Authorization: `Bearer ${token}`,
  });

  async function createOwnedTournament(nameSuffix = '') {
    const suffix = String(publicCodeCounter).padStart(5, '0');
    publicCodeCounter += 1;

    return Tournament.create({
      name: `Format Test ${nameSuffix || suffix}`,
      date: new Date('2026-10-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: `F${suffix}`,
      createdByUserId: user._id,
    });
  }

  async function seedTeams(tournamentId, teamCount) {
    return TournamentTeam.insertMany(
      Array.from({ length: teamCount }, (_, index) => ({
        tournamentId,
        name: `Team ${index + 1}`,
        shortName: `T${index + 1}`,
        orderIndex: index + 1,
        seed: index + 1,
      })),
      { ordered: true }
    );
  }

  test('suggest formats includes 12-team and 16-team options for requested court counts', async () => {
    const [twelveTeamsResponse, sixteenTeamsResponse] = await Promise.all([
      request(app).get('/api/tournament-formats/suggest?teamCount=12&courtCount=5'),
      request(app).get('/api/tournament-formats/suggest?teamCount=16&courtCount=3'),
    ]);

    expect(twelveTeamsResponse.statusCode).toBe(200);
    expect(sixteenTeamsResponse.statusCode).toBe(200);

    expect(twelveTeamsResponse.body.map((entry) => entry.id)).toContain(FORMAT_12_ID);
    expect(sixteenTeamsResponse.body.map((entry) => entry.id)).toContain(FORMAT_16_ID);
  });

  test('GET /api/tournament-formats/:formatId returns full format definition', async () => {
    const response = await request(app).get(`/api/tournament-formats/${FORMAT_14_ID}`);

    expect(response.statusCode).toBe(200);
    expect(response.body.id).toBe(FORMAT_14_ID);
    expect(Array.isArray(response.body.stages)).toBe(true);
    expect(response.body.stages.map((stage) => stage.key)).toEqual(
      expect.arrayContaining(['poolPlay1', 'crossover', 'playoffs'])
    );
  });

  test.each([
    {
      label: '12-team format',
      teamCount: 12,
      formatId: FORMAT_12_ID,
      expectedPoolSizes: [4, 4, 4],
    },
    {
      label: '14-team format',
      teamCount: 14,
      formatId: FORMAT_14_ID,
      expectedPoolSizes: [4, 4, 3, 3],
    },
    {
      label: '16-team format',
      teamCount: 16,
      formatId: FORMAT_16_ID,
      expectedPoolSizes: [4, 4, 4, 4],
    },
  ])('apply-format creates correct pool skeletons for $label', async ({
    teamCount,
    formatId,
    expectedPoolSizes,
  }) => {
    const tournament = await createOwnedTournament(formatId);
    await seedTeams(tournament._id, teamCount);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId,
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.format.id).toBe(formatId);
    expect(response.body.pools).toHaveLength(expectedPoolSizes.length);

    const actualSizes = response.body.pools
      .map((pool) => Number(pool.requiredTeamCount))
      .sort((left, right) => right - left);
    const expectedSortedSizes = [...expectedPoolSizes].sort((left, right) => right - left);

    expect(actualSizes).toEqual(expectedSortedSizes);
    expect(response.body.pools.every((pool) => pool.stageKey === 'poolPlay1')).toBe(true);
    expect(response.body.pools.every((pool) => Array.isArray(pool.teamIds) && pool.teamIds.length === 0)).toBe(
      true
    );
  });

  test('stage pools endpoint returns ordered 14-team pool capacities', async () => {
    const tournament = await createOwnedTournament('stage-pools');
    await seedTeams(tournament._id, 14);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_14_ID,
      });

    expect(apply.statusCode).toBe(200);

    const stagePools = await request(app)
      .get(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools`)
      .set(authHeader());

    expect(stagePools.statusCode).toBe(200);
    expect(stagePools.body.map((pool) => pool.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(stagePools.body.map((pool) => Number(pool.requiredTeamCount))).toEqual([4, 4, 3, 3]);
  });

  test('14-team crossover generation keeps all crossover matches in a single facility', async () => {
    const tournament = await createOwnedTournament('crossover-facility');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_14_ID,
        activeCourts: ['SRC-1', 'SRC-2', 'VC-1', 'VC-2'],
      });

    expect(apply.statusCode).toBe(200);

    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
        { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
        { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
        { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
      ].map((poolEntry) => ({
        updateOne: {
          filter: {
            tournamentId: tournament._id,
            phase: 'phase1',
            name: poolEntry.name,
          },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: poolEntry.teamIds.length,
              teamIds: poolEntry.teamIds,
              homeCourt: poolEntry.homeCourt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const phase1Generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());

    expect(phase1Generate.statusCode).toBe(201);
    expect(phase1Generate.body).toHaveLength(18);

    const crossoverGenerate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/crossover/matches/generate`)
      .set(authHeader());

    expect(crossoverGenerate.statusCode).toBe(201);
    expect(crossoverGenerate.body).toHaveLength(3);

    const facilities = Array.from(
      new Set(crossoverGenerate.body.map((match) => String(match.facility || '')))
    );
    expect(facilities).toEqual(['VC']);
    expect(
      crossoverGenerate.body.every((match) => typeof match.courtId === 'string' && match.courtId)
    ).toBe(true);
    expect(
      crossoverGenerate.body.every((match) => typeof match.facilityId === 'string' && match.facilityId)
    ).toBe(true);
    expect(
      crossoverGenerate.body.every((match) => String(match.court || '').startsWith('VC-'))
    ).toBe(true);
    const crossoverRoundBlocks = crossoverGenerate.body
      .map((match) => Number(match.roundBlock))
      .sort((left, right) => left - right);
    expect(crossoverRoundBlocks).toEqual([4, 4, 5]);

    const crossoverList = await request(app)
      .get(`/api/tournaments/${tournament._id}/stages/crossover/matches`)
      .set(authHeader());

    expect(crossoverList.statusCode).toBe(200);
    expect(crossoverList.body).toHaveLength(3);
  });

  test('14-team playoffs payload includes Gold and Silver only', async () => {
    const tournament = await createOwnedTournament('playoffs-14');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_14_ID,
      });

    expect(apply.statusCode).toBe(200);

    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
        { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
        { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
        { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
      ].map((poolEntry) => ({
        updateOne: {
          filter: {
            tournamentId: tournament._id,
            phase: 'phase1',
            name: poolEntry.name,
          },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: poolEntry.teamIds.length,
              teamIds: poolEntry.teamIds,
              homeCourt: poolEntry.homeCourt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const phase1Generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(phase1Generate.statusCode).toBe(201);

    const playoffsGenerate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/playoffs/matches/generate`)
      .set(authHeader());
    expect(playoffsGenerate.statusCode).toBe(201);
    const generatedMatches = Array.isArray(playoffsGenerate.body) ? playoffsGenerate.body : [];
    const playoffMatchesPerRoundBlock = generatedMatches.reduce((lookup, match) => {
      const roundBlock = Number(match?.roundBlock);
      if (!Number.isFinite(roundBlock)) {
        return lookup;
      }

      const key = Math.floor(roundBlock);
      lookup[key] = (lookup[key] || 0) + 1;
      return lookup;
    }, {});
    const maxConcurrentMatches = Object.values(playoffMatchesPerRoundBlock).reduce(
      (maxValue, count) => Math.max(maxValue, Number(count) || 0),
      0
    );
    expect(maxConcurrentMatches).toBeLessThanOrEqual(4);

    const playoffs = await request(app)
      .get(`/api/tournaments/${tournament._id}/playoffs`)
      .set(authHeader());

    expect(playoffs.statusCode).toBe(200);
    const bracketOrder = Array.isArray(playoffs.body.bracketOrder) ? playoffs.body.bracketOrder : [];
    expect(bracketOrder).toEqual(expect.arrayContaining(['gold', 'silver']));
    expect(bracketOrder).not.toContain('bronze');
  });

  test('16-team playoffs payload uses single all bracket with R1-R4', async () => {
    const tournament = await createOwnedTournament('playoffs-16');
    const teams = await seedTeams(tournament._id, 16);
    const teamIds = teams.map((team) => team._id);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_16_ID,
      });

    expect(apply.statusCode).toBe(200);

    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
        { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
        { name: 'C', teamIds: teamIds.slice(8, 12), homeCourt: 'SRC-3' },
        { name: 'D', teamIds: teamIds.slice(12, 16), homeCourt: 'VC-1' },
      ].map((poolEntry) => ({
        updateOne: {
          filter: {
            tournamentId: tournament._id,
            phase: 'phase1',
            name: poolEntry.name,
          },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: 4,
              teamIds: poolEntry.teamIds,
              homeCourt: poolEntry.homeCourt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const phase1Generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(phase1Generate.statusCode).toBe(201);

    const playoffsGenerate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/playoffs/matches/generate`)
      .set(authHeader());
    expect(playoffsGenerate.statusCode).toBe(201);

    const playoffs = await request(app)
      .get(`/api/tournaments/${tournament._id}/playoffs`)
      .set(authHeader());

    expect(playoffs.statusCode).toBe(200);
    expect(playoffs.body.bracketOrder).toEqual(['all']);
    expect(playoffs.body.brackets?.all?.roundOrder).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  test('ODU 15-team stage endpoints preserve legacy phase1/phase2/playoff structure', async () => {
    const tournament = await createOwnedTournament('odu');
    const teams = await seedTeams(tournament._id, 15);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_15_ID,
      });

    expect(apply.statusCode).toBe(200);
    expect(apply.body.pools).toHaveLength(5);

    const teamIds = teams.map((team) => team._id);

    await Pool.bulkWrite(
      PHASE1_POOL_NAMES.map((poolName, index) => ({
        updateOne: {
          filter: {
            tournamentId: tournament._id,
            phase: 'phase1',
            name: poolName,
          },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: 3,
              teamIds: teamIds.slice(index * 3, index * 3 + 3),
              homeCourt: PHASE1_HOME_COURTS[poolName],
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    await Pool.bulkWrite(
      PHASE2_POOL_NAMES.map((poolName, index) => ({
        updateOne: {
          filter: {
            tournamentId: tournament._id,
            phase: 'phase2',
            name: poolName,
          },
          update: {
            $set: {
              stageKey: 'poolPlay2',
              requiredTeamCount: 3,
              teamIds: teamIds.slice(index * 3, index * 3 + 3),
              homeCourt: PHASE2_HOME_COURTS[poolName],
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const phase1Generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    const phase2Generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay2/matches/generate`)
      .set(authHeader());

    expect(phase1Generate.statusCode).toBe(201);
    expect(phase1Generate.body).toHaveLength(15);
    expect(phase2Generate.statusCode).toBe(201);
    expect(phase2Generate.body).toHaveLength(15);

    await Tournament.updateOne(
      { _id: tournament._id },
      {
        $set: {
          'standingsOverrides.phase2.overallOrderOverrides': teamIds,
        },
      }
    );

    const playoffsGenerate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/playoffs/matches/generate`)
      .set(authHeader());

    expect(playoffsGenerate.statusCode).toBe(201);
    expect(playoffsGenerate.body.matches).toHaveLength(12);
    expect(playoffsGenerate.body.matches.some((match) => match.bracketMatchKey === 'gold:R1:4v5')).toBe(true);

    const [phase1Count, phase2Count, playoffCount] = await Promise.all([
      Match.countDocuments({ tournamentId: tournament._id, phase: 'phase1' }),
      Match.countDocuments({ tournamentId: tournament._id, phase: 'phase2' }),
      Match.countDocuments({ tournamentId: tournament._id, phase: 'playoffs' }),
    ]);

    expect(phase1Count).toBe(15);
    expect(phase2Count).toBe(15);
    expect(playoffCount).toBe(12);
  });

  // ── PR12 regression tests ────────────────────────────────────────────────

  async function applyFormatAndSeedPools(tournament, teams, poolAssignments) {
    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({ formatId: FORMAT_14_ID });
    expect(apply.statusCode).toBe(200);

    await Pool.bulkWrite(
      poolAssignments.map((entry) => ({
        updateOne: {
          filter: { tournamentId: tournament._id, phase: 'phase1', name: entry.name },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: entry.teamIds.length,
              teamIds: entry.teamIds,
              homeCourt: entry.homeCourt,
              ...(entry.assignedCourtId ? { assignedCourtId: entry.assignedCourtId } : {}),
              ...(entry.assignedFacilityId
                ? { assignedFacilityId: entry.assignedFacilityId }
                : {}),
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );
  }

  test('init pools is idempotent — does not clear teamIds on second call', async () => {
    const tournament = await createOwnedTournament('init-idempotent');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    await applyFormatAndSeedPools(tournament, teams, [
      { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
      { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
      { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
      { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
    ]);

    // Second init call without ?force=true should preserve teamIds
    const secondInit = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/init`)
      .set(authHeader());

    expect(secondInit.statusCode).toBe(200);
    const poolA = secondInit.body.find((p) => p.name === 'A');
    expect(poolA.teamIds).toHaveLength(4);
  });

  test('init pools with ?force=true clears teamIds', async () => {
    const tournament = await createOwnedTournament('init-force');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    await applyFormatAndSeedPools(tournament, teams, [
      { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
      { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
      { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
      { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
    ]);

    const forceInit = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/init?force=true`)
      .set(authHeader());

    expect(forceInit.statusCode).toBe(200);
    expect(forceInit.body.every((p) => Array.isArray(p.teamIds) && p.teamIds.length === 0)).toBe(true);
  });

  test('3-team RR generates exact match order: 1v3, 2v3, 1v2 with correct refs', async () => {
    const tournament = await createOwnedTournament('rr3');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id.toString());

    await applyFormatAndSeedPools(tournament, teams, [
      { name: 'A', teamIds: teams.slice(0, 4).map((t) => t._id), homeCourt: 'SRC-1' },
      { name: 'B', teamIds: teams.slice(4, 8).map((t) => t._id), homeCourt: 'SRC-2' },
      // Pool C is 3-team pool (positions 0=C1, 1=C2, 2=C3)
      { name: 'C', teamIds: teams.slice(8, 11).map((t) => t._id), homeCourt: 'VC-1' },
      { name: 'D', teamIds: teams.slice(11, 14).map((t) => t._id), homeCourt: 'VC-2' },
    ]);

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());

    expect(generate.statusCode).toBe(201);

    // Filter to Pool C matches only (3-team pool)
    const poolCMatches = generate.body
      .filter((m) => m.poolName === 'C')
      .sort((a, b) => a.roundBlock - b.roundBlock);

    expect(poolCMatches).toHaveLength(3);

    const c1 = teamIds[8];
    const c2 = teamIds[9];
    const c3 = teamIds[10];

    // Match 1: 1v3 (c1 vs c3), ref = c2
    expect(poolCMatches[0].teamAId).toBe(c1);
    expect(poolCMatches[0].teamBId).toBe(c3);
    expect(poolCMatches[0].refTeamIds).toEqual([c2]);

    // Match 2: 2v3 (c2 vs c3), ref = c1
    expect(poolCMatches[1].teamAId).toBe(c2);
    expect(poolCMatches[1].teamBId).toBe(c3);
    expect(poolCMatches[1].refTeamIds).toEqual([c1]);

    // Match 3: 1v2 (c1 vs c2), ref = c3
    expect(poolCMatches[2].teamAId).toBe(c1);
    expect(poolCMatches[2].teamBId).toBe(c2);
    expect(poolCMatches[2].refTeamIds).toEqual([c3]);
  });

  test('4-team RR generates exact match order with correct refs and byeTeamIds', async () => {
    const FORMAT_12_ID_LOCAL = 'classic_12_3x4_gold8_silver4_v1';
    const tournament = await createOwnedTournament('rr4');
    const teams = await seedTeams(tournament._id, 12);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({ formatId: FORMAT_12_ID_LOCAL });
    expect(apply.statusCode).toBe(200);

    const poolTeams = teams.slice(0, 4); // Pool A
    const poolTeamIds = poolTeams.map((t) => t._id.toString());

    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: poolTeams.map((t) => t._id), homeCourt: 'SRC-1' },
        { name: 'B', teamIds: teams.slice(4, 8).map((t) => t._id), homeCourt: 'SRC-2' },
        { name: 'C', teamIds: teams.slice(8, 12).map((t) => t._id), homeCourt: 'SRC-3' },
      ].map((entry) => ({
        updateOne: {
          filter: { tournamentId: tournament._id, phase: 'phase1', name: entry.name },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: 4,
              teamIds: entry.teamIds,
              homeCourt: entry.homeCourt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());

    expect(generate.statusCode).toBe(201);

    const poolAMatches = generate.body
      .filter((m) => m.poolName === 'A')
      .sort((a, b) => a.roundBlock - b.roundBlock);

    expect(poolAMatches).toHaveLength(6);

    const [p1, p2, p3, p4] = poolTeamIds;

    // Spec: 1v3, ref 2, bye 4
    expect(poolAMatches[0].teamAId).toBe(p1);
    expect(poolAMatches[0].teamBId).toBe(p3);
    expect(poolAMatches[0].refTeamIds).toEqual([p2]);
    expect(poolAMatches[0].byeTeamId).toBe(p4);

    // Spec: 2v4, ref 1, bye 3
    expect(poolAMatches[1].teamAId).toBe(p2);
    expect(poolAMatches[1].teamBId).toBe(p4);
    expect(poolAMatches[1].refTeamIds).toEqual([p1]);
    expect(poolAMatches[1].byeTeamId).toBe(p3);

    // Spec: 1v4, ref 3, bye 2
    expect(poolAMatches[2].teamAId).toBe(p1);
    expect(poolAMatches[2].teamBId).toBe(p4);
    expect(poolAMatches[2].refTeamIds).toEqual([p3]);
    expect(poolAMatches[2].byeTeamId).toBe(p2);

    // Spec: 2v3, ref 1, bye 4
    expect(poolAMatches[3].teamAId).toBe(p2);
    expect(poolAMatches[3].teamBId).toBe(p3);
    expect(poolAMatches[3].refTeamIds).toEqual([p1]);
    expect(poolAMatches[3].byeTeamId).toBe(p4);

    // Spec: 3v4, ref 2, bye 1
    expect(poolAMatches[4].teamAId).toBe(p3);
    expect(poolAMatches[4].teamBId).toBe(p4);
    expect(poolAMatches[4].refTeamIds).toEqual([p2]);
    expect(poolAMatches[4].byeTeamId).toBe(p1);

    // Spec: 1v2, ref 4, bye 3
    expect(poolAMatches[5].teamAId).toBe(p1);
    expect(poolAMatches[5].teamBId).toBe(p2);
    expect(poolAMatches[5].refTeamIds).toEqual([p4]);
    expect(poolAMatches[5].byeTeamId).toBe(p3);
  });

  test('crossover with >= 2 courts schedules matches 0+1 concurrently, match 2 in next block', async () => {
    const tournament = await createOwnedTournament('crossover-concurrent');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    await applyFormatAndSeedPools(tournament, teams, [
      { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
      { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
      { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
      { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
    ]);

    const phase1 = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(phase1.statusCode).toBe(201);

    // activeCourts has 4 courts (VC-1 and VC-2 both active) → courtsForCrossover.length >= 2
    const crossover = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/crossover/matches/generate`)
      .set(authHeader());

    expect(crossover.statusCode).toBe(201);
    expect(crossover.body).toHaveLength(3);

    const roundBlocks = crossover.body.map((m) => m.roundBlock).sort((a, b) => a - b);
    // With 2 VC courts: M0 and M1 share same block, M2 is next block
    expect(roundBlocks).toEqual([4, 4, 5]);
  });

  test('crossover with 1 court schedules matches sequentially', async () => {
    const tournament = await createOwnedTournament('crossover-sequential');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    // Start with unique pool courts so pool-play generation succeeds.
    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_14_ID,
        activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
      });
    expect(apply.statusCode).toBe(200);

    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
        { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
        // C on VC-1, D on SRC-3: unique courts, source pools split between facilities
        { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
        { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'SRC-3' },
      ].map((entry) => ({
        updateOne: {
          filter: { tournamentId: tournament._id, phase: 'phase1', name: entry.name },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: entry.teamIds.length,
              teamIds: entry.teamIds,
              homeCourt: entry.homeCourt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const phase1 = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(phase1.statusCode).toBe(201);

    // Force source pools C and D onto the same court after pool-play generation.
    const poolC = await Pool.findOne({
      tournamentId: tournament._id,
      phase: 'phase1',
      name: 'C',
    }).lean();
    expect(poolC?.assignedCourtId).toBeTruthy();

    await Pool.updateOne(
      { tournamentId: tournament._id, phase: 'phase1', name: 'D' },
      {
        $set: {
          assignedCourtId: poolC.assignedCourtId,
          assignedFacilityId: poolC.assignedFacilityId || null,
          homeCourt: poolC.homeCourt || 'VC-1',
        },
      }
    );

    // With one effective crossover court, matches should be sequential.
    const crossover = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/crossover/matches/generate`)
      .set(authHeader());

    expect(crossover.statusCode).toBe(201);
    expect(crossover.body).toHaveLength(3);

    const roundBlocks = crossover.body.map((m) => m.roundBlock).sort((a, b) => a - b);
    // All three should have distinct round blocks (sequential)
    expect(roundBlocks).toEqual([4, 5, 6]);
  });

  test('crossover uses source pool assigned courts when court names are non-legacy', async () => {
    const tournament = await createOwnedTournament('crossover-source-courts');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: FORMAT_14_ID,
        totalCourts: 4,
      });
    expect(apply.statusCode).toBe(200);

    const venueGet = await request(app)
      .get(`/api/tournaments/${tournament._id}/venue`)
      .set(authHeader());
    expect(venueGet.statusCode).toBe(200);

    const baseFacility = venueGet.body?.venue?.facilities?.[0];
    const baseCourts = Array.isArray(baseFacility?.courts) ? baseFacility.courts : [];
    expect(baseCourts.length).toBeGreaterThanOrEqual(4);

    const renamedFacility = {
      facilityId: baseFacility.facilityId,
      name: 'Main Venue',
      courts: baseCourts.slice(0, 4).map((court, index) => ({
        courtId: court.courtId,
        name: `East ${index + 1}`,
        isEnabled: true,
      })),
    };

    const venuePut = await request(app)
      .put(`/api/tournaments/${tournament._id}/venue`)
      .set(authHeader())
      .send({
        facilities: [renamedFacility],
      });
    expect(venuePut.statusCode).toBe(200);

    const renamedCourts = venuePut.body?.venue?.facilities?.[0]?.courts || [];
    const [courtA, courtB, courtC, courtD] = renamedCourts;
    expect(courtA?.courtId).toBeTruthy();
    expect(courtB?.courtId).toBeTruthy();
    expect(courtC?.courtId).toBeTruthy();
    expect(courtD?.courtId).toBeTruthy();

    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: teamIds.slice(0, 4), court: courtA },
        { name: 'B', teamIds: teamIds.slice(4, 8), court: courtB },
        { name: 'C', teamIds: teamIds.slice(8, 11), court: courtC },
        { name: 'D', teamIds: teamIds.slice(11, 14), court: courtD },
      ].map((entry) => ({
        updateOne: {
          filter: { tournamentId: tournament._id, phase: 'phase1', name: entry.name },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: entry.teamIds.length,
              teamIds: entry.teamIds,
              homeCourt: entry.court.name,
              assignedCourtId: entry.court.courtId,
              assignedFacilityId: renamedFacility.facilityId,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const phase1 = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(phase1.statusCode).toBe(201);

    const crossover = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/crossover/matches/generate`)
      .set(authHeader());
    expect(crossover.statusCode).toBe(201);
    expect(crossover.body).toHaveLength(3);

    const usedCourtIds = Array.from(
      new Set(
        crossover.body.map((match) => String(match?.courtId || '')).filter(Boolean)
      )
    );
    expect(usedCourtIds).toEqual(expect.arrayContaining([courtC.courtId, courtD.courtId]));
    expect(usedCourtIds).not.toContain(courtA.courtId);
    expect(usedCourtIds).not.toContain(courtB.courtId);

    const roundBlocks = crossover.body.map((match) => Number(match?.roundBlock)).sort((a, b) => a - b);
    expect(roundBlocks).toEqual([4, 4, 5]);
  });

  test('crossover assigns correct refs per match template', async () => {
    const tournament = await createOwnedTournament('crossover-refs');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    await applyFormatAndSeedPools(tournament, teams, [
      { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
      { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-2' },
      { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
      { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
    ]);

    const phase1 = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(phase1.statusCode).toBe(201);

    const crossover = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/crossover/matches/generate`)
      .set(authHeader());

    expect(crossover.statusCode).toBe(201);
    const matches = crossover.body.sort((a, b) => {
      // Sort by round block first, then by court to get consistent order
      if (a.roundBlock !== b.roundBlock) return a.roundBlock - b.roundBlock;
      return String(a.court || '').localeCompare(String(b.court || ''));
    });

    // Get standings to know who ranks where in pools C and D
    const standings = await request(app)
      .get(`/api/tournaments/${tournament._id}/standings?phase=phase1`)
      .set(authHeader());
    expect(standings.statusCode).toBe(200);

    const poolC = standings.body.pools?.find((p) => p.poolName === 'C');
    const poolD = standings.body.pools?.find((p) => p.poolName === 'D');

    const c1 = poolC?.teams[0]?.teamId?.toString();
    const c2 = poolC?.teams[1]?.teamId?.toString();
    const c3 = poolC?.teams[2]?.teamId?.toString();
    const d2 = poolD?.teams[1]?.teamId?.toString();
    const d3 = poolD?.teams[2]?.teamId?.toString();

    // Match 0 (C#1 vs D#1): ref = C#3 (leftTeams[2])
    const m0 = matches.find((m) => m.teamAId === c1 || m.teamBId === c1);
    expect(m0?.refTeamIds?.[0]).toBe(c3);

    // Match 1 (C#2 vs D#2): ref = D#3 (rightTeams[2])
    const m1 = matches.find((m) => m.teamAId === c2 || m.teamBId === c2);
    if (m1 && d3) {
      expect(m1.refTeamIds?.[0]).toBe(d3);
    }

    // Match 2 (C#3 vs D#3): ref = D#2 (rightTeams[1])
    const m2 = matches.find((m) => m.teamAId === c3 || m.teamBId === c3);
    if (m2 && d2) {
      expect(m2.refTeamIds?.[0]).toBe(d2);
    }
  });

  test('court conflict on same pool home court returns 400 on match generate', async () => {
    const tournament = await createOwnedTournament('court-conflict');
    const teams = await seedTeams(tournament._id, 14);
    const teamIds = teams.map((team) => team._id);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({ formatId: FORMAT_14_ID });
    expect(apply.statusCode).toBe(200);

    // Assign SAME court to pools A and B
    await Pool.bulkWrite(
      [
        { name: 'A', teamIds: teamIds.slice(0, 4), homeCourt: 'SRC-1' },
        { name: 'B', teamIds: teamIds.slice(4, 8), homeCourt: 'SRC-1' }, // same court!
        { name: 'C', teamIds: teamIds.slice(8, 11), homeCourt: 'VC-1' },
        { name: 'D', teamIds: teamIds.slice(11, 14), homeCourt: 'VC-2' },
      ].map((entry) => ({
        updateOne: {
          filter: { tournamentId: tournament._id, phase: 'phase1', name: entry.name },
          update: {
            $set: {
              stageKey: 'poolPlay1',
              requiredTeamCount: entry.teamIds.length,
              teamIds: entry.teamIds,
              homeCourt: entry.homeCourt,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());

    expect(generate.statusCode).toBe(400);
    expect(generate.body.message).toMatch(/share the same court/i);
  });
});
