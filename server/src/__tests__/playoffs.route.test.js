const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const matchRoutes = require('../routes/matches');
const tournamentRoutes = require('../routes/tournaments');
const Match = require('../models/Match');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const User = require('../models/User');

describe('playoff generation + progression routes', () => {
  let mongo;
  let app;
  let user;
  let token;
  let tournamentCodeCounter = 1;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'playoff-route-tests',
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
      name: `PR5 Tournament ${suffix}`,
      date: new Date('2026-09-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: `R${suffix}`,
      createdByUserId: user._id,
    });
  }

  async function seedTeamsAndPhase2Override(tournamentId) {
    const teams = await TournamentTeam.insertMany(
      Array.from({ length: 15 }, (_, index) => ({
        tournamentId,
        name: `Team ${String(index + 1).padStart(2, '0')}`,
        shortName: `T${String(index + 1).padStart(2, '0')}`,
        seed: index + 1,
      })),
      { ordered: true }
    );

    await Tournament.updateOne(
      { _id: tournamentId },
      {
        $set: {
          'standingsOverrides.phase2.overallOrderOverrides': teams.map((team) => team._id),
        },
      }
    );

    return teams;
  }

  async function generatePlayoffs(tournamentId) {
    return request(app)
      .post(`/api/tournaments/${tournamentId}/generate/playoffs`)
      .set(authHeader());
  }

  async function setScoreboardSets(scoreboardId, homeWins = true) {
    const sets = homeWins
      ? [
          { scores: [25, 19] },
          { scores: [25, 18] },
        ]
      : [
          { scores: [18, 25] },
          { scores: [19, 25] },
        ];

    await Scoreboard.updateOne(
      { _id: scoreboardId },
      {
        $set: {
          sets,
          servingTeamIndex: null,
        },
      }
    );
  }

  test('generate playoffs creates 12 matches with exact ops roundBlock/court assignments', async () => {
    const tournament = await createOwnedTournament();
    await seedTeamsAndPhase2Override(tournament._id);

    const generate = await generatePlayoffs(tournament._id);

    expect(generate.statusCode).toBe(201);
    expect(generate.body.matches).toHaveLength(12);

    const byKey = Object.fromEntries(
      generate.body.matches.map((match) => [match.bracketMatchKey, match])
    );

    const expectedByKey = {
      'gold:R1:4v5': { roundBlock: 7, facility: 'SRC', court: 'SRC-1' },
      'gold:R1:2v3': { roundBlock: 7, facility: 'VC', court: 'VC-1' },
      'gold:R2:1vW45': { roundBlock: 8, facility: 'VC', court: 'VC-1' },
      'gold:R3:final': { roundBlock: 9, facility: 'VC', court: 'VC-1' },
      'silver:R1:4v5': { roundBlock: 7, facility: 'SRC', court: 'SRC-2' },
      'silver:R1:2v3': { roundBlock: 7, facility: 'VC', court: 'VC-2' },
      'silver:R2:1vW45': { roundBlock: 8, facility: 'VC', court: 'VC-2' },
      'silver:R3:final': { roundBlock: 9, facility: 'VC', court: 'VC-2' },
      'bronze:R1:4v5': { roundBlock: 7, facility: 'SRC', court: 'SRC-3' },
      'bronze:R1:2v3': { roundBlock: 8, facility: 'SRC', court: 'SRC-1' },
      'bronze:R2:1vW45': { roundBlock: 8, facility: 'SRC', court: 'SRC-2' },
      'bronze:R3:final': { roundBlock: 9, facility: 'SRC', court: 'SRC-1' },
    };

    Object.entries(expectedByKey).forEach(([matchKey, expected]) => {
      expect(byKey[matchKey]).toBeDefined();
      expect(byKey[matchKey].roundBlock).toBe(expected.roundBlock);
      expect(byKey[matchKey].facility).toBe(expected.facility);
      expect(byKey[matchKey].court).toBe(expected.court);
    });

    const [storedMatchCount, storedScoreboardCount] = await Promise.all([
      Match.countDocuments({ tournamentId: tournament._id, phase: 'playoffs' }),
      Scoreboard.countDocuments({ owner: user._id }),
    ]);

    expect(storedMatchCount).toBe(12);
    expect(storedScoreboardCount).toBe(12);
  });

  test('roundBlock 7 playoff refs match required hard-coded teams', async () => {
    const tournament = await createOwnedTournament();
    const teams = await seedTeamsAndPhase2Override(tournament._id);
    const generate = await generatePlayoffs(tournament._id);

    expect(generate.statusCode).toBe(201);

    const byKey = Object.fromEntries(
      generate.body.matches.map((match) => [match.bracketMatchKey, match])
    );

    expect(byKey['gold:R1:4v5'].refTeamIds).toEqual([teams[10]._id.toString()]);
    expect(byKey['silver:R1:4v5'].refTeamIds).toEqual([teams[11]._id.toString()]);
    expect(byKey['bronze:R1:4v5'].refTeamIds).toEqual([teams[12]._id.toString()]);
    expect(byKey['gold:R1:2v3'].refTeamIds).toEqual([teams[5]._id.toString()]);
    expect(byKey['silver:R1:2v3'].refTeamIds).toEqual([teams[0]._id.toString()]);
  });

  test('bracket split uses cumulative overall ranking and assigns bracket seeds 1..5', async () => {
    const tournament = await createOwnedTournament();
    const teams = await seedTeamsAndPhase2Override(tournament._id);
    const generate = await generatePlayoffs(tournament._id);

    expect(generate.statusCode).toBe(201);

    const seeds = generate.body.seeds;
    expect(seeds.gold.map((entry) => entry.teamId)).toEqual(
      teams.slice(0, 5).map((team) => team._id.toString())
    );
    expect(seeds.silver.map((entry) => entry.teamId)).toEqual(
      teams.slice(5, 10).map((team) => team._id.toString())
    );
    expect(seeds.bronze.map((entry) => entry.teamId)).toEqual(
      teams.slice(10, 15).map((team) => team._id.toString())
    );

    expect(seeds.gold.map((entry) => entry.bracketSeed)).toEqual([1, 2, 3, 4, 5]);
    expect(seeds.silver.map((entry) => entry.bracketSeed)).toEqual([1, 2, 3, 4, 5]);
    expect(seeds.bronze.map((entry) => entry.bracketSeed)).toEqual([1, 2, 3, 4, 5]);
  });

  test('finalizing a playoff R1 match updates the dependent R2 participants', async () => {
    const tournament = await createOwnedTournament();
    await seedTeamsAndPhase2Override(tournament._id);
    const generate = await generatePlayoffs(tournament._id);

    const byKey = Object.fromEntries(
      generate.body.matches.map((match) => [match.bracketMatchKey, match])
    );
    const goldR145 = byKey['gold:R1:4v5'];
    const goldR2Key = byKey['gold:R2:1vW45'];

    await setScoreboardSets(goldR145.scoreboardId, true);

    const finalize = await request(app)
      .post(`/api/matches/${goldR145._id}/finalize`)
      .set(authHeader());

    expect(finalize.statusCode).toBe(200);

    const storedGoldR2 = await Match.findById(goldR2Key._id).lean();
    expect(storedGoldR2.teamBId.toString()).toBe(goldR145.teamAId);
  });

  test('unfinalizing an upstream playoff match invalidates downstream finalized matches', async () => {
    const tournament = await createOwnedTournament();
    await seedTeamsAndPhase2Override(tournament._id);
    const generate = await generatePlayoffs(tournament._id);

    const byKey = Object.fromEntries(
      generate.body.matches.map((match) => [match.bracketMatchKey, match])
    );
    const goldR145 = byKey['gold:R1:4v5'];
    const goldR123 = byKey['gold:R1:2v3'];
    const goldR2 = byKey['gold:R2:1vW45'];
    const goldFinal = byKey['gold:R3:final'];

    await setScoreboardSets(goldR145.scoreboardId, true);
    await request(app).post(`/api/matches/${goldR145._id}/finalize`).set(authHeader());

    await setScoreboardSets(goldR123.scoreboardId, true);
    await request(app).post(`/api/matches/${goldR123._id}/finalize`).set(authHeader());

    await setScoreboardSets(goldR2.scoreboardId, false);
    await request(app).post(`/api/matches/${goldR2._id}/finalize`).set(authHeader());

    await setScoreboardSets(goldFinal.scoreboardId, true);
    const finalizeFinal = await request(app)
      .post(`/api/matches/${goldFinal._id}/finalize`)
      .set(authHeader());

    expect(finalizeFinal.statusCode).toBe(200);
    expect(finalizeFinal.body.status).toBe('final');

    const unfinalizeUpstream = await request(app)
      .post(`/api/matches/${goldR145._id}/unfinalize`)
      .set(authHeader());

    expect(unfinalizeUpstream.statusCode).toBe(200);

    const [storedGoldR2, storedGoldFinal, storedR2Scoreboard, storedFinalScoreboard] = await Promise.all([
      Match.findById(goldR2._id).lean(),
      Match.findById(goldFinal._id).lean(),
      Scoreboard.findById(goldR2.scoreboardId).lean(),
      Scoreboard.findById(goldFinal.scoreboardId).lean(),
    ]);

    expect(storedGoldR2.status).toBe('scheduled');
    expect(storedGoldR2.result).toBeNull();
    expect(storedGoldR2.teamBId).toBeNull();

    expect(storedGoldFinal.status).toBe('scheduled');
    expect(storedGoldFinal.result).toBeNull();
    expect(storedGoldFinal.teamAId).toBeNull();

    expect(storedR2Scoreboard.sets).toEqual([]);
    expect(storedFinalScoreboard.sets).toEqual([]);
  });

  test('public playoffs endpoint returns sanitized bracket/schedule payload', async () => {
    const tournament = await createOwnedTournament();
    await seedTeamsAndPhase2Override(tournament._id);
    await generatePlayoffs(tournament._id);

    const response = await request(app).get(
      `/api/tournaments/code/${tournament.publicCode}/playoffs`
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.matches).toHaveLength(12);
    expect(response.body.opsSchedule).toHaveLength(3);
    expect(response.body.brackets).toHaveProperty('gold');
    expect(response.body.brackets).toHaveProperty('silver');
    expect(response.body.brackets).toHaveProperty('bronze');

    response.body.matches.forEach((match) => {
      expect(match.finalizedBy).toBeUndefined();
      expect(match.scoreboardId).toBeUndefined();
    });
  });
});
