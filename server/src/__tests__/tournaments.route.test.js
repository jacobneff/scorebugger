const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentTeamRoutes = require('../routes/tournamentTeams');
const poolRoutes = require('../routes/pools');
const User = require('../models/User');
const Match = require('../models/Match');
const Pool = require('../models/Pool');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const { syncSchedulePlan } = require('../services/schedulePlan');

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

  const seedTournamentTeams = async (tournamentId, teamCount) =>
    TournamentTeam.insertMany(
      Array.from({ length: teamCount }, (_, index) => ({
        tournamentId,
        name: `Team ${index + 1}`,
        shortName: `T${index + 1}`,
        orderIndex: index + 1,
      })),
      { ordered: true }
    );

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
    expect(response.body.tournament.settings).toEqual(
      expect.objectContaining({
        schedule: {
          dayStartTime: '09:00',
          matchDurationMinutes: 60,
          lunchStartTime: null,
          lunchDurationMinutes: 45,
        },
        format: expect.objectContaining({
          formatId: null,
          totalCourts: 5,
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'],
        }),
      })
    );
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
    expect(response.body.settings?.format?.formatId).toBe(
      'classic_14_mixedpools_crossover_gold8_silver6_v1'
    );
    expect(response.body.settings?.format?.totalCourts).toBe(5);
    expect(response.body.settings?.format?.activeCourts).toEqual(
      expect.arrayContaining(['SRC-1', 'SRC-2', 'VC-1'])
    );
  });

  test('POST /api/tournaments/:id/apply-format stores totalCourts and creates a default venue', async () => {
    const tournament = await Tournament.create({
      name: 'Apply Format Venue Tournament',
      date: new Date('2026-07-12T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'FMTV01',
      createdByUserId: user._id,
    });
    await seedTournamentTeams(tournament._id, 14);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
        totalCourts: 4,
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.totalCourts).toBe(4);
    expect(response.body.venue?.facilities || []).toHaveLength(1);
    expect(response.body.venue?.facilities?.[0]).toEqual(
      expect.objectContaining({
        name: 'Main Facility',
      })
    );
    expect(
      (response.body.venue?.facilities?.[0]?.courts || []).every((court) => court.isEnabled === true)
    ).toBe(true);
    expect(response.body.venue.facilities[0].courts).toHaveLength(4);
    expect(response.body.pools).toHaveLength(4);

    const stored = await Tournament.findById(tournament._id).lean();
    expect(stored.settings?.format?.formatId).toBe(
      'classic_14_mixedpools_crossover_gold8_silver6_v1'
    );
    expect(stored.settings?.format?.totalCourts).toBe(4);
    expect(stored.settings?.venue?.facilities?.[0]?.courts || []).toHaveLength(4);
  });

  test('PUT /api/tournaments/:id/venue rejects mismatched total configured courts', async () => {
    const tournament = await Tournament.create({
      name: 'Venue Validation Tournament',
      date: new Date('2026-07-13T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'FMTV02',
      createdByUserId: user._id,
    });
    await seedTournamentTeams(tournament._id, 14);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
        totalCourts: 4,
      });
    expect(apply.statusCode).toBe(200);

    const response = await request(app)
      .put(`/api/tournaments/${tournament._id}/venue`)
      .set(authHeader())
      .send({
        facilities: [
          {
            name: 'Main Facility',
            courts: [
              { name: 'Court 1', isEnabled: true },
              { name: 'Court 2', isEnabled: true },
              { name: 'Court 3', isEnabled: true },
            ],
          },
        ],
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/must equal format totalCourts/i);
  });

  test('pool-play match generation blocks when pools are missing assignedCourtId', async () => {
    const tournament = await Tournament.create({
      name: 'Missing Court Assignment Tournament',
      date: new Date('2026-07-14T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'FMTV03',
      createdByUserId: user._id,
    });
    await seedTournamentTeams(tournament._id, 14);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
        totalCourts: 4,
      });
    expect(apply.statusCode).toBe(200);

    const autofill = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill`)
      .set(authHeader());
    expect(autofill.statusCode).toBe(200);

    const response = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/must be assigned to a venue court/i);
  });

  test('pool-play match generation writes match.courtId and match.facilityId from venue assignments', async () => {
    const tournament = await Tournament.create({
      name: 'Court Id Match Tournament',
      date: new Date('2026-07-15T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'FMTV04',
      createdByUserId: user._id,
    });
    await seedTournamentTeams(tournament._id, 14);

    const apply = await request(app)
      .post(`/api/tournaments/${tournament._id}/apply-format`)
      .set(authHeader())
      .send({
        formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
        totalCourts: 4,
      });
    expect(apply.statusCode).toBe(200);

    const autofill = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools/autofill`)
      .set(authHeader());
    expect(autofill.statusCode).toBe(200);

    const poolsResponse = await request(app)
      .get(`/api/tournaments/${tournament._id}/stages/poolPlay1/pools`)
      .set(authHeader());
    expect(poolsResponse.statusCode).toBe(200);
    expect(poolsResponse.body).toHaveLength(4);

    const venueResponse = await request(app)
      .get(`/api/tournaments/${tournament._id}/venue`)
      .set(authHeader());
    expect(venueResponse.statusCode).toBe(200);
    const venueCourts = venueResponse.body?.venue?.facilities?.flatMap((facility) =>
      Array.isArray(facility?.courts)
        ? facility.courts.map((court) => ({
            courtId: court.courtId,
            facilityId: facility.facilityId,
          }))
        : []
    ) || [];
    expect(venueCourts.length).toBeGreaterThanOrEqual(4);

    for (let index = 0; index < poolsResponse.body.length; index += 1) {
      const pool = poolsResponse.body[index];
      const targetCourt = venueCourts[index];
      const assign = await request(app)
        .put(`/api/pools/${pool._id}/assign-court`)
        .set(authHeader())
        .send({ assignedCourtId: targetCourt.courtId });

      expect(assign.statusCode).toBe(200);
      expect(assign.body.assignedCourtId).toBe(targetCourt.courtId);
      expect(assign.body.assignedFacilityId).toBe(targetCourt.facilityId);
    }

    const generate = await request(app)
      .post(`/api/tournaments/${tournament._id}/stages/poolPlay1/matches/generate`)
      .set(authHeader());
    expect(generate.statusCode).toBe(201);
    expect(generate.body.length).toBeGreaterThan(0);
    expect(generate.body.every((match) => Boolean(match.courtId))).toBe(true);
    expect(generate.body.every((match) => Boolean(match.facilityId))).toBe(true);

    const storedMatches = await Match.find({
      tournamentId: tournament._id,
      stageKey: 'poolPlay1',
    })
      .select('court courtId facility facilityId')
      .lean();
    expect(storedMatches.length).toBeGreaterThan(0);
    expect(storedMatches.every((match) => typeof match.court === 'string' && match.court.trim())).toBe(
      true
    );
    expect(storedMatches.every((match) => typeof match.facility === 'string' && match.facility.trim())).toBe(
      true
    );
    expect(storedMatches.every((match) => typeof match.courtId === 'string' && match.courtId.trim())).toBe(
      true
    );
    expect(storedMatches.every((match) => typeof match.facilityId === 'string' && match.facilityId.trim())).toBe(
      true
    );
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

    const storedTournament = await Tournament.findById(tournament._id).lean();
    expect(storedTournament?.settings?.venue?.facilities || []).toHaveLength(0);

    const courts = await request(app).get('/api/tournaments/code/COURT1/courts');

    expect(courts.statusCode).toBe(200);
    expect(Array.isArray(courts.body.courts)).toBe(true);
    expect(courts.body.courts).toHaveLength(5);
    expect(
      courts.body.courts.some(
        (court) =>
          court.code === 'SRC-1'
          || court.label === 'SRC Court 1'
          || court.label === 'SRC-1'
      )
    ).toBe(true);

    const schedule = await request(app).get('/api/tournaments/code/COURT1/courts/SRC-1/schedule');

    expect(schedule.statusCode).toBe(200);
    expect(typeof schedule.body.court?.code).toBe('string');
    expect(typeof schedule.body.court?.label).toBe('string');
    expect(schedule.body.court?.label.toUpperCase()).toContain('SRC');
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

  test('public court schedule endpoint returns crossover placeholders before source pools are finalized', async () => {
    const tournament = await Tournament.create({
      name: 'Crossover Placeholder Tournament',
      date: new Date('2026-08-25T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'CRTPL1',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    const teams = await TournamentTeam.insertMany(
      Array.from({ length: 14 }, (_, index) => ({
        tournamentId: tournament._id,
        name: `Team ${index + 1}`,
        shortName: `T${index + 1}`,
        orderIndex: index + 1,
      })),
      { ordered: true }
    );
    const cTeams = teams.slice(0, 3);
    const dTeams = teams.slice(3, 6);

    const [poolC, poolD] = await Pool.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          name: 'C',
          requiredTeamCount: 3,
          teamIds: cTeams.map((team) => team._id),
          assignedCourtId: 'SRC-1',
          assignedFacilityId: 'SRC',
          homeCourt: 'SRC-1',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          name: 'D',
          requiredTeamCount: 3,
          teamIds: dTeams.map((team) => team._id),
          assignedCourtId: 'SRC-2',
          assignedFacilityId: 'SRC',
          homeCourt: 'SRC-2',
        },
      ],
      { ordered: true }
    );

    await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: cTeams[0]._id,
          teamBId: cTeams[1]._id,
          refTeamIds: [],
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: cTeams[0]._id,
          teamBId: cTeams[2]._id,
          refTeamIds: [],
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: cTeams[1]._id,
          teamBId: cTeams[2]._id,
          refTeamIds: [],
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: dTeams[0]._id,
          teamBId: dTeams[1]._id,
          refTeamIds: [],
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: dTeams[0]._id,
          teamBId: dTeams[2]._id,
          refTeamIds: [],
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: dTeams[1]._id,
          teamBId: dTeams[2]._id,
          refTeamIds: [],
          status: 'scheduled',
        },
      ],
      { ordered: true }
    );

    const schedule = await request(app).get('/api/tournaments/code/CRTPL1/courts/SRC-1/schedule');

    expect(schedule.statusCode).toBe(200);
    expect(Array.isArray(schedule.body.slots)).toBe(true);
    const placeholderSlot = schedule.body.slots.find(
      (slot) =>
        slot.stageKey === 'crossover'
        && slot.matchupLabel === 'C (#1) vs D (#1)'
    );
    expect(placeholderSlot).toBeTruthy();
    expect(placeholderSlot.status).toBe('scheduled_tbd');
    expect(placeholderSlot.refLabel).toBe('C (#3)');

    const schedulePlanResponse = await request(app).get(
      '/api/tournaments/code/CRTPL1/schedule-plan?stageKeys=crossover&kinds=match'
    );
    expect(schedulePlanResponse.statusCode).toBe(200);
    expect(Array.isArray(schedulePlanResponse.body?.slots)).toBe(true);
    const placeholderPlanSlot = schedulePlanResponse.body.slots.find(
      (slot) =>
        slot.stageKey === 'crossover'
        && slot.matchupLabel === 'C (#1) vs D (#1)'
    );
    expect(placeholderPlanSlot).toBeTruthy();
    expect(placeholderPlanSlot.status).toBe('scheduled_tbd');
    expect(placeholderPlanSlot.refLabel).toBe('C (#3)');
    expect(placeholderPlanSlot.matchId).toBeNull();
  });

  test('public court schedule endpoint returns resolved crossover teams with linked matchId after finalization', async () => {
    const tournament = await Tournament.create({
      name: 'Crossover Resolved Tournament',
      date: new Date('2026-08-26T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'CRTRL2',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    const teams = await TournamentTeam.insertMany(
      [
        { tournamentId: tournament._id, name: 'C1 Team', shortName: 'C1', orderIndex: 1 },
        { tournamentId: tournament._id, name: 'C2 Team', shortName: 'C2', orderIndex: 2 },
        { tournamentId: tournament._id, name: 'C3 Team', shortName: 'C3', orderIndex: 3 },
        { tournamentId: tournament._id, name: 'D1 Team', shortName: 'D1', orderIndex: 4 },
        { tournamentId: tournament._id, name: 'D2 Team', shortName: 'D2', orderIndex: 5 },
        { tournamentId: tournament._id, name: 'D3 Team', shortName: 'D3', orderIndex: 6 },
        { tournamentId: tournament._id, name: 'A1 Team', shortName: 'A1', orderIndex: 7 },
        { tournamentId: tournament._id, name: 'A2 Team', shortName: 'A2', orderIndex: 8 },
        { tournamentId: tournament._id, name: 'A3 Team', shortName: 'A3', orderIndex: 9 },
        { tournamentId: tournament._id, name: 'A4 Team', shortName: 'A4', orderIndex: 10 },
        { tournamentId: tournament._id, name: 'B1 Team', shortName: 'B1', orderIndex: 11 },
        { tournamentId: tournament._id, name: 'B2 Team', shortName: 'B2', orderIndex: 12 },
        { tournamentId: tournament._id, name: 'B3 Team', shortName: 'B3', orderIndex: 13 },
        { tournamentId: tournament._id, name: 'B4 Team', shortName: 'B4', orderIndex: 14 },
      ],
      { ordered: true }
    );
    const cTeams = teams.slice(0, 3);
    const dTeams = teams.slice(3, 6);

    const [poolC, poolD] = await Pool.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          name: 'C',
          requiredTeamCount: 3,
          teamIds: cTeams.map((team) => team._id),
          assignedCourtId: 'SRC-1',
          assignedFacilityId: 'SRC',
          homeCourt: 'SRC-1',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          name: 'D',
          requiredTeamCount: 3,
          teamIds: dTeams.map((team) => team._id),
          assignedCourtId: 'SRC-2',
          assignedFacilityId: 'SRC',
          homeCourt: 'SRC-2',
        },
      ],
      { ordered: true }
    );

    await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: cTeams[0]._id,
          teamBId: cTeams[1]._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: cTeams[0]._id,
            loserTeamId: cTeams[1]._id,
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
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: cTeams[0]._id,
          teamBId: cTeams[2]._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: cTeams[0]._id,
            loserTeamId: cTeams[2]._id,
            setsWonA: 2,
            setsWonB: 1,
            setsPlayed: 3,
            pointsForA: 65,
            pointsAgainstA: 58,
            pointsForB: 58,
            pointsAgainstB: 65,
            setScores: [
              { setNo: 1, a: 25, b: 22 },
              { setNo: 2, a: 15, b: 25 },
              { setNo: 3, a: 25, b: 11 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: cTeams[1]._id,
          teamBId: cTeams[2]._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: cTeams[1]._id,
            loserTeamId: cTeams[2]._id,
            setsWonA: 2,
            setsWonB: 0,
            setsPlayed: 2,
            pointsForA: 50,
            pointsAgainstA: 41,
            pointsForB: 41,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 20 },
              { setNo: 2, a: 25, b: 21 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: dTeams[0]._id,
          teamBId: dTeams[1]._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: dTeams[0]._id,
            loserTeamId: dTeams[1]._id,
            setsWonA: 2,
            setsWonB: 0,
            setsPlayed: 2,
            pointsForA: 50,
            pointsAgainstA: 31,
            pointsForB: 31,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 16 },
              { setNo: 2, a: 25, b: 15 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: dTeams[0]._id,
          teamBId: dTeams[2]._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: dTeams[0]._id,
            loserTeamId: dTeams[2]._id,
            setsWonA: 2,
            setsWonB: 0,
            setsPlayed: 2,
            pointsForA: 50,
            pointsAgainstA: 33,
            pointsForB: 33,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 18 },
              { setNo: 2, a: 25, b: 15 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: dTeams[1]._id,
          teamBId: dTeams[2]._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: dTeams[1]._id,
            loserTeamId: dTeams[2]._id,
            setsWonA: 2,
            setsWonB: 1,
            setsPlayed: 3,
            pointsForA: 66,
            pointsAgainstA: 61,
            pointsForB: 61,
            pointsAgainstB: 66,
            setScores: [
              { setNo: 1, a: 25, b: 20 },
              { setNo: 2, a: 21, b: 25 },
              { setNo: 3, a: 20, b: 16 },
            ],
          },
        },
      ],
      { ordered: true }
    );

    await syncSchedulePlan({
      tournamentId: tournament._id,
      actorUserId: user._id,
      emitEvents: false,
    });

    const schedule = await request(app).get('/api/tournaments/code/CRTRL2/courts/SRC-1/schedule');

    expect(schedule.statusCode).toBe(200);
    const resolvedSlot = schedule.body.slots.find(
      (slot) =>
        slot.stageKey === 'crossover'
        && slot.matchupReferenceLabel === 'C (#1) vs D (#1)'
    );
    expect(resolvedSlot).toBeTruthy();
    expect(resolvedSlot.status).toBe('scheduled');
    expect(resolvedSlot.matchupLabel).toBe('C1 vs D1');
    expect(resolvedSlot.matchId).toBeTruthy();
    expect(resolvedSlot.teamA).toEqual(
      expect.objectContaining({
        shortName: 'C1',
      })
    );
    expect(resolvedSlot.teamB).toEqual(
      expect.objectContaining({
        shortName: 'D1',
      })
    );

    const linkedMatch = await Match.findOne({
      tournamentId: tournament._id,
      plannedSlotId: resolvedSlot.slotId,
    })
      .select('_id plannedSlotId')
      .lean();
    expect(linkedMatch).toBeTruthy();
    expect(String(linkedMatch._id)).toBe(String(resolvedSlot.matchId));

    const schedulePlanResponse = await request(app).get(
      '/api/tournaments/code/CRTRL2/schedule-plan?stageKeys=crossover&kinds=match'
    );
    expect(schedulePlanResponse.statusCode).toBe(200);
    const resolvedPlanSlot = schedulePlanResponse.body.slots.find(
      (slot) =>
        slot.stageKey === 'crossover'
        && slot.matchupReferenceLabel === 'C (#1) vs D (#1)'
    );
    expect(resolvedPlanSlot).toBeTruthy();
    expect(resolvedPlanSlot.status).toBe('scheduled');
    expect(resolvedPlanSlot.matchupLabel).toBe('C1 vs D1');
    expect(resolvedPlanSlot.refLabel).toBe('C3');
    expect(resolvedPlanSlot.matchId).toBeTruthy();
  });

  test('public team endpoint resolves crossover ref from rankRef when standings are finalized', async () => {
    const tournament = await Tournament.create({
      name: 'Team Ref Resolution Tournament',
      date: new Date('2026-08-27T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'TRR001',
      createdByUserId: user._id,
      settings: {
        format: {
          formatId: 'classic_14_mixedpools_crossover_gold8_silver6_v1',
          activeCourts: ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1'],
        },
      },
    });

    const [c1, c2, c3, d1, d2, d3] = await TournamentTeam.insertMany(
      [
        {
          tournamentId: tournament._id,
          name: 'C1 Team',
          shortName: 'C1',
          orderIndex: 1,
          publicTeamCode: 'TEAM0001',
        },
        {
          tournamentId: tournament._id,
          name: 'C2 Team',
          shortName: 'C2',
          orderIndex: 2,
          publicTeamCode: 'TEAM0002',
        },
        {
          tournamentId: tournament._id,
          name: 'C3 Team',
          shortName: 'C3',
          orderIndex: 3,
          publicTeamCode: 'TEAM0003',
        },
        {
          tournamentId: tournament._id,
          name: 'D1 Team',
          shortName: 'D1',
          orderIndex: 4,
          publicTeamCode: 'TEAM0004',
        },
        {
          tournamentId: tournament._id,
          name: 'D2 Team',
          shortName: 'D2',
          orderIndex: 5,
          publicTeamCode: 'TEAM0005',
        },
        {
          tournamentId: tournament._id,
          name: 'D3 Team',
          shortName: 'D3',
          orderIndex: 6,
          publicTeamCode: 'TEAM0006',
        },
      ],
      { ordered: true }
    );

    const [poolC, poolD] = await Pool.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          name: 'C',
          requiredTeamCount: 3,
          teamIds: [c1._id, c2._id, c3._id],
          assignedCourtId: 'SRC-1',
          assignedFacilityId: 'SRC',
          homeCourt: 'SRC-1',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          name: 'D',
          requiredTeamCount: 3,
          teamIds: [d1._id, d2._id, d3._id],
          assignedCourtId: 'SRC-2',
          assignedFacilityId: 'SRC',
          homeCourt: 'SRC-2',
        },
      ],
      { ordered: true }
    );

    await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: c1._id,
          teamBId: c2._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: c1._id,
            loserTeamId: c2._id,
            setsWonA: 2,
            setsWonB: 0,
            setsPlayed: 2,
            pointsForA: 50,
            pointsAgainstA: 35,
            pointsForB: 35,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 17 },
              { setNo: 2, a: 25, b: 18 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: c1._id,
          teamBId: c3._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: c1._id,
            loserTeamId: c3._id,
            setsWonA: 2,
            setsWonB: 1,
            setsPlayed: 3,
            pointsForA: 65,
            pointsAgainstA: 58,
            pointsForB: 58,
            pointsAgainstB: 65,
            setScores: [
              { setNo: 1, a: 25, b: 22 },
              { setNo: 2, a: 20, b: 25 },
              { setNo: 3, a: 20, b: 11 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolC._id,
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: c2._id,
          teamBId: c3._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: c2._id,
            loserTeamId: c3._id,
            setsWonA: 2,
            setsWonB: 0,
            setsPlayed: 2,
            pointsForA: 50,
            pointsAgainstA: 40,
            pointsForB: 40,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 20 },
              { setNo: 2, a: 25, b: 20 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: d1._id,
          teamBId: d2._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: d1._id,
            loserTeamId: d2._id,
            setsWonA: 2,
            setsWonB: 0,
            setsPlayed: 2,
            pointsForA: 50,
            pointsAgainstA: 36,
            pointsForB: 36,
            pointsAgainstB: 50,
            setScores: [
              { setNo: 1, a: 25, b: 18 },
              { setNo: 2, a: 25, b: 18 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: d1._id,
          teamBId: d3._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: d1._id,
            loserTeamId: d3._id,
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
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          poolId: poolD._id,
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: d2._id,
          teamBId: d3._id,
          refTeamIds: [],
          status: 'final',
          result: {
            winnerTeamId: d2._id,
            loserTeamId: d3._id,
            setsWonA: 2,
            setsWonB: 1,
            setsPlayed: 3,
            pointsForA: 66,
            pointsAgainstA: 61,
            pointsForB: 61,
            pointsAgainstB: 66,
            setScores: [
              { setNo: 1, a: 25, b: 20 },
              { setNo: 2, a: 21, b: 25 },
              { setNo: 3, a: 20, b: 16 },
            ],
          },
        },
      ],
      { ordered: true }
    );

    await syncSchedulePlan({
      tournamentId: tournament._id,
      actorUserId: user._id,
      emitEvents: false,
    });

    const response = await request(app).get('/api/tournaments/code/TRR001/team/TEAM0003');

    expect(response.statusCode).toBe(200);
    const crossoverRefEntry = response.body.timeline.find(
      (entry) => entry.role === 'REF' && entry.stageKey === 'crossover'
    );
    expect(crossoverRefEntry).toBeTruthy();
    expect(crossoverRefEntry.refLabel).toBe('C3');
    expect(crossoverRefEntry.refLabel).not.toBe('TBD');
  });

  test('public team endpoint timeline merges play/ref/bye/lunch rows in time order', async () => {
    const tournament = await Tournament.create({
      name: 'Team Timeline Tournament',
      date: new Date('2026-08-27T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: 'TMTL01',
      createdByUserId: user._id,
      settings: {
        schedule: {
          dayStartTime: '09:00',
          matchDurationMinutes: 60,
          lunchStartTime: '12:00',
          lunchDurationMinutes: 45,
        },
      },
    });

    const [teamA, teamB, teamC, teamD, teamE] = await TournamentTeam.insertMany(
      [
        {
          tournamentId: tournament._id,
          name: 'Alpha',
          shortName: 'ALP',
          orderIndex: 1,
          publicTeamCode: 'TEAM0001',
        },
        {
          tournamentId: tournament._id,
          name: 'Bravo',
          shortName: 'BRV',
          orderIndex: 2,
          publicTeamCode: 'TEAM0002',
        },
        {
          tournamentId: tournament._id,
          name: 'Charlie',
          shortName: 'CHR',
          orderIndex: 3,
          publicTeamCode: 'TEAM0003',
        },
        {
          tournamentId: tournament._id,
          name: 'Delta',
          shortName: 'DLT',
          orderIndex: 4,
          publicTeamCode: 'TEAM0004',
        },
        {
          tournamentId: tournament._id,
          name: 'Echo',
          shortName: 'ECH',
          orderIndex: 5,
          publicTeamCode: 'TEAM0005',
        },
      ],
      { ordered: true }
    );

    const [scoreboardPlay, scoreboardRef, scoreboardBye] = await Scoreboard.insertMany(
      [
        {
          owner: user._id,
          title: 'ALP vs BRV',
          teams: [
            { name: 'ALP', score: 0 },
            { name: 'BRV', score: 0 },
          ],
          sets: [
            { scores: [25, 20] },
            { scores: [22, 25] },
            { scores: [15, 12] },
          ],
        },
        {
          owner: user._id,
          title: 'DLT vs ECH',
          teams: [
            { name: 'DLT', score: 0 },
            { name: 'ECH', score: 0 },
          ],
          sets: [],
        },
        {
          owner: user._id,
          title: 'BRV vs CHR',
          teams: [
            { name: 'BRV', score: 0 },
            { name: 'CHR', score: 0 },
          ],
          sets: [],
        },
      ],
      { ordered: true }
    );

    const [playMatch, refMatch, byeMatch] = await Match.insertMany(
      [
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          roundBlock: 1,
          facility: 'SRC',
          court: 'SRC-1',
          facilityId: 'SRC',
          courtId: 'SRC-1',
          teamAId: teamA._id,
          teamBId: teamB._id,
          refTeamIds: [teamC._id],
          plannedSlotId: 'slot-play-1',
          scoreboardId: scoreboardPlay._id,
          status: 'final',
          result: {
            winnerTeamId: teamA._id,
            loserTeamId: teamB._id,
            setsWonA: 2,
            setsWonB: 1,
            setsPlayed: 3,
            pointsForA: 62,
            pointsAgainstA: 57,
            pointsForB: 57,
            pointsAgainstB: 62,
            setScores: [
              { setNo: 1, a: 25, b: 20 },
              { setNo: 2, a: 22, b: 25 },
              { setNo: 3, a: 15, b: 12 },
            ],
          },
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          roundBlock: 2,
          facility: 'SRC',
          court: 'SRC-2',
          facilityId: 'SRC',
          courtId: 'SRC-2',
          teamAId: teamD._id,
          teamBId: teamE._id,
          refTeamIds: [teamA._id],
          plannedSlotId: 'slot-ref-1',
          scoreboardId: scoreboardRef._id,
          status: 'scheduled',
        },
        {
          tournamentId: tournament._id,
          phase: 'phase1',
          stageKey: 'poolPlay1',
          roundBlock: 3,
          facility: 'SRC',
          court: 'SRC-3',
          facilityId: 'SRC',
          courtId: 'SRC-3',
          teamAId: teamB._id,
          teamBId: teamC._id,
          refTeamIds: [teamD._id],
          plannedSlotId: 'slot-bye-1',
          scoreboardId: scoreboardBye._id,
          status: 'scheduled',
        },
      ],
      { ordered: true }
    );

    await Tournament.updateOne(
      { _id: tournament._id },
      {
        $set: {
          'settings.schedulePlan.slots': [
            {
              slotId: 'slot-play-1',
              stageKey: 'poolPlay1',
              roundBlock: 1,
              timeIndex: 540,
              courtId: 'SRC-1',
              facilityId: 'SRC',
              kind: 'match',
              participants: [
                { type: 'teamId', teamId: teamA._id },
                { type: 'teamId', teamId: teamB._id },
              ],
              ref: { type: 'teamId', teamId: teamC._id },
              matchId: playMatch._id,
            },
            {
              slotId: 'slot-ref-1',
              stageKey: 'poolPlay1',
              roundBlock: 2,
              timeIndex: 600,
              courtId: 'SRC-2',
              facilityId: 'SRC',
              kind: 'match',
              participants: [
                { type: 'teamId', teamId: teamD._id },
                { type: 'teamId', teamId: teamE._id },
              ],
              ref: { type: 'teamId', teamId: teamA._id },
              matchId: refMatch._id,
            },
            {
              slotId: 'slot-bye-1',
              stageKey: 'poolPlay1',
              roundBlock: 3,
              timeIndex: 660,
              courtId: 'SRC-3',
              facilityId: 'SRC',
              kind: 'match',
              participants: [
                { type: 'teamId', teamId: teamB._id },
                { type: 'teamId', teamId: teamC._id },
              ],
              ref: { type: 'teamId', teamId: teamD._id },
              byeRefs: [{ type: 'teamId', teamId: teamA._id }],
              matchId: byeMatch._id,
            },
            {
              slotId: 'lunch:main',
              stageKey: 'lunch',
              roundBlock: null,
              timeIndex: 720,
              courtId: null,
              facilityId: null,
              kind: 'lunch',
              participants: [],
              ref: null,
              matchId: null,
            },
          ],
        },
      }
    );

    const response = await request(app).get('/api/tournaments/code/TMTL01/team/TEAM0001');

    expect(response.statusCode).toBe(200);
    expect(response.body.tournament).toEqual(
      expect.objectContaining({
        id: String(tournament._id),
        publicCode: 'TMTL01',
      })
    );
    expect(Array.isArray(response.body.timeline)).toBe(true);
    expect(response.body.timeline.map((entry) => entry.role)).toEqual(['PLAY', 'REF', 'BYE', 'LUNCH']);

    const playEntry = response.body.timeline.find((entry) => entry.role === 'PLAY');
    expect(playEntry).toEqual(
      expect.objectContaining({
        matchId: String(playMatch._id),
        scoreboardCode: scoreboardPlay.code,
      })
    );
    expect(playEntry.setSummary).toEqual(
      expect.objectContaining({
        setsA: 2,
        setsB: 1,
        setScores: [
          { setNo: 1, a: 25, b: 20 },
          { setNo: 2, a: 22, b: 25 },
          { setNo: 3, a: 15, b: 12 },
        ],
      })
    );

    const lunchEntry = response.body.timeline.find((entry) => entry.role === 'LUNCH');
    expect(lunchEntry).toBeTruthy();
    expect(lunchEntry.timeLabel).toBeTruthy();
  });
});
