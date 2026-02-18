const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentTeamRoutes = require('../routes/tournamentTeams');
const User = require('../models/User');
const Match = require('../models/Match');
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
