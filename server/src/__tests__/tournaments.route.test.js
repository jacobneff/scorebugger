const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentTeamRoutes = require('../routes/tournamentTeams');
const User = require('../models/User');
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
});
