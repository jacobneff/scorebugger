const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentTeamRoutes = require('../routes/tournamentTeams');
const User = require('../models/User');
const Match = require('../models/Match');
const Pool = require('../models/Pool');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');

describe('tournament routes', () => {
  let mongo;
  let app;
  let user;
  let token;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'tournament-tests',
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

  test('creates tournaments with unique 6-character public codes', async () => {
    const payload = {
      name: 'Spring Invitational',
      date: '2026-04-20T15:00:00.000Z',
    };

    const first = await request(app)
      .post('/api/tournaments')
      .set(authHeader())
      .send(payload);

    const second = await request(app)
      .post('/api/tournaments')
      .set(authHeader())
      .send({
        ...payload,
        name: 'Spring Invitational 2',
      });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.body.publicCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(second.body.publicCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(first.body.publicCode).not.toBe(second.body.publicCode);
  });

  test('rejects protected tournament admin endpoints without authorization', async () => {
    const response = await request(app)
      .post('/api/tournaments')
      .send({
        name: 'Unauthorized Tournament',
        date: '2026-04-20T15:00:00.000Z',
      });

    expect(response.statusCode).toBe(401);
  });

  test('returns sanitized public tournament payload without owner fields', async () => {
    const tournament = await Tournament.create({
      name: 'Public Tournament',
      date: new Date('2026-06-15T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'PUBLIC',
      createdByUserId: user._id,
    });

    await TournamentTeam.create({
      tournamentId: tournament._id,
      name: 'Alpha Club',
      shortName: 'ALP',
      logoUrl: 'https://example.com/logo.png',
      seed: 1,
    });

    const response = await request(app).get('/api/tournaments/code/PUBLIC');

    expect(response.statusCode).toBe(200);
    expect(response.body.tournament.name).toBe('Public Tournament');
    expect(response.body.tournament).not.toHaveProperty('createdByUserId');
    expect(response.body).not.toHaveProperty('createdByUserId');
    expect(response.body.tournament.settings).toEqual({
      schedule: {
        dayStartTime: '09:00',
        matchDurationMinutes: 60,
        lunchStartTime: null,
        lunchDurationMinutes: 45,
      },
      format: {
        formatId: null,
        activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'],
      },
    });
    expect(response.body.teams).toHaveLength(1);
    expect(response.body.teams[0]).toEqual(
      expect.objectContaining({
        name: 'Alpha Club',
        shortName: 'ALP',
        logoUrl: 'https://example.com/logo.png',
        seed: 1,
      })
    );
    expect(response.body.teams[0]).not.toHaveProperty('tournamentId');
  });

  test('admin tournament details include fallback schedule defaults for older docs', async () => {
    const tournament = await Tournament.create({
      name: 'Legacy Schedule Tournament',
      date: new Date('2026-07-10T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'LEGACY',
      createdByUserId: user._id,
    });

    await Tournament.updateOne(
      { _id: tournament._id },
      {
        $unset: {
          'settings.schedule': 1,
        },
      }
    );

    const response = await request(app)
      .get(`/api/tournaments/${tournament._id}`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.settings).toEqual(
      expect.objectContaining({
        schedule: {
          dayStartTime: '09:00',
          matchDurationMinutes: 60,
          lunchStartTime: null,
          lunchDurationMinutes: 45,
        },
      })
    );
  });

  test('GET /api/tournaments/:id returns explicit applied format settings', async () => {
    const tournament = await Tournament.create({
      name: 'Applied Format Tournament',
      date: new Date('2026-07-11T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'FMT001',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'VC-1'],
        },
      },
    });

    const response = await request(app)
      .get(`/api/tournaments/${tournament._id}`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body.settings?.format).toEqual({
      formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
      activeCourts: ['SRC-1', 'SRC-2', 'VC-1'],
    });
  });

  test('PATCH /api/tournaments/:id/details updates details for the owner', async () => {
    const tournament = await Tournament.create({
      name: 'Details Edit Tournament',
      date: new Date('2026-07-15T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'DET001',
      createdByUserId: user._id,
    });

    const response = await request(app)
      .patch(`/api/tournaments/${tournament._id}/details`)
      .set(authHeader())
      .send({
        specialNotes: 'Bring your own volleyballs.',
        foodInfo: {
          text: 'Food trucks near SRC.',
          linkUrl: 'https://example.com/food',
        },
        facilitiesInfo: 'Court 3 has low ceiling clearance.',
        parkingInfo: 'Use Lot B after 8 AM.',
        mapImageUrls: ['https://example.com/map-a.png', 'https://example.com/map-b.png'],
      });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      details: {
        specialNotes: 'Bring your own volleyballs.',
        foodInfo: {
          text: 'Food trucks near SRC.',
          linkUrl: 'https://example.com/food',
        },
        facilitiesInfo: 'Court 3 has low ceiling clearance.',
        parkingInfo: 'Use Lot B after 8 AM.',
        mapImageUrls: ['https://example.com/map-a.png', 'https://example.com/map-b.png'],
      },
    });

    const stored = await Tournament.findById(tournament._id).lean();
    expect(stored.details).toEqual(
      expect.objectContaining({
        specialNotes: 'Bring your own volleyballs.',
        facilitiesInfo: 'Court 3 has low ceiling clearance.',
        parkingInfo: 'Use Lot B after 8 AM.',
      })
    );
    expect(stored.details.foodInfo).toEqual(
      expect.objectContaining({
        text: 'Food trucks near SRC.',
        linkUrl: 'https://example.com/food',
      })
    );
    expect(stored.details.mapImageUrls).toEqual([
      'https://example.com/map-a.png',
      'https://example.com/map-b.png',
    ]);
  });

  test('PATCH /api/tournaments/:id/details requires ownership', async () => {
    const tournament = await Tournament.create({
      name: 'Details Ownership Tournament',
      date: new Date('2026-07-15T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'DET002',
      createdByUserId: user._id,
    });
    const intruder = await User.create({
      email: 'intruder@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });
    const intruderToken = jwt.sign({ sub: intruder._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .patch(`/api/tournaments/${tournament._id}/details`)
      .set({
        Authorization: `Bearer ${intruderToken}`,
      })
      .send({
        specialNotes: 'Unauthorized write',
      });

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toMatch(/not found or unauthorized/i);
  });

  test('GET /api/tournaments/code/:publicCode/details returns sanitized public details payload', async () => {
    await Tournament.create({
      name: 'Public Details Tournament',
      date: new Date('2026-07-16T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'DET003',
      createdByUserId: user._id,
      details: {
        specialNotes: 'Warm-up starts at 8:30 AM.',
        foodInfo: {
          text: 'Concessions in the lobby.',
          linkUrl: 'https://example.com/menu',
        },
        facilitiesInfo: 'Bring indoor shoes.',
        parkingInfo: 'Use garage level 2.',
        mapImageUrls: ['https://example.com/map-main.png'],
      },
    });

    const response = await request(app).get('/api/tournaments/code/DET003/details');

    expect(response.statusCode).toBe(200);
    expect(response.body.tournament).toEqual(
      expect.objectContaining({
        name: 'Public Details Tournament',
        timezone: 'America/New_York',
        publicCode: 'DET003',
      })
    );
    expect(response.body.details).toEqual({
      specialNotes: 'Warm-up starts at 8:30 AM.',
      foodInfo: {
        text: 'Concessions in the lobby.',
        linkUrl: 'https://example.com/menu',
      },
      facilitiesInfo: 'Bring indoor shoes.',
      parkingInfo: 'Use garage level 2.',
      mapImageUrls: ['https://example.com/map-main.png'],
    });
    expect(response.body.tournament).not.toHaveProperty('createdByUserId');
    expect(response.body).not.toHaveProperty('createdByUserId');
  });

  test('GET /api/tournaments/code/:publicCode/live returns only live matches sorted by time then court', async () => {
    const tournament = await Tournament.create({
      name: 'Live Endpoint Tournament',
      date: new Date('2026-08-12T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'LIVE01',
      createdByUserId: user._id,
    });
    const [alpha, bravo, charlie, delta] = await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'Alpha', shortName: 'ALP', orderIndex: 1 },
        { tournamentId: tournament._id, name: 'Bravo', shortName: 'BRV', orderIndex: 2 },
        { tournamentId: tournament._id, name: 'Charlie', shortName: 'CHR', orderIndex: 3 },
        { tournamentId: tournament._id, name: 'Delta', shortName: 'DLT', orderIndex: 4 },
      ],
      { ordered: true }
    );
    const scoreboard = await Scoreboard.create({
      owner: user._id,
      title: 'ALP vs BRV',
      teams: [
        { name: 'ALP', score: 14 },
        { name: 'BRV', score: 11 },
      ],
      sets: [
        {
          scores: [25, 22],
        },
      ],
    });

    const [liveSrcRound1, liveVcRound1] = await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          poolId: null,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-2',
          teamAId: alpha._id,
          teamBId: bravo._id,
          refTeamIds: [],
          status: 'live',
          scoreboardId: scoreboard._id,
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          poolId: null,
          roundBlock: 1,
          facility: 'VC',
          court: 'VC-1',
          teamAId: charlie._id,
          teamBId: delta._id,
          refTeamIds: [],
          status: 'live',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          poolId: null,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-1',
          teamAId: alpha._id,
          teamBId: charlie._id,
          refTeamIds: [],
          status: 'scheduled',
        },
      ],
      { ordered: true }
    );

    const response = await request(app).get('/api/tournaments/code/LIVE01/live');

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(2);
    expect(response.body.map((match) => match.matchId)).toEqual([
      liveSrcRound1._id.toString(),
      liveVcRound1._id.toString(),
    ]);
    expect(response.body.every((match) => match.status === 'live')).toBe(true);
    expect(response.body[0]).toEqual(
      expect.objectContaining({
        phase: 'phase1',
        phaseLabel: 'Pool Play 1',
        courtCode: 'SRC-2',
        courtLabel: 'SRC Court 2',
        facility: 'SRC',
        facilityLabel: 'SRC',
        scoreboardCode: scoreboard.code,
      })
    );
    expect(response.body[0].scoreSummary).toEqual(
      expect.objectContaining({
        setsA: 1,
        setsB: 0,
        pointsA: 14,
        pointsB: 11,
      })
    );
    expect(response.body[0].completedSetScores).toEqual([
      { setNo: 1, a: 25, b: 22 },
    ]);
  });

  test('DELETE /api/tournaments/:id removes owner tournament and related records', async () => {
    const tournament = await Tournament.create({
      name: 'Delete Me Tournament',
      date: new Date('2026-08-20T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'DEL001',
      createdByUserId: user._id,
    });

    const [teamA, teamB] = await TournamentTeam.insertMany(
      [
        {
          tournamentId: tournament._id,
          name: 'Alpha',
          shortName: 'ALP',
          orderIndex: 1,
        },
        {
          tournamentId: tournament._id,
          name: 'Bravo',
          shortName: 'BRV',
          orderIndex: 2,
        },
      ],
      { ordered: true }
    );

    await Pool.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      name: 'A',
      teamIds: [teamA._id, teamB._id],
      homeCourt: 'SRC-1',
    });

    const scoreboard = await Scoreboard.create({
      owner: user._id,
      title: 'Delete test board',
      teams: [
        { name: 'ALP', score: 0 },
        { name: 'BRV', score: 0 },
      ],
      sets: [],
    });

    await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      poolId: null,
      roundBlock: 1,
      facility: 'SRC',
      court: 'SRC-1',
      teamAId: teamA._id,
      teamBId: teamB._id,
      refTeamIds: [],
      status: 'scheduled',
      scoreboardId: scoreboard._id,
    });

    const response = await request(app)
      .delete(`/api/tournaments/${tournament._id}`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      deleted: true,
      tournamentId: String(tournament._id),
    });

    expect(await Tournament.findById(tournament._id)).toBeNull();
    expect(await TournamentTeam.countDocuments({ tournamentId: tournament._id })).toBe(0);
    expect(await Pool.countDocuments({ tournamentId: tournament._id })).toBe(0);
    expect(await Match.countDocuments({ tournamentId: tournament._id })).toBe(0);
    expect(await Scoreboard.findById(scoreboard._id)).toBeNull();
  });

  test('DELETE /api/tournaments/:id requires ownership', async () => {
    const tournament = await Tournament.create({
      name: 'Delete Ownership Tournament',
      date: new Date('2026-08-20T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'DEL002',
      createdByUserId: user._id,
    });

    const intruder = await User.create({
      email: 'intruder-delete@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });
    const intruderToken = jwt.sign({ sub: intruder._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .delete(`/api/tournaments/${tournament._id}`)
      .set({
        Authorization: `Bearer ${intruderToken}`,
      });

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toMatch(/not found or unauthorized/i);
  });

  test('POST /api/tournaments/:id/reset deletes schedule/results, preserves teams/details/format, and sets setup status', async () => {
    const tournament = await Tournament.create({
      name: 'Reset Me Tournament',
      date: new Date('2026-08-20T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'RST001',
      status: 'phase2',
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'VC-1'],
        },
      },
      details: {
        specialNotes: 'Keep these details',
      },
      standingsOverrides: {
        phase1: {
          poolOrderOverrides: {},
          overallOrderOverrides: [],
        },
      },
      createdByUserId: user._id,
    });

    const [teamA, teamB] = await TournamentTeam.insertMany(
      [
        {
          tournamentId: tournament._id,
          name: 'Alpha',
          shortName: 'ALP',
          orderIndex: 1,
        },
        {
          tournamentId: tournament._id,
          name: 'Bravo',
          shortName: 'BRV',
          orderIndex: 2,
        },
      ],
      { ordered: true }
    );

    await Pool.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      name: 'A',
      teamIds: [teamA._id, teamB._id],
      homeCourt: 'SRC-1',
      requiredTeamCount: 2,
    });

    const scoreboard = await Scoreboard.create({
      owner: user._id,
      title: 'Reset test board',
      teams: [
        { name: 'ALP', score: 0 },
        { name: 'BRV', score: 0 },
      ],
      sets: [],
    });

    await Match.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      roundBlock: 1,
      facility: 'SRC',
      court: 'SRC-1',
      teamAId: teamA._id,
      teamBId: teamB._id,
      refTeamIds: [],
      status: 'scheduled',
      scoreboardId: scoreboard._id,
    });

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/reset`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      reset: true,
      tournamentId: String(tournament._id),
      status: 'setup',
      deleted: {
        pools: 1,
        matches: 1,
        scoreboards: 1,
      },
    });

    const stored = await Tournament.findById(tournament._id).lean();
    expect(stored.status).toBe('setup');
    expect(stored.details?.specialNotes).toBe('Keep these details');
    expect(stored.settings?.format?.formatId).toBe('classic_14_mixedpools_crossover_gold8_silver6_v1');
    expect(stored.settings?.format?.activeCourts).toEqual(['SRC-1', 'SRC-2', 'VC-1']);
    expect(stored.standingsOverrides).toBeUndefined();

    expect(await TournamentTeam.countDocuments({ tournamentId: tournament._id })).toBe(2);
    expect(await Pool.countDocuments({ tournamentId: tournament._id })).toBe(0);
    expect(await Match.countDocuments({ tournamentId: tournament._id })).toBe(0);
    expect(await Scoreboard.findById(scoreboard._id)).toBeNull();
  });

  test('POST /api/tournaments/:id/reset requires ownership', async () => {
    const tournament = await Tournament.create({
      name: 'Reset Ownership Tournament',
      date: new Date('2026-08-20T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'RST002',
      createdByUserId: user._id,
    });

    const intruder = await User.create({
      email: 'intruder-reset@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });
    const intruderToken = jwt.sign({ sub: intruder._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/reset`)
      .set({
        Authorization: `Bearer ${intruderToken}`,
      });

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toMatch(/not found or unauthorized/i);
  });

  test('POST /api/tournaments/:id/reset is idempotent when no pools/matches exist', async () => {
    const tournament = await Tournament.create({
      name: 'Reset Idempotent Tournament',
      date: new Date('2026-08-20T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'RST003',
      createdByUserId: user._id,
    });

    const first = await request(app)
      .post(`/api/tournaments/${tournament._id}/reset`)
      .set(authHeader());
    const second = await request(app)
      .post(`/api/tournaments/${tournament._id}/reset`)
      .set(authHeader());

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({
      reset: true,
      tournamentId: String(tournament._id),
      status: 'setup',
      deleted: {
        pools: 0,
        matches: 0,
        scoreboards: 0,
      },
    });
  });

  test('POST /api/tournaments/:id/stages/:stageKey/pools/autofill fills applied stage pools using team order', async () => {
    const tournament = await Tournament.create({
      name: 'Stage Autofill Tournament',
      date: new Date('2026-08-22T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'STGAF1',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    await TournamentTeam.insertMany(
      Array.from({ length: 14 }, (_, index) => ({
        tournamentId: tournament._id,
        name: `Team ${index + 1}`,
        shortName: `T${index + 1}`,
        orderIndex: index + 1,
      })),
      { ordered: true }
    );

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill`)
      .set(authHeader());

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(4);
    expect(response.body.map((pool) => pool.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(response.body.map((pool) => pool.requiredTeamCount)).toEqual([4, 4, 3, 3]);

    const totalAssigned = response.body.reduce(
      (sum, pool) => sum + (Array.isArray(pool.teamIds) ? pool.teamIds.length : 0),
      0
    );
    expect(totalAssigned).toBe(14);

    response.body.forEach((pool) => {
      expect(Array.isArray(pool.teamIds)).toBe(true);
      expect(pool.teamIds.length).toBe(pool.requiredTeamCount);
    });
  });

  test('POST /api/tournaments/:id/stages/:stageKey/pools/autofill returns conflict unless forced when pools already assigned', async () => {
    const tournament = await Tournament.create({
      name: 'Stage Autofill Conflict Tournament',
      date: new Date('2026-08-22T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'STGAF2',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    await TournamentTeam.insertMany(
      Array.from({ length: 14 }, (_, index) => ({
        tournamentId: tournament._id,
        name: `Team ${index + 1}`,
        shortName: `T${index + 1}`,
        orderIndex: index + 1,
      })),
      { ordered: true }
    );

    const first = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill`)
      .set(authHeader());
    expect(first.statusCode).toBe(200);

    const conflict = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill`)
      .set(authHeader());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.message).toMatch(/already contain teams/i);

    const forced = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill?force=true`)
      .set(authHeader());
    expect(forced.statusCode).toBe(200);
    expect(Array.isArray(forced.body)).toBe(true);
    expect(forced.body).toHaveLength(4);
  });

  test('POST /api/tournaments/:id/stages/:stageKey/pools/autofill rejects non-poolPlay stages', async () => {
    const tournament = await Tournament.create({
      name: 'Stage Autofill Reject Tournament',
      date: new Date('2026-08-22T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'STGAF3',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/playoffs/pools/autofill`)
      .set(authHeader());

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/not a poolPlay stage/i);
  });

  test('POST /api/tournaments/:id/stages/:stageKey/pools/autofill requires tournament access', async () => {
    const tournament = await Tournament.create({
      name: 'Stage Autofill Access Tournament',
      date: new Date('2026-08-22T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'STGAF4',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    const intruder = await User.create({
      email: 'intruder-stage-autofill@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });
    const intruderToken = jwt.sign({ sub: intruder._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill`)
      .set({
        Authorization: `Bearer ${intruderToken}`,
      });

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toMatch(/not found or unauthorized/i);
  });

  test('creating a team with shortName only defaults name and assigns incremental orderIndex', async () => {
    const tournament = await Tournament.create({
      name: 'Order Test',
      date: new Date('2026-08-10T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'ORDER1',
      createdByUserId: user._id,
    });

    const first = await request(app)
      .post(`/api/tournaments/${tournament._id}/teams`)
      .set(authHeader())
      .send({
        shortName: 'ALP',
      });

    expect(first.statusCode).toBe(201);
    expect(first.body).toEqual(
      expect.objectContaining({
        name: 'ALP',
        shortName: 'ALP',
        orderIndex: 1,
      })
    );

    const second = await request(app)
      .post(`/api/tournaments/${tournament._id}/teams`)
      .set(authHeader())
      .send({
        shortName: 'BRV',
      });

    expect(second.statusCode).toBe(201);
    expect(second.body).toEqual(
      expect.objectContaining({
        name: 'BRV',
        shortName: 'BRV',
        orderIndex: 2,
      })
    );
  });

  test('team create accepts label-only location and patch clears existing coordinates', async () => {
    const tournament = await Tournament.create({
      name: 'Location Team Test',
      date: new Date('2026-08-10T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'LOCTST',
      createdByUserId: user._id,
    });

    const created = await request(app)
      .post(`/api/tournaments/${tournament._id}/teams`)
      .set(authHeader())
      .send({
        shortName: 'ODU',
        location: {
          label: 'Norfolk, VA',
        },
      });

    expect(created.statusCode).toBe(201);
    expect(created.body.location).toEqual({
      label: 'Norfolk, VA',
      latitude: null,
      longitude: null,
    });

    await TournamentTeam.updateOne(
      { _id: created.body._id },
      {
        $set: {
          location: {
            label: 'Old Coordinates',
            latitude: 36.8863,
            longitude: -76.3057,
          },
        },
      }
    );

    const patched = await request(app)
      .patch(`/api/tournament-teams/${created.body._id}`)
      .set(authHeader())
      .send({
        location: {
          label: 'Virginia Beach, VA',
        },
      });

    expect(patched.statusCode).toBe(200);
    expect(patched.body.location).toEqual({
      label: 'Virginia Beach, VA',
      latitude: null,
      longitude: null,
    });
  });

  test('team location-search endpoint is not available', async () => {
    const response = await request(app)
      .get('/api/tournament-teams/location-search?q=Norfolk')
      .set(authHeader());

    expect(response.statusCode).toBe(404);
  });

  test('bulk team reorder enforces permutation and persists orderIndex', async () => {
    const tournament = await Tournament.create({
      name: 'Reorder Test',
      date: new Date('2026-08-10T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'ORDER2',
      createdByUserId: user._id,
    });

    const teams = await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'Alpha', shortName: 'ALP', orderIndex: 1 },
        { tournamentId: tournament._id, name: 'Bravo', shortName: 'BRV', orderIndex: 2 },
        { tournamentId: tournament._id, name: 'Charlie', shortName: 'CHR', orderIndex: 3 },
      ],
      { ordered: true }
    );

    const invalid = await request(app)
      .put(`/api/tournaments/${tournament._id}/teams/order`)
      .set(authHeader())
      .send({
        orderedTeamIds: [teams[0]._id.toString(), teams[1]._id.toString()],
      });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.message).toMatch(/permutation/i);

    const desiredOrder = [teams[2]._id.toString(), teams[0]._id.toString(), teams[1]._id.toString()];
    const valid = await request(app)
      .put(`/api/tournaments/${tournament._id}/teams/order`)
      .set(authHeader())
      .send({
        orderedTeamIds: desiredOrder,
      });

    expect(valid.statusCode).toBe(200);
    expect(valid.body.map((team) => String(team._id))).toEqual(desiredOrder);
    expect(valid.body.map((team) => team.orderIndex)).toEqual([1, 2, 3]);

    const persisted = await TournamentTeam.find({ tournamentId: tournament._id })
      .sort({ orderIndex: 1 })
      .lean();
    expect(persisted.map((team) => String(team._id))).toEqual(desiredOrder);
  });

  test('public court schedule endpoint filters by court and sorts by roundBlock', async () => {
    const tournament = await Tournament.create({
      name: 'Court Schedule Test',
      date: new Date('2026-08-12T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'COURT1',
      createdByUserId: user._id,
    });

    const [alpha, bravo, charlie] = await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'Alpha', shortName: 'ALP', orderIndex: 1 },
        { tournamentId: tournament._id, name: 'Bravo', shortName: 'BRV', orderIndex: 2 },
        { tournamentId: tournament._id, name: 'Charlie', shortName: 'CHR', orderIndex: 3 },
      ],
      { ordered: true }
    );

    await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase2',
          poolId: null,
          roundBlock: 5,
          facility: 'SRC',
          court: 'SRC-1',
          teamAId: bravo._id,
          teamBId: charlie._id,
          refTeamIds: [alpha._id],
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          poolId: null,
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
            pointsAgainstA: 30,
            pointsForB: 30,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 15 },
              { setNo: 2, a: 25, b: 15 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          poolId: null,
          roundBlock: 1,
          facility: 'VC',
          court: 'VC-1',
          teamAId: alpha._id,
          teamBId: charlie._id,
          refTeamIds: [bravo._id],
          status: 'scheduled',
        },
      ],
      { ordered: true }
    );

    const courts = await request(app).get('/api/tournaments/code/COURT1/courts');

    expect(courts.statusCode).toBe(200);
    expect(Array.isArray(courts.body.courts)).toBe(true);
    expect(courts.body.courts).toHaveLength(5);
    expect(courts.body.courts.find((court) => court.code === 'SRC-1')).toEqual(
      expect.objectContaining({
        code: 'SRC-1',
        label: 'SRC Court 1',
        facility: 'SRC',
      })
    );

    const schedule = await request(app).get('/api/tournaments/code/COURT1/courts/SRC-1/schedule');

    expect(schedule.statusCode).toBe(200);
    expect(schedule.body.court).toEqual(
      expect.objectContaining({
        code: 'SRC-1',
        label: 'SRC Court 1',
      })
    );
    expect(schedule.body.matches).toHaveLength(2);
    expect(schedule.body.matches.map((match) => match.roundBlock)).toEqual([1, 5]);
    expect(schedule.body.matches.every((match) => ['phase1', 'phase2'].includes(match.phase))).toBe(true);
    expect(schedule.body.matches[0]).toEqual(
      expect.objectContaining({
        phase: 'phase1',
        phaseLabel: 'Pool Play 1',
        teamA: 'ALP',
        teamB: 'BRV',
        refs: ['CHR'],
        score: expect.objectContaining({
          setsA: 2,
          setsB: 0,
        }),
      })
    );
  });
});
