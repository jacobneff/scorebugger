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
      crossoverGenerate.body.every((match) => String(match.court || '').startsWith('VC-'))
    ).toBe(true);
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
});
