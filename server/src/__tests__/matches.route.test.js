const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const matchRoutes = require('../routes/matches');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const User = require('../models/User');

describe('match lifecycle routes', () => {
  let mongo;
  let app;
  let user;
  let token;
  let ioEmitMock;
  let ioToMock;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'matches-route-tests',
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

    ioEmitMock = jest.fn();
    ioToMock = jest.fn(() => ({ emit: ioEmitMock }));

    app = express();
    app.use(express.json());
    app.set('io', { to: ioToMock });
    app.use('/api/matches', matchRoutes);
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

  async function createContext({
    status = 'scheduled',
    scoreboardSets = [
      [25, 22],
      [25, 20],
    ],
    startedAt = null,
    endedAt = null,
  } = {}) {
    const tournament = await Tournament.create({
      name: 'Lifecycle Tournament',
      date: new Date('2026-10-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'LCY001',
      createdByUserId: user._id,
    });

    const [teamA, teamB] = await TournamentTeam.insertMany(
      [
        {
          tournamentId: tournament._id,
          name: 'Alpha',
          shortName: 'ALP',
        },
        {
          tournamentId: tournament._id,
          name: 'Bravo',
          shortName: 'BRV',
        },
      ],
      { ordered: true }
    );

    const scoreboard = await Scoreboard.create({
      owner: user._id,
      title: 'ALP vs BRV',
      teams: [
        { name: 'ALP', score: 0 },
        { name: 'BRV', score: 0 },
      ],
      sets: scoreboardSets.map((scores) => ({ scores })),
      servingTeamIndex: null,
    });

    const match = await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      poolId: null,
      roundBlock: 1,
      facility: 'SRC',
      court: 'SRC-1',
      teamAId: teamA._id,
      teamBId: teamB._id,
      refTeamIds: [],
      scoreboardId: scoreboard._id,
      status,
      startedAt,
      endedAt,
    });

    return { tournament, match };
  }

  test('POST /api/matches/:matchId/start sets live status + startedAt and clears endedAt', async () => {
    const { tournament, match } = await createContext({
      status: 'scheduled',
      endedAt: new Date('2026-10-01T13:00:00.000Z'),
    });

    const response = await request(app)
      .post(`/api/matches/${match._id}/start`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('live');
    expect(response.body.startedAt).toBeTruthy();
    expect(response.body.endedAt).toBeNull();

    const stored = await Match.findById(match._id).lean();
    expect(stored.status).toBe('live');
    expect(stored.startedAt).toBeTruthy();
    expect(stored.endedAt).toBeNull();

    const statusCall = ioEmitMock.mock.calls.find(
      ([eventName, payload]) =>
        eventName === 'tournament:event' && payload?.type === 'MATCH_STATUS_UPDATED'
    );
    expect(ioToMock).toHaveBeenCalledWith(`tournament:${tournament.publicCode}`);
    expect(statusCall?.[1]?.data).toEqual(
      expect.objectContaining({
        matchId: match._id.toString(),
        status: 'live',
        startedAt: expect.any(Date),
        endedAt: null,
      })
    );
  });

  test('POST /api/matches/:matchId/end sets ended status + endedAt', async () => {
    const startedAt = new Date('2026-10-01T12:00:00.000Z');
    const { tournament, match } = await createContext({
      status: 'live',
      startedAt,
    });

    const response = await request(app)
      .post(`/api/matches/${match._id}/end`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('ended');
    expect(response.body.startedAt).toBeTruthy();
    expect(response.body.endedAt).toBeTruthy();

    const stored = await Match.findById(match._id).lean();
    expect(stored.status).toBe('ended');
    expect(stored.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(stored.endedAt).toBeTruthy();

    const statusCall = ioEmitMock.mock.calls.find(
      ([eventName, payload]) =>
        eventName === 'tournament:event' && payload?.type === 'MATCH_STATUS_UPDATED'
    );
    expect(ioToMock).toHaveBeenCalledWith(`tournament:${tournament.publicCode}`);
    expect(statusCall?.[1]?.data).toEqual(
      expect.objectContaining({
        matchId: match._id.toString(),
        status: 'ended',
        startedAt: expect.any(Date),
        endedAt: expect.any(Date),
      })
    );
  });

  test('POST /api/matches/:matchId/finalize blocks non-ended match by default', async () => {
    const { match } = await createContext({
      status: 'scheduled',
      scoreboardSets: [
        [25, 20],
        [25, 21],
      ],
    });

    const response = await request(app)
      .post(`/api/matches/${match._id}/finalize`)
      .set(authHeader());

    expect(response.statusCode).toBe(409);
    expect(response.body.message).toMatch(/ended/i);
  });

  test('POST /api/matches/:matchId/finalize allows ended + complete scoreboard', async () => {
    const startedAt = new Date('2026-10-01T12:00:00.000Z');
    const endedAt = new Date('2026-10-01T12:30:00.000Z');
    const { match } = await createContext({
      status: 'ended',
      startedAt,
      endedAt,
      scoreboardSets: [
        [25, 20],
        [25, 21],
      ],
    });

    const response = await request(app)
      .post(`/api/matches/${match._id}/finalize`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('final');
    expect(response.body.result).toEqual(
      expect.objectContaining({
        setsWonA: 2,
        setsWonB: 0,
      })
    );
  });

  test('POST /api/matches/:matchId/finalize allows override when scoreboard is complete', async () => {
    const { match } = await createContext({
      status: 'scheduled',
      scoreboardSets: [
        [22, 25],
        [25, 20],
        [15, 10],
      ],
    });

    const response = await request(app)
      .post(`/api/matches/${match._id}/finalize?override=true`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('final');
    expect(response.body.endedAt).toBeTruthy();
  });

  test('POST /api/matches/:matchId/finalize blocks override when scoreboard is incomplete', async () => {
    const { match } = await createContext({
      status: 'scheduled',
      scoreboardSets: [
        [25, 23],
        [20, 25],
      ],
    });

    const response = await request(app)
      .post(`/api/matches/${match._id}/finalize?override=true`)
      .set(authHeader());

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/completed best-of-3/i);
  });
});
