const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentTeamRoutes = require('../routes/tournamentTeams');
const User = require('../models/User');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');

describe('team links routes', () => {
  let mongo;
  let app;
  let user;
  let token;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'team-links-route-tests',
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
    app.use('/api/tournament-teams', tournamentTeamRoutes);
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

  test('team creation assigns unique 8-character publicTeamCode values within a tournament', async () => {
    const tournament = await Tournament.create({
      name: 'Link Code Tournament',
      date: new Date('2026-05-10T14:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'LNK001',
      createdByUserId: user._id,
    });

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/teams`)
      .set(authHeader())
      .send([
        { shortName: 'ALP' },
        { shortName: 'BRV' },
        { shortName: 'CHR' },
        { shortName: 'DLT' },
      ]);

    expect(response.statusCode).toBe(201);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(4);

    const codes = response.body.map((team) => team.publicTeamCode);
    expect(codes.every((code) => /^[A-Z0-9]{8}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('teams links endpoint lazily backfills missing codes and returns relative team URLs', async () => {
    const tournament = await Tournament.create({
      name: 'Backfill Tournament',
      date: new Date('2026-06-01T14:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'BKF001',
      createdByUserId: user._id,
    });

    await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'Alpha', shortName: 'ALP', orderIndex: 1 },
        { tournamentId: tournament._id, name: 'Bravo', shortName: 'BRV', orderIndex: 2 },
      ],
      { ordered: true }
    );

    const response = await request(app)
      .get(`/api/tournaments/${tournament._id}/teams/links`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(2);
    expect(response.body.every((entry) => /^[A-Z0-9]{8}$/.test(entry.publicTeamCode))).toBe(true);
    expect(response.body.every((entry) => entry.teamLinkUrl.startsWith('/t/BKF001/team/'))).toBe(true);

    const persistedTeams = await TournamentTeam.find({ tournamentId: tournament._id }).lean();
    expect(persistedTeams.every((team) => /^[A-Z0-9]{8}$/.test(team.publicTeamCode))).toBe(true);
  });

  test('public team endpoint returns only the requested team matches and refs without internal fields', async () => {
    const tournament = await Tournament.create({
      name: 'Team View Tournament',
      date: new Date('2026-06-15T14:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'TEAM10',
      createdByUserId: user._id,
    });

    const [alpha, bravo, charlie, delta] = await TournamentTeam.insertMany(
      [
        {
          tournamentId: tournament._id,
          name: 'Alpha',
          shortName: 'ALP',
          orderIndex: 1,
          publicTeamCode: 'ALPHA001',
        },
        {
          tournamentId: tournament._id,
          name: 'Bravo',
          shortName: 'BRV',
          orderIndex: 2,
          publicTeamCode: 'BRAVO002',
        },
        {
          tournamentId: tournament._id,
          name: 'Charlie',
          shortName: 'CHR',
          orderIndex: 3,
          publicTeamCode: 'CHARL003',
        },
        {
          tournamentId: tournament._id,
          name: 'Delta',
          shortName: 'DLT',
          orderIndex: 4,
          publicTeamCode: 'DELTA004',
        },
      ],
      { ordered: true }
    );

    const liveScoreboard = await Scoreboard.create({
      teams: [
        { name: 'ALP', score: 11 },
        { name: 'DLT', score: 9 },
      ],
      sets: [
        { scores: [25, 18] },
        { scores: [22, 25] },
      ],
      servingTeamIndex: 0,
    });

    const participantFinal = await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      roundBlock: 1,
      facility: 'SRC',
      court: 'SRC-1',
      teamAId: alpha._id,
      teamBId: bravo._id,
      refTeamIds: [charlie._id],
      status: 'final',
      result: {
        winnerTeamId: alpha._id,
        loserTeamId: bravo._id,
        setsWonA: 2,
        setsWonB: 0,
        setsPlayed: 2,
        pointsForA: 50,
        pointsAgainstA: 34,
        pointsForB: 34,
        pointsAgainstB: 50,
        setScores: [
          { setNo: 1, a: 25, b: 17 },
          { setNo: 2, a: 25, b: 17 },
        ],
      },
    });

    const participantLive = await Match.create({
      tournamentId: tournament._id,
      phase: 'phase2',
      roundBlock: 4,
      facility: 'VC',
      court: 'VC-1',
      teamAId: alpha._id,
      teamBId: delta._id,
      refTeamIds: [bravo._id],
      status: 'live',
      scoreboardId: liveScoreboard._id,
    });

    const refAssignment = await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      roundBlock: 2,
      facility: 'SRC',
      court: 'SRC-2',
      teamAId: charlie._id,
      teamBId: delta._id,
      refTeamIds: [alpha._id],
      status: 'scheduled',
    });

    const hiddenMatch = await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      roundBlock: 3,
      facility: 'VC',
      court: 'VC-2',
      teamAId: bravo._id,
      teamBId: charlie._id,
      refTeamIds: [delta._id],
      status: 'scheduled',
    });

    const response = await request(app).get('/api/tournaments/code/TEAM10/team/ALPHA001');

    expect(response.statusCode).toBe(200);
    expect(response.body.tournament).not.toHaveProperty('createdByUserId');
    expect(response.body.team).toEqual(
      expect.objectContaining({
        teamId: alpha._id.toString(),
        shortName: 'ALP',
      })
    );

    expect(response.body.matches.map((match) => match.matchId)).toEqual([
      participantFinal._id.toString(),
      participantLive._id.toString(),
    ]);
    expect(response.body.refs.map((match) => match.matchId)).toEqual([refAssignment._id.toString()]);
    expect(response.body.matches.map((match) => match.matchId)).not.toContain(hiddenMatch._id.toString());
    expect(response.body.nextUp.matchId).toBe(participantLive._id.toString());

    const liveMatchCard = response.body.matches.find(
      (match) => match.matchId === participantLive._id.toString()
    );
    expect(liveMatchCard).toEqual(
      expect.objectContaining({
        phaseLabel: 'Pool Play 2',
        facilityLabel: 'Volleyball Center',
        courtLabel: 'Volleyball Center 1',
        status: 'live',
        scoreSummary: {
          setsA: 1,
          setsB: 1,
          pointsA: 11,
          pointsB: 9,
        },
      })
    );
    expect(typeof liveMatchCard.timeLabel).toBe('string');
    expect(liveMatchCard.timeLabel.length).toBeGreaterThan(0);
  });

  test('regenerate-link rotates team code and invalidates old code', async () => {
    const tournament = await Tournament.create({
      name: 'Regenerate Tournament',
      date: new Date('2026-07-01T14:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'RGN001',
      createdByUserId: user._id,
    });

    const team = await TournamentTeam.create({
      tournamentId: tournament._id,
      name: 'Alpha',
      shortName: 'ALP',
      publicTeamCode: 'OLDLINK1',
    });

    const before = await request(app).get('/api/tournaments/code/RGN001/team/OLDLINK1');
    expect(before.statusCode).toBe(200);

    const regenerate = await request(app)
      .post(`/api/tournament-teams/${team._id}/regenerate-link`)
      .set(authHeader())
      .send({});

    expect(regenerate.statusCode).toBe(200);
    expect(regenerate.body.publicTeamCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(regenerate.body.publicTeamCode).not.toBe('OLDLINK1');

    const oldLink = await request(app).get('/api/tournaments/code/RGN001/team/OLDLINK1');
    expect(oldLink.statusCode).toBe(404);

    const newLink = await request(app).get(
      `/api/tournaments/code/RGN001/team/${regenerate.body.publicTeamCode}`
    );
    expect(newLink.statusCode).toBe(200);
  });

  test('public team endpoint returns 404 for invalid tournamentCode or teamCode', async () => {
    const tournament = await Tournament.create({
      name: 'Invalid Code Tournament',
      date: new Date('2026-07-15T14:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'INV001',
      createdByUserId: user._id,
    });

    await TournamentTeam.create({
      tournamentId: tournament._id,
      name: 'Alpha',
      shortName: 'ALP',
      publicTeamCode: 'TEAM0001',
    });

    const invalidTournamentCode = await request(app).get('/api/tournaments/code/BAD/team/TEAM0001');
    expect(invalidTournamentCode.statusCode).toBe(404);

    const invalidTeamCode = await request(app).get('/api/tournaments/code/INV001/team/BAD');
    expect(invalidTeamCode.statusCode).toBe(404);

    const missingTournament = await request(app).get('/api/tournaments/code/ZZZ999/team/TEAM0001');
    expect(missingTournament.statusCode).toBe(404);
  });
});
