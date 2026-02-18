const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const User = require('../models/User');
const Match = require('../models/Match');
const Pool = require('../models/Pool');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');

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

const PHASE2_ALT_HOME_COURTS = {
  F: 'VC-2',
  G: 'SRC-3',
  H: 'VC-1',
  I: 'SRC-1',
  J: 'SRC-2',
};

const PHASE2_MAPPING = {
  F: ['A1', 'B2', 'C3'],
  G: ['B1', 'C2', 'D3'],
  H: ['C1', 'D2', 'E3'],
  I: ['D1', 'E2', 'A3'],
  J: ['E1', 'A2', 'B3'],
};

describe('phase2 generation + standings routes', () => {
  let mongo;
  let app;
  let user;
  let token;
  let tournamentCodeCounter = 1;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'phase2-route-tests',
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

  async function createOwnedTournament() {
    const suffix = String(tournamentCodeCounter).padStart(5, '0');
    tournamentCodeCounter += 1;

    return Tournament.create({
      name: `PR4 Tournament ${suffix}`,
      date: new Date('2026-08-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: `Q${suffix}`,
      createdByUserId: user._id,
    });
  }

  async function seedPhase1PoolsWithLabeledTeams(tournamentId) {
    const teamPayload = [];

    ['A', 'B', 'C', 'D', 'E'].forEach((poolName) => {
      [1, 2, 3].forEach((placement) => {
        const label = `${poolName}${placement}`;
        teamPayload.push({
          tournamentId,
          name: label,
          shortName: label,
          seed: teamPayload.length + 1,
        });
      });
    });

    const teams = await TournamentTeam.insertMany(teamPayload, { ordered: true });
    const teamByLabel = Object.fromEntries(
      teams.map((team) => [team.name, team])
    );

    await Pool.insertMany(
      ['A', 'B', 'C', 'D', 'E'].map((poolName) => ({
        tournamentId,
        phase: 'phase1',
        name: poolName,
        homeCourt: PHASE1_HOME_COURTS[poolName],
        teamIds: [teamByLabel[`${poolName}1`]._id, teamByLabel[`${poolName}2`]._id, teamByLabel[`${poolName}3`]._id],
      })),
      { ordered: true }
    );

    return teamByLabel;
  }

  async function setFullPhase1PoolOverrides(tournamentId, teamByLabel) {
    const poolOrderOverrides = {};

    ['A', 'B', 'C', 'D', 'E'].forEach((poolName) => {
      poolOrderOverrides[poolName] = [
        teamByLabel[`${poolName}1`]._id,
        teamByLabel[`${poolName}2`]._id,
        teamByLabel[`${poolName}3`]._id,
      ];
    });

    await Tournament.updateOne(
      { _id: tournamentId },
      {
        $set: {
          'standingsOverrides.phase1.poolOrderOverrides': poolOrderOverrides,
        },
      }
    );
  }

  function buildFinalResult({ winnerTeamId, loserTeamId }) {
    return {
      winnerTeamId,
      loserTeamId,
      setsWonA: 2,
      setsWonB: 0,
      setsPlayed: 2,
      pointsForA: 50,
      pointsAgainstA: 30,
      pointsForB: 30,
      pointsAgainstB: 50,
      setScores: [
        { setNo: 1, a: 25, b: 15 },
        { setNo: 2, a: 25, b: 15 },
      ],
    };
  }

  test('phase2 pool generation fails when phase1 is not finalized and overrides are missing', async () => {
    const tournament = await createOwnedTournament();
    await seedPhase1PoolsWithLabeledTeams(tournament._id);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase2/pools/generate`)
      .set(authHeader());

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/cannot be generated/i);
    expect(Array.isArray(response.body.missing)).toBe(true);
    expect(response.body.missing.some((entry) => /phase 1 has/i.test(entry))).toBe(true);
  });

  test('phase2 pool generation applies the required A1..E3 mapping when placements are resolved', async () => {
    const tournament = await createOwnedTournament();
    const teamByLabel = await seedPhase1PoolsWithLabeledTeams(tournament._id);
    await setFullPhase1PoolOverrides(tournament._id, teamByLabel);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase2/pools/generate`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.source).toBe('overrides');
    expect(response.body.pools).toHaveLength(5);

    const byName = Object.fromEntries(response.body.pools.map((pool) => [pool.name, pool]));

    Object.entries(PHASE2_MAPPING).forEach(([poolName, labels]) => {
      const expectedTeamIds = labels.map((label) => teamByLabel[label]._id.toString());
      const actualTeamIds = byName[poolName].teamIds.map((team) => String(team._id));

      expect(actualTeamIds).toEqual(expectedTeamIds);
      expect(byName[poolName].homeCourt).toBe(PHASE2_HOME_COURTS[poolName]);
      expect(byName[poolName].rematchWarnings).toEqual([]);
    });
  });

  test('phase2 rematch avoidance swaps deterministically when a lower-tier solution exists', async () => {
    const tournament = await createOwnedTournament();
    const teamByLabel = await seedPhase1PoolsWithLabeledTeams(tournament._id);
    await setFullPhase1PoolOverrides(tournament._id, teamByLabel);

    await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      poolId: null,
      roundBlock: 1,
      facility: 'SRC',
      court: 'SRC-1',
      teamAId: teamByLabel.A1._id,
      teamBId: teamByLabel.C3._id,
      refTeamIds: [],
      status: 'final',
      result: buildFinalResult({
        winnerTeamId: teamByLabel.A1._id,
        loserTeamId: teamByLabel.C3._id,
      }),
      finalizedAt: new Date(),
      finalizedBy: user._id,
    });

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase2/pools/generate`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);

    const byName = Object.fromEntries(response.body.pools.map((pool) => [pool.name, pool]));
    const poolFIds = byName.F.teamIds.map((team) => String(team._id));
    const poolGIds = byName.G.teamIds.map((team) => String(team._id));

    expect(poolFIds).toEqual([
      teamByLabel.A1._id.toString(),
      teamByLabel.B2._id.toString(),
      teamByLabel.D3._id.toString(),
    ]);
    expect(poolGIds).toEqual([
      teamByLabel.B1._id.toString(),
      teamByLabel.C2._id.toString(),
      teamByLabel.C3._id.toString(),
    ]);
    expect(byName.F.rematchWarnings).toEqual([]);
  });

  test('phase2 match generation creates 15 matches and 15 scoreboards on rounds 4-6 using pool home courts', async () => {
    const tournament = await createOwnedTournament();
    const teamByLabel = await seedPhase1PoolsWithLabeledTeams(tournament._id);
    await setFullPhase1PoolOverrides(tournament._id, teamByLabel);

    const generatePools = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase2/pools/generate`)
      .set(authHeader());

    expect(generatePools.statusCode).toBe(200);

    const customCourtAssignments = generatePools.body.pools.map((pool) => ({
      poolId: pool._id,
      homeCourt: PHASE2_ALT_HOME_COURTS[pool.name],
    }));

    const assign = await request(app)
      .put(`/api/tournaments/${tournament._id}/pools/courts`)
      .set(authHeader())
      .send({
        phase: 'phase2',
        assignments: customCourtAssignments,
      });

    expect(assign.statusCode).toBe(200);

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/generate/phase2`)
      .set(authHeader());

    expect(generate.statusCode).toBe(201);
    expect(generate.body).toHaveLength(15);
    expect(generate.body.every((match) => Boolean(match.scoreboardId))).toBe(true);

    const [matchCount, scoreboardCount, matches] = await Promise.all([
      Match.countDocuments({ tournamentId: tournament._id, phase: 'phase2' }),
      Scoreboard.countDocuments({ owner: user._id }),
      Match.find({ tournamentId: tournament._id, phase: 'phase2' })
        .select('poolId roundBlock court refTeamIds scoreboardId')
        .populate('poolId', 'name')
        .lean(),
    ]);

    expect(matchCount).toBe(15);
    expect(scoreboardCount).toBe(15);
    expect(matches.every((match) => Boolean(match.scoreboardId))).toBe(true);
    expect(matches.every((match) => Array.isArray(match.refTeamIds) && match.refTeamIds.length === 1)).toBe(
      true
    );

    matches.forEach((match) => {
      expect(match.roundBlock).toBeGreaterThanOrEqual(4);
      expect(match.roundBlock).toBeLessThanOrEqual(6);
      expect(PHASE2_ALT_HOME_COURTS[match.poolId?.name]).toBe(match.court);
    });
  });

  test('cumulative standings include finalized phase1 and phase2 matches together', async () => {
    const tournament = await createOwnedTournament();
    const [alpha, bravo, charlie] = await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'Alpha', shortName: 'ALP', seed: 1 },
        { tournamentId: tournament._id, name: 'Bravo', shortName: 'BRV', seed: 2 },
        { tournamentId: tournament._id, name: 'Charlie', shortName: 'CHR', seed: 3 },
      ],
      { ordered: true }
    );

    await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          poolId: null,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-1',
          teamAId: alpha._id,
          teamBId: bravo._id,
          refTeamIds: [],
          status: 'final',
          result: buildFinalResult({
            winnerTeamId: alpha._id,
            loserTeamId: bravo._id,
          }),
          finalizedAt: new Date(),
          finalizedBy: user._id,
        },
        {
          tournamentId: tournament._id,
          phase: 'phase2',
          poolId: null,
          roundBlock: 4,
          facility: 'SRC',
          court: 'SRC-2',
          teamAId: alpha._id,
          teamBId: charlie._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: charlie._id,
            loserTeamId: alpha._id,
            setsWonA: 0,
            setsWonB: 2,
            setsPlayed: 2,
            pointsForA: 28,
            pointsAgainstA: 50,
            pointsForB: 50,
            pointsAgainstB: 28,
            setScores: [
              { setNo: 1, a: 14, b: 25 },
              { setNo: 2, a: 14, b: 25 },
            ],
          },
          finalizedAt: new Date(),
          finalizedBy: user._id,
        },
      ],
      { ordered: true }
    );

    const response = await request(app)
      .get(`/api/tournaments/${tournament._id}/standings?phase=cumulative`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.phase).toBe('cumulative');

    const byTeamId = Object.fromEntries(
      response.body.overall.map((team) => [team.teamId, team])
    );

    expect(byTeamId[alpha._id.toString()]).toEqual(
      expect.objectContaining({
        matchesPlayed: 2,
        matchesWon: 1,
        matchesLost: 1,
      })
    );
    expect(byTeamId[bravo._id.toString()]).toEqual(
      expect.objectContaining({
        matchesPlayed: 1,
        matchesWon: 0,
        matchesLost: 1,
      })
    );
    expect(byTeamId[charlie._id.toString()]).toEqual(
      expect.objectContaining({
        matchesPlayed: 1,
        matchesWon: 1,
        matchesLost: 0,
      })
    );
  });
});
