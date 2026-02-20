const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const matchRoutes = require('../routes/matches');
const tournamentRoutes = require('../routes/tournaments');
const Match = require('../models/Match');
const Pool = require('../models/Pool');
const Scoreboard = require('../models/Scoreboard');
const Tournament = require('../models/Tournament');
const TournamentTeam = require('../models/TournamentTeam');
const User = require('../models/User');

describe('manual finalize + standings routes', () => {
  let mongo;
  let app;
  let user;
  let token;
  let tournamentCodeCounter = 1;
  let ioToMock;
  let ioEmitMock;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'standings-route-tests',
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
      name: `PR3 Tournament ${suffix}`,
      date: new Date('2026-07-01T12:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: `P${suffix}`,
      createdByUserId: user._id,
    });
  }

  async function createTeams(tournamentId, names) {
    return TournamentTeam.insertMany(
      names.map((name, index) => ({
        tournamentId,
        name,
        shortName: name.slice(0, 3).toUpperCase(),
        seed: index + 1,
      })),
      { ordered: true }
    );
  }

  async function createScoreboardWithSets(teamAName, teamBName, sets) {
    return Scoreboard.create({
      owner: user._id,
      title: `${teamAName} vs ${teamBName}`,
      teams: [{ name: teamAName }, { name: teamBName }],
      sets: sets.map((scores) => ({ scores })),
    });
  }

  async function createMatch({
    tournamentId,
    teamAId,
    teamBId,
    scoreboardId,
    poolId = null,
    roundBlock = 1,
  }) {
    return Match.create({
      tournamentId,
      phase: 'phase1',
      poolId,
      roundBlock,
      facility: 'SRC',
      court: 'SRC-1',
      teamAId,
      teamBId,
      refTeamIds: [],
      scoreboardId,
      status: 'scheduled',
    });
  }

  async function finalizeMatch(matchId) {
    return request(app)
      .post(`/api/matches/${matchId}/finalize?override=true`)
      .set(authHeader());
  }

  async function getStandings(tournamentId) {
    return request(app)
      .get(`/api/tournaments/${tournamentId}/standings?phase=phase1`)
      .set(authHeader());
  }

  test('finalize fails when scoreboard is incomplete', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB] = await createTeams(tournament._id, ['Alpha', 'Bravo']);
    const scoreboard = await createScoreboardWithSets('Alpha', 'Bravo', [
      [25, 19],
      [20, 25],
    ]);
    const match = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      scoreboardId: scoreboard._id,
    });

    const response = await finalizeMatch(match._id);

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/completed best-of-3/i);

    const storedMatch = await Match.findById(match._id).lean();
    expect(storedMatch.status).toBe('scheduled');
    expect(storedMatch.result).toBeNull();
    expect(storedMatch.finalizedAt).toBeNull();
  });

  test('finalize writes snapshot fields and marks match final', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB] = await createTeams(tournament._id, ['Alpha', 'Bravo']);
    const scoreboard = await createScoreboardWithSets('Alpha', 'Bravo', [
      [25, 20],
      [18, 25],
      [15, 10],
    ]);
    const match = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      scoreboardId: scoreboard._id,
    });

    const response = await finalizeMatch(match._id);

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('final');
    expect(response.body.result).toEqual(
      expect.objectContaining({
        winnerTeamId: teamA._id.toString(),
        loserTeamId: teamB._id.toString(),
        setsWonA: 2,
        setsWonB: 1,
        setsPlayed: 3,
        pointsForA: 58,
        pointsAgainstA: 55,
        pointsForB: 55,
        pointsAgainstB: 58,
      })
    );

    const storedMatch = await Match.findById(match._id).lean();
    expect(storedMatch.status).toBe('final');
    expect(storedMatch.finalizedAt).toBeTruthy();
    expect(storedMatch.finalizedBy.toString()).toBe(user._id.toString());
    expect(storedMatch.result.setScores).toHaveLength(3);
  });

  test('finalize emits MATCH_FINALIZED to tournament room', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB] = await createTeams(tournament._id, ['Alpha', 'Bravo']);
    const scoreboard = await createScoreboardWithSets('Alpha', 'Bravo', [
      [25, 20],
      [25, 18],
    ]);
    const match = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      scoreboardId: scoreboard._id,
    });

    const response = await finalizeMatch(match._id);

    expect(response.statusCode).toBe(200);

    const finalizedCall = ioEmitMock.mock.calls.find(
      ([eventName, payload]) =>
        eventName === 'tournament:event' && payload?.type === 'MATCH_FINALIZED'
    );

    expect(ioToMock).toHaveBeenCalledWith(`tournament:${tournament.publicCode}`);
    expect(finalizedCall?.[1]).toEqual(
      expect.objectContaining({
        tournamentCode: tournament.publicCode,
        type: 'MATCH_FINALIZED',
        data: {
          matchId: match._id.toString(),
        },
        ts: expect.any(Number),
      })
    );
  });

  test('standings only count finalized matches', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB, teamC] = await createTeams(tournament._id, ['Alpha', 'Bravo', 'Charlie']);

    await Pool.create({
      tournamentId: tournament._id,
      phase: 'phase1',
      name: 'A',
      homeCourt: 'SRC-1',
      teamIds: [teamA._id, teamB._id, teamC._id],
    });

    const finalizedBoard = await createScoreboardWithSets('Alpha', 'Bravo', [
      [25, 18],
      [25, 22],
    ]);
    const unfinalizedBoard = await createScoreboardWithSets('Alpha', 'Charlie', [
      [25, 23],
      [25, 21],
    ]);

    const matchA = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      scoreboardId: finalizedBoard._id,
      roundBlock: 1,
    });
    await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamC._id,
      scoreboardId: unfinalizedBoard._id,
      roundBlock: 2,
    });

    await finalizeMatch(matchA._id);

    const standings = await getStandings(tournament._id);
    expect(standings.statusCode).toBe(200);

    const byTeamId = Object.fromEntries(
      standings.body.overall.map((team) => [team.teamId, team])
    );

    expect(byTeamId[teamA._id.toString()]).toEqual(
      expect.objectContaining({
        matchesPlayed: 1,
        matchesWon: 1,
      })
    );
    expect(byTeamId[teamB._id.toString()]).toEqual(
      expect.objectContaining({
        matchesPlayed: 1,
        matchesLost: 1,
      })
    );
    expect(byTeamId[teamC._id.toString()]).toEqual(
      expect.objectContaining({
        matchesPlayed: 0,
        matchesWon: 0,
      })
    );
  });

  test('unfinalize removes match from standings', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB] = await createTeams(tournament._id, ['Alpha', 'Bravo']);
    const scoreboard = await createScoreboardWithSets('Alpha', 'Bravo', [
      [25, 20],
      [25, 18],
    ]);
    const match = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      scoreboardId: scoreboard._id,
    });

    await finalizeMatch(match._id);

    const before = await getStandings(tournament._id);
    const beforeA = before.body.overall.find((team) => team.teamId === teamA._id.toString());
    expect(beforeA.matchesPlayed).toBe(1);

    const unfinalize = await request(app)
      .post(`/api/matches/${match._id}/unfinalize`)
      .set(authHeader());

    expect(unfinalize.statusCode).toBe(200);
    expect(unfinalize.body.status).toBe('ended');
    expect(unfinalize.body.result).toBeNull();

    const after = await getStandings(tournament._id);
    const afterA = after.body.overall.find((team) => team.teamId === teamA._id.toString());
    expect(afterA.matchesPlayed).toBe(0);
    expect(afterA.matchesWon).toBe(0);
  });

  test('head-to-head tiebreak ranks two tied teams by their finalized matchup', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB, teamC, teamD] = await createTeams(tournament._id, [
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
    ]);

    const boardAB = await createScoreboardWithSets('Alpha', 'Bravo', [
      [25, 23],
      [25, 23],
    ]);
    const boardAC = await createScoreboardWithSets('Alpha', 'Charlie', [
      [23, 25],
      [23, 25],
    ]);
    const boardBD = await createScoreboardWithSets('Bravo', 'Delta', [
      [25, 23],
      [25, 23],
    ]);

    const matchAB = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamB._id,
      scoreboardId: boardAB._id,
      roundBlock: 1,
    });
    const matchAC = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamA._id,
      teamBId: teamC._id,
      scoreboardId: boardAC._id,
      roundBlock: 2,
    });
    const matchBD = await createMatch({
      tournamentId: tournament._id,
      teamAId: teamB._id,
      teamBId: teamD._id,
      scoreboardId: boardBD._id,
      roundBlock: 3,
    });

    await finalizeMatch(matchAB._id);
    await finalizeMatch(matchAC._id);
    await finalizeMatch(matchBD._id);

    const standings = await getStandings(tournament._id);
    expect(standings.statusCode).toBe(200);

    const teamIdsInOrder = standings.body.overall.map((team) => team.teamId);
    const alphaIndex = teamIdsInOrder.indexOf(teamA._id.toString());
    const bravoIndex = teamIdsInOrder.indexOf(teamB._id.toString());

    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(bravoIndex).toBeGreaterThanOrEqual(0);
    expect(alphaIndex).toBeLessThan(bravoIndex);
  });

  test('standings overrides validate permutations and deterministically reorder ties', async () => {
    const tournament = await createOwnedTournament();
    const [teamA, teamB, teamC] = await createTeams(tournament._id, ['Alpha', 'Bravo', 'Charlie']);

    const invalidOverride = await request(app)
      .put(`/api/tournaments/${tournament._id}/standings-overrides`)
      .set(authHeader())
      .send({
        phase: 'phase1',
        overallOrder: [teamA._id.toString(), teamB._id.toString()],
      });

    expect(invalidOverride.statusCode).toBe(400);
    expect(invalidOverride.body.message).toMatch(/permutation/i);

    const desiredOrder = [teamC._id.toString(), teamB._id.toString(), teamA._id.toString()];
    const validOverride = await request(app)
      .put(`/api/tournaments/${tournament._id}/standings-overrides`)
      .set(authHeader())
      .send({
        phase: 'phase1',
        overallOrder: desiredOrder,
      });

    expect(validOverride.statusCode).toBe(200);
    expect(validOverride.body.overrides.overallOrderOverrides).toEqual(desiredOrder);

    const standings = await getStandings(tournament._id);
    expect(standings.statusCode).toBe(200);
    expect(standings.body.overall.map((team) => team.teamId)).toEqual(desiredOrder);
  });
});
