const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const scoreboardRoutes = require('../routes/scoreboards');
const User = require('../models/User');
const Scoreboard = require('../models/Scoreboard');

describe('scoreboard routes', () => {
  let mongo;
  let app;
  let user;
  let token;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'scoreboard-tests',
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
    app.use('/api/scoreboards', scoreboardRoutes);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const authHeader = () => ({
    Authorization: `Bearer ${token}`,
  });

  test('creates a scoreboard with default values for a new owner', async () => {
    const response = await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({});

    expect(response.statusCode).toBe(201);
    expect(response.body.title).toBe('New Scoreboard');
    expect(response.body.owner).toBe(user._id.toString());
    expect(response.body.teams).toHaveLength(2);
    expect(response.body.servingTeamIndex).toBe(0);
  });

  test('increments default scoreboard titles per owner', async () => {
    await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({});

    const second = await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({});

    expect(second.statusCode).toBe(201);
    expect(second.body.title).toBe('New Scoreboard (2)');
  });

  test('renames a scoreboard when owner supplies a valid title', async () => {
    const created = await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({});

    const rename = await request(app)
      .patch(`/api/scoreboards/${created.body._id}`)
      .set(authHeader())
      .send({ title: '  Match Day  ' });

    expect(rename.statusCode).toBe(200);
    expect(rename.body.title).toBe('Match Day');
    expect(rename.body.owner).toBe(user._id.toString());
  });

  test('rejects protected routes without authorization', async () => {
    const response = await request(app).get('/api/scoreboards/mine');
    expect(response.statusCode).toBe(401);
  });

  test('lists scoreboards owned by the current user', async () => {
    const otherUser = await User.create({
      email: 'other@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });

    await Scoreboard.create({
      title: 'Unrelated board',
      owner: otherUser._id,
    });

    await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({ title: 'First' });

    await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({ title: 'Second' });

    const mine = await request(app)
      .get('/api/scoreboards/mine')
      .set(authHeader());

    expect(mine.statusCode).toBe(200);
    expect(mine.body).toHaveLength(2);
    expect(mine.body[0].title).toBe('Second');
    expect(mine.body[1].title).toBe('First');
  });

  test('fetches a scoreboard by id without authentication', async () => {
    const created = await request(app)
      .post('/api/scoreboards')
      .set(authHeader())
      .send({ title: 'Public board' });

    const response = await request(app).get(`/api/scoreboards/${created.body._id}`);

    expect(response.statusCode).toBe(200);
    expect(response.body.title).toBe('Public board');
    expect(response.body.code).toHaveLength(6);
  });

  test('creates a temporary scoreboard for anonymous users', async () => {
    const response = await request(app).post('/api/scoreboards/guest').send({
      title: '  Guest Final  ',
      teams: [
        { name: 'Home Team', color: '#123456' },
        { name: 'Away Team' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.owner).toBeNull();
    expect(response.body.temporary).toBe(true);
    expect(response.body.title).toBe('Guest Final');
    expect(response.body.teams).toHaveLength(2);
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('allows claiming a temporary scoreboard after signing in', async () => {
    const guest = await request(app).post('/api/scoreboards/guest').send({});

    const claim = await request(app)
      .patch(`/api/scoreboards/${guest.body._id}/claim`)
      .set(authHeader())
      .send();

    expect(claim.statusCode).toBe(200);
    expect(claim.body.owner).toBe(user._id.toString());
    expect(claim.body.temporary).toBe(false);
    expect(claim.body.expiresAt).toBeNull();
  });

  test('prevents claiming a scoreboard already owned by another user', async () => {
    const otherUser = await User.create({
      email: 'claimed@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
    });

    const owned = await Scoreboard.create({
      title: 'Owned',
      owner: otherUser._id,
    });

    const response = await request(app)
      .patch(`/api/scoreboards/${owned._id}/claim`)
      .set(authHeader())
      .send();

    expect(response.statusCode).toBe(403);
  });
});
