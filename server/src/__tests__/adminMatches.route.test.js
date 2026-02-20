const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const adminRoutes = require('../routes/admin');
const matchRoutes = require('../routes/matches');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const User = require('../models/User');

describe('admin quick scoring routes', () => {
  let mongo;
  let app;
  let user;
  let token;
  let tournamentCodeCounter = 1;
  let ioEmitMock;
  let ioToMock;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'admin-score-tests',
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
    app.use('/api/admin', adminRoutes);
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

  async function createOwnedTournament() {
    const suffix = String(tournamentCodeCounter).padStart(5, '0');
    tournamentCodeCounter += 1;

    return Tournament.create({
      name: `Quick Score Tournament ${suffix}`,
      date: new Date('2026-10-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: `S${suffix}`,
      createdByUserId: user._id,
    });
  }

  async function createTeams(tournamentId) {
    const [teamA, teamB] = await TournamentTeam.insertMany(
      [
        {
          tournamentId,
          name: 'Alpha',
          shortName: 'ALP',
          seed: 1,
        },
        {
          tournamentId,
          name: 'Bravo',
          shortName: 'BRV',
          seed: 2,
        },
      ],
      { ordered: true }
    );

    return { teamA, teamB };
  }

  async function createMatchWithScoreboard({
    tournamentId,
    teamAId,
    teamBId,
    status = 'scheduled',
    phase = 'phase1',
    roundBlock = 1,
    court = 'SRC-2',
    facility = null,
  }) {
    const scoreboard = await Scoreboard.create({
      owner: user._id,
      title: 'ALP vs BRV',
      teams: [
        { name: 'ALP', score: 9 },
        { name: 'BRV', score: 4 },
      ],
      servingTeamIndex: 1,
      sets: [
        {
          scores: [21, 25],
          createdAt: new Date('2026-10-01T13:00:00.000Z'),
        },
      ],
    });

    const match = await Match.create({
      tournamentId,
      phase,
      poolId: null,
      roundBlock,
      facility: facility || (String(court).startsWith('VC-') ? 'VC' : 'SRC'),
      court,
      teamAId,
      teamBId,
      refTeamIds: [],
      scoreboardId: scoreboard._id,
      status,
      result:
        status === 'final'
          ? {
              winnerTeamId: teamAId,
              loserTeamId: teamBId,
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
            }
          : null,
      finalizedAt: status === 'final' ? new Date('2026-10-01T14:00:00.000Z') : null,
      finalizedBy: status === 'final' ? user._id : null,
    });

    return { match, scoreboard };
  }

  test('POST /api/admin/matches/:matchId/score applies set scores and is idempotent', async () => {
    const tournament = await createOwnedTournament();
    const { teamA, teamB } = await createTeams(tournament._id);
    const { match } = await createMatchWithScoreboard({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
    });

    const payload = {
      setScores: [
        { a: 25, b: 18 },
        { a: 22, b: 25 },
        { a: 15, b: 11 },
      ],
      applyToScoreboard: true,
      finalize: false,
    };

    const first = await request(app)
      .post(`/api/admin/matches/${match._id}/score`)
      .set(authHeader())
      .send(payload);

    expect(first.statusCode).toBe(200);
    expect(first.body.match.status).toBe('scheduled');
    expect(first.body.scoreboard.summary).toEqual({
      setsA: 2,
      setsB: 1,
      pointsA: 62,
      pointsB: 54,
    });

    const afterFirst = await Scoreboard.findById(match.scoreboardId).lean();
    expect(afterFirst.sets.map((set) => set.scores)).toEqual([
      [25, 18],
      [22, 25],
      [15, 11],
    ]);
    expect(afterFirst.teams[0].score).toBe(0);
    expect(afterFirst.teams[1].score).toBe(0);
    expect(afterFirst.servingTeamIndex).toBeNull();

    const firstCreatedAt = afterFirst.sets.map((set) => new Date(set.createdAt).toISOString());

    const second = await request(app)
      .post(`/api/admin/matches/${match._id}/score`)
      .set(authHeader())
      .send(payload);

    expect(second.statusCode).toBe(200);

    const afterSecond = await Scoreboard.findById(match.scoreboardId).lean();
    expect(afterSecond.sets.map((set) => new Date(set.createdAt).toISOString())).toEqual(firstCreatedAt);
  });

  test('POST /api/admin/matches/:matchId/score with finalize=true finalizes match', async () => {
    const tournament = await createOwnedTournament();
    const { teamA, teamB } = await createTeams(tournament._id);
    const { match } = await createMatchWithScoreboard({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      status: 'live',
    });

    const response = await request(app)
      .post(`/api/admin/matches/${match._id}/score`)
      .set(authHeader())
      .send({
        setScores: [
          { a: 25, b: 20 },
          { a: 25, b: 17 },
        ],
        applyToScoreboard: true,
        finalize: true,
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.match.status).toBe('final');
    expect(response.body.match.result).toEqual(
      expect.objectContaining({
        winnerTeamId: teamA._id.toString(),
        loserTeamId: teamB._id.toString(),
        setsWonA: 2,
        setsWonB: 0,
      })
    );

    const storedMatch = await Match.findById(match._id).lean();
    expect(storedMatch.status).toBe('final');
    expect(storedMatch.result).toBeTruthy();
    expect(storedMatch.finalizedAt).toBeTruthy();
  });

  test('POST /api/admin/matches/:matchId/score blocks editing finalized matches', async () => {
    const tournament = await createOwnedTournament();
    const { teamA, teamB } = await createTeams(tournament._id);
    const { match } = await createMatchWithScoreboard({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      status: 'final',
    });

    const response = await request(app)
      .post(`/api/admin/matches/${match._id}/score`)
      .set(authHeader())
      .send({
        setScores: [
          { a: 25, b: 22 },
          { a: 21, b: 25 },
          { a: 15, b: 11 },
        ],
        applyToScoreboard: true,
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.message).toMatch(/unfinalize first/i);
  });

  test('POST /api/admin/matches/:matchId/score rejects invalid input', async () => {
    const tournament = await createOwnedTournament();
    const { teamA, teamB } = await createTeams(tournament._id);
    const { match } = await createMatchWithScoreboard({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
    });

    const invalidSetCount = await request(app)
      .post(`/api/admin/matches/${match._id}/score`)
      .set(authHeader())
      .send({
        setScores: [{ a: 25, b: 20 }],
        applyToScoreboard: true,
      });

    expect(invalidSetCount.statusCode).toBe(400);

    const invalidFinalize = await request(app)
      .post(`/api/admin/matches/${match._id}/score`)
      .set(authHeader())
      .send({
        setScores: [
          { a: 25, b: 20 },
          { a: 20, b: 25 },
        ],
        applyToScoreboard: true,
        finalize: true,
      });

    expect(invalidFinalize.statusCode).toBe(400);
    expect(invalidFinalize.body.message).toMatch(/imply a winner/i);
  });

  test('GET /api/admin/tournaments/:id/matches/quick returns filtered quick cards', async () => {
    const tournament = await createOwnedTournament();
    const [alpha, bravo, charlie, delta] = await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'Alpha', shortName: 'ALP', seed: 1 },
        { tournamentId: tournament._id, name: 'Bravo', shortName: 'BRV', seed: 2 },
        { tournamentId: tournament._id, name: 'Charlie', shortName: 'CHR', seed: 3 },
        { tournamentId: tournament._id, name: 'Delta', shortName: 'DLT', seed: 4 },
      ],
      { ordered: true }
    );

    await createMatchWithScoreboard({
      tournamentId: tournament._id,
      teamAId: alpha._id,
      teamBId: bravo._id,
      roundBlock: 1,
      court: 'SRC-2',
    });

    await createMatchWithScoreboard({
      tournamentId: tournament._id,
      teamAId: charlie._id,
      teamBId: delta._id,
      roundBlock: 2,
      court: 'VC-1',
    });

    const response = await request(app)
      .get(`/api/admin/tournaments/${tournament._id}/matches/quick?phase=phase1&roundBlock=1&court=SRC-2`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.phase).toBe('phase1');
    expect(response.body.filters.roundBlocks.map((entry) => entry.value)).toEqual([1, 2]);
    expect(response.body.filters.courts.map((entry) => entry.code)).toEqual(['SRC-2', 'VC-1']);
    expect(response.body.matches).toHaveLength(1);
    expect(response.body.matches[0]).toEqual(
      expect.objectContaining({
        roundBlock: 1,
        court: 'SRC-2',
        courtLabel: 'SRC Court 2',
        completedSetScores: [{ a: 21, b: 25, setNo: 1 }],
        setScores: [{ a: 21, b: 25 }],
        teamA: expect.objectContaining({ shortName: 'ALP' }),
        teamB: expect.objectContaining({ shortName: 'BRV' }),
      })
    );
  });
});
