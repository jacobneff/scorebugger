const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const poolRoutes = require('../routes/pools');
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const Pool = require('../models/Pool');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');

const PHASE1_HOME_COURTS = {
  A: 'SRC-1',
  B: 'SRC-2',
  C: 'SRC-3',
  D: 'VC-1',
  E: 'VC-2',
};

async function seedTournamentTeams(tournamentId, teamCount = 15) {
  const teams = Array.from({ length: teamCount }, (_, index) => ({
    tournamentId,
    name: `Team ${index + 1}`,
    shortName: `T${index + 1}`,
    orderIndex: index + 1,
    seed: index + 1,
  }));

  return TournamentTeam.insertMany(teams, { ordered: true });
}

describe('phase1 pool + match generation routes', () => {
  let mongo;
  let app;
  let user;
  let token;
  let ioToMock;
  let ioEmitMock;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'phase1-route-tests',
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
    ioEmitMock = jest.fn();
    ioToMock = jest.fn(() => ({ emit: ioEmitMock }));
    app.set('io', { to: ioToMock });
    app.use('/api/tournaments', tournamentRoutes);
    app.use('/api/pools', poolRoutes);
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
    return Tournament.create({
      name: 'PR2 Test Tournament',
      date: new Date('2026-06-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'PHS100',
      createdByUserId: user._id,
    });
  }

  test('init pools creates exactly 5 pools with fixed home-court mapping', async () => {
    const tournament = await createOwnedTournament();
    await seedTournamentTeams(tournament._id);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/init`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(5);

    const byName = Object.fromEntries(response.body.map((pool) => [pool.name, pool]));
    expect(Object.keys(byName).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);

    Object.entries(PHASE1_HOME_COURTS).forEach(([poolName, homeCourt]) => {
      expect(byName[poolName].homeCourt).toBe(homeCourt);
      expect(byName[poolName].teamIds).toHaveLength(0);
    });
  });

  test('autofill fills pools with serpentine assignments from team orderIndex', async () => {
    const tournament = await createOwnedTournament();
    const teams = await seedTournamentTeams(tournament._id);

    await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/init`)
      .set(authHeader());

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/autofill`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(5);

    const byName = Object.fromEntries(response.body.map((pool) => [pool.name, pool]));
    expect(byName.A.teamIds.map((team) => team._id)).toEqual([
      teams[0]._id.toString(),
      teams[9]._id.toString(),
      teams[10]._id.toString(),
    ]);
    expect(byName.B.teamIds.map((team) => team._id)).toEqual([
      teams[1]._id.toString(),
      teams[8]._id.toString(),
      teams[11]._id.toString(),
    ]);
    expect(byName.C.teamIds.map((team) => team._id)).toEqual([
      teams[2]._id.toString(),
      teams[7]._id.toString(),
      teams[12]._id.toString(),
    ]);
    expect(byName.D.teamIds.map((team) => team._id)).toEqual([
      teams[3]._id.toString(),
      teams[6]._id.toString(),
      teams[13]._id.toString(),
    ]);
    expect(byName.E.teamIds.map((team) => team._id)).toEqual([
      teams[4]._id.toString(),
      teams[5]._id.toString(),
      teams[14]._id.toString(),
    ]);
  });

  test('generate phase1 fails if any pool does not have exactly 3 teams', async () => {
    const tournament = await createOwnedTournament();
    await seedTournamentTeams(tournament._id);

    const init = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/init`)
      .set(authHeader());
    expect(init.statusCode).toBe(200);

    const autofill = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/autofill`)
      .set(authHeader());
    expect(autofill.statusCode).toBe(200);

    const poolA = autofill.body.find((pool) => pool.name === 'A');

    const shrinkPool = await request(app)
      .patch(`/api/pools/${poolA._id}`)
      .set(authHeader())
      .send({
        teamIds: poolA.teamIds.slice(0, 2).map((team) => team._id),
      });

    expect(shrinkPool.statusCode).toBe(200);

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/generate/phase1`)
      .set(authHeader());

    expect(generate.statusCode).toBe(400);
    expect(generate.body.message).toMatch(/exactly 3 teams/i);
  });

  test('generate phase1 creates 15 matches and 15 scoreboards with linked scoreboardId', async () => {
    const tournament = await createOwnedTournament();
    await seedTournamentTeams(tournament._id);

    await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/init`)
      .set(authHeader());
    await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/autofill`)
      .set(authHeader());

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/generate/phase1`)
      .set(authHeader());

    expect(generate.statusCode).toBe(201);
    expect(generate.body).toHaveLength(15);
    expect(generate.body.every((match) => Boolean(match.scoreboardId))).toBe(true);

    const [matchCount, scoreboardCount, matches] = await Promise.all([
      Match.countDocuments({ tournamentId: tournament._id, phase: 'phase1' }),
      Scoreboard.countDocuments({ owner: user._id }),
      Match.find({ tournamentId: tournament._id, phase: 'phase1' })
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
      expect(match.roundBlock).toBeGreaterThanOrEqual(1);
      expect(match.roundBlock).toBeLessThanOrEqual(3);

      const poolName = match.poolId?.name;
      expect(PHASE1_HOME_COURTS[poolName]).toBe(match.court);
    });
  });

  test('pool update blocks duplicate team assignments across phase1 pools', async () => {
    const tournament = await createOwnedTournament();
    await seedTournamentTeams(tournament._id);

    const init = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/init`)
      .set(authHeader());
    expect(init.statusCode).toBe(200);

    const autofill = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/autofill`)
      .set(authHeader());
    expect(autofill.statusCode).toBe(200);

    const poolA = autofill.body.find((pool) => pool.name === 'A');
    const poolB = autofill.body.find((pool) => pool.name === 'B');
    const duplicatedTeamId = poolA.teamIds[0]._id;

    const response = await request(app)
      .patch(`/api/pools/${poolB._id}`)
      .set(authHeader())
      .send({
        teamIds: [duplicatedTeamId, poolB.teamIds[1]._id, poolB.teamIds[2]._id],
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/cannot appear in multiple/i);
  });

  test('pool edit emits POOLS_UPDATED to tournament room', async () => {
    const tournament = await createOwnedTournament();
    await seedTournamentTeams(tournament._id);

    const init = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/init`)
      .set(authHeader());
    expect(init.statusCode).toBe(200);

    const autofill = await request(app)
      .post(`/api/tournaments/${tournament._id}/phase1/pools/autofill`)
      .set(authHeader());
    expect(autofill.statusCode).toBe(200);

    const poolA = autofill.body.find((pool) => pool.name === 'A');
    const reorderedTeamIds = [
      poolA.teamIds[1]._id,
      poolA.teamIds[0]._id,
      poolA.teamIds[2]._id,
    ];

    const response = await request(app)
      .patch(`/api/pools/${poolA._id}`)
      .set(authHeader())
      .send({ teamIds: reorderedTeamIds });

    expect(response.statusCode).toBe(200);

    const poolsUpdatedCall = ioEmitMock.mock.calls.find(
      ([eventName, payload]) =>
        eventName === 'tournament:event' && payload?.type === 'POOLS_UPDATED'
    );

    expect(ioToMock).toHaveBeenCalledWith(`tournament:${tournament.publicCode}`);
    expect(poolsUpdatedCall?.[1]).toEqual(
      expect.objectContaining({
        tournamentCode: tournament.publicCode,
        type: 'POOLS_UPDATED',
        data: expect.objectContaining({
          phase: 'phase1',
          poolIds: expect.arrayContaining([poolA._id]),
        }),
        ts: expect.any(Number),
      })
    );
  });
});
