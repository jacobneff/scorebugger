const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const tournamentRoutes = require('../routes/tournaments');
const tournamentInviteRoutes = require('../routes/tournamentInvites');
const Tournament = require('../models/Tournament');
const User = require('../models/User');

describe('tournament sharing routes', () => {
  let mongo;
  let app;
  let ownerUser;
  let ownerToken;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {
      dbName: 'tournament-sharing-tests',
    });
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));

    ownerUser = await User.create({
      email: 'owner@example.com',
      passwordHash: 'hashed',
      emailVerified: true,
      displayName: 'Owner User',
    });
    ownerToken = jwt.sign({ sub: ownerUser._id.toString() }, process.env.JWT_SECRET);

    app = express();
    app.use(express.json());
    app.use('/api/tournaments', tournamentRoutes);
    app.use('/api/tournament-invites', tournamentInviteRoutes);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const authHeader = (token) => ({
    Authorization: `Bearer ${token}`,
  });

  async function createUser({ email, displayName = '' }) {
    const user = await User.create({
      email,
      passwordHash: 'hashed',
      emailVerified: true,
      displayName,
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    return { user, token };
  }

  async function createTournament({ name = 'Sharing Tournament', code = 'SHAR01' } = {}) {
    return Tournament.create({
      name,
      date: new Date('2026-10-15T13:00:00.000Z'),
      timezone: 'America/New_York',
      publicCode: code,
      createdByUserId: ownerUser._id,
    });
  }

  test('owner can grant admin access by sharing with an existing user email', async () => {
    const tournament = await createTournament({ code: 'SHAR11' });
    const { user: adminUser } = await createUser({
      email: 'admin-existing@example.com',
      displayName: 'Existing Admin',
    });

    const shareResponse = await request(app)
      .post(`/api/tournaments/${tournament._id}/share/email`)
      .set(authHeader(ownerToken))
      .send({
        email: adminUser.email,
        role: 'admin',
      });

    expect(shareResponse.statusCode).toBe(200);
    expect(shareResponse.body.granted).toBe(true);
    expect(shareResponse.body.role).toBe('admin');

    const accessResponse = await request(app)
      .get(`/api/tournaments/${tournament._id}/access`)
      .set(authHeader(ownerToken));

    expect(accessResponse.statusCode).toBe(200);
    expect(accessResponse.body.owner.email).toBe(ownerUser.email);
    expect(accessResponse.body.admins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: adminUser._id.toString(),
          email: adminUser.email,
          role: 'admin',
        }),
      ])
    );
  });

  test('email invite token can only be accepted by matching account email', async () => {
    const tournament = await createTournament({ code: 'SHAR12' });
    const invitedEmail = 'invite-target@example.com';

    const inviteResponse = await request(app)
      .post(`/api/tournaments/${tournament._id}/share/email`)
      .set(authHeader(ownerToken))
      .send({
        email: invitedEmail,
        role: 'admin',
      });

    expect(inviteResponse.statusCode).toBe(201);
    expect(inviteResponse.body.inviteUrl).toBeTruthy();

    const inviteUrl = new URL(inviteResponse.body.inviteUrl);
    const inviteToken = inviteUrl.searchParams.get('token');
    expect(inviteToken).toBeTruthy();

    const { token: wrongUserToken } = await createUser({
      email: 'different-user@example.com',
      displayName: 'Wrong User',
    });

    const wrongAcceptResponse = await request(app)
      .post('/api/tournament-invites/accept')
      .set(authHeader(wrongUserToken))
      .send({ token: inviteToken });

    expect(wrongAcceptResponse.statusCode).toBe(403);

    const { user: invitedUser, token: invitedUserToken } = await createUser({
      email: invitedEmail,
      displayName: 'Invited User',
    });

    const acceptResponse = await request(app)
      .post('/api/tournament-invites/accept')
      .set(authHeader(invitedUserToken))
      .send({ token: inviteToken });

    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.body.joined).toBe(true);
    expect(acceptResponse.body.role).toBe('admin');
    expect(acceptResponse.body.tournamentId).toBe(tournament._id.toString());

    const accessResponse = await request(app)
      .get(`/api/tournaments/${tournament._id}/access`)
      .set(authHeader(ownerToken));

    expect(accessResponse.statusCode).toBe(200);
    expect(accessResponse.body.admins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: invitedUser._id.toString(),
          email: invitedEmail,
          role: 'admin',
        }),
      ])
    );
  });

  test('share link join is idempotent and disabled links reject new joins', async () => {
    const tournament = await createTournament({ code: 'SHAR13' });

    const shareLinkResponse = await request(app)
      .post(`/api/tournaments/${tournament._id}/share/link`)
      .set(authHeader(ownerToken));

    expect(shareLinkResponse.statusCode).toBe(201);
    expect(shareLinkResponse.body.joinUrl).toBeTruthy();

    const joinUrl = new URL(shareLinkResponse.body.joinUrl);
    const token = joinUrl.searchParams.get('token');
    expect(token).toBeTruthy();

    const { token: joinerToken } = await createUser({
      email: 'joiner@example.com',
      displayName: 'Joiner',
    });

    const firstJoin = await request(app)
      .post('/api/tournaments/join')
      .set(authHeader(joinerToken))
      .send({ token });
    expect(firstJoin.statusCode).toBe(200);
    expect(firstJoin.body.joined).toBe(true);
    expect(firstJoin.body.role).toBe('admin');

    const duplicateJoin = await request(app)
      .post('/api/tournaments/join')
      .set(authHeader(joinerToken))
      .send({ token });
    expect(duplicateJoin.statusCode).toBe(200);
    expect(duplicateJoin.body.joined).toBe(true);

    const disableResponse = await request(app)
      .patch(`/api/tournaments/${tournament._id}/share/link`)
      .set(authHeader(ownerToken))
      .send({ enabled: false });
    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.body.enabled).toBe(false);

    const { token: blockedJoinerToken } = await createUser({
      email: 'blocked-joiner@example.com',
      displayName: 'Blocked Joiner',
    });

    const blockedJoin = await request(app)
      .post('/api/tournaments/join')
      .set(authHeader(blockedJoinerToken))
      .send({ token });
    expect(blockedJoin.statusCode).toBe(400);
    expect(blockedJoin.body.message).toMatch(/invalid|disabled/i);
  });

  test('admins can manage tournament details, can leave, and cannot call owner-only sharing actions', async () => {
    const tournament = await createTournament({ code: 'SHAR14' });
    const { user: adminUser, token: adminToken } = await createUser({
      email: 'admin-leave@example.com',
      displayName: 'Admin Leave',
    });

    const grantResponse = await request(app)
      .post(`/api/tournaments/${tournament._id}/share/email`)
      .set(authHeader(ownerToken))
      .send({
        email: adminUser.email,
        role: 'admin',
      });
    expect(grantResponse.statusCode).toBe(200);

    const adminDetailsPatch = await request(app)
      .patch(`/api/tournaments/${tournament._id}/details`)
      .set(authHeader(adminToken))
      .send({
        specialNotes: 'Admin updated note',
      });
    expect(adminDetailsPatch.statusCode).toBe(200);
    expect(adminDetailsPatch.body.details.specialNotes).toBe('Admin updated note');

    const ownerOnlyShareLinkAttempt = await request(app)
      .post(`/api/tournaments/${tournament._id}/share/link`)
      .set(authHeader(adminToken));
    expect(ownerOnlyShareLinkAttempt.statusCode).toBe(404);

    const leaveResponse = await request(app)
      .post(`/api/tournaments/${tournament._id}/access/leave`)
      .set(authHeader(adminToken));
    expect(leaveResponse.statusCode).toBe(200);
    expect(leaveResponse.body.left).toBe(true);

    const postLeavePatch = await request(app)
      .patch(`/api/tournaments/${tournament._id}/details`)
      .set(authHeader(adminToken))
      .send({
        specialNotes: 'Should fail',
      });
    expect(postLeavePatch.statusCode).toBe(404);

    const ownerLeaveAttempt = await request(app)
      .post(`/api/tournaments/${tournament._id}/access/leave`)
      .set(authHeader(ownerToken));
    expect(ownerLeaveAttempt.statusCode).toBe(400);
  });

  test('ownership transfer promotes new owner and demotes previous owner to admin', async () => {
    const tournament = await createTournament({ code: 'SHAR15' });
    const { user: nextOwner, token: nextOwnerToken } = await createUser({
      email: 'next-owner@example.com',
      displayName: 'Next Owner',
    });

    const transferResponse = await request(app)
      .patch(`/api/tournaments/${tournament._id}/owner`)
      .set(authHeader(ownerToken))
      .send({
        userId: nextOwner._id.toString(),
      });

    expect(transferResponse.statusCode).toBe(200);
    expect(transferResponse.body.transferred).toBe(true);
    expect(transferResponse.body.owner.userId).toBe(nextOwner._id.toString());
    expect(transferResponse.body.owner.role).toBe('owner');

    const oldOwnerOwnerOnlyAttempt = await request(app)
      .patch(`/api/tournaments/${tournament._id}/owner`)
      .set(authHeader(ownerToken))
      .send({
        userId: ownerUser._id.toString(),
      });
    expect(oldOwnerOwnerOnlyAttempt.statusCode).toBe(404);

    const newOwnerShareLink = await request(app)
      .post(`/api/tournaments/${tournament._id}/share/link`)
      .set(authHeader(nextOwnerToken));
    expect(newOwnerShareLink.statusCode).toBe(201);
    expect(newOwnerShareLink.body.joinUrl).toBeTruthy();

    const oldOwnerStillAdminPatch = await request(app)
      .patch(`/api/tournaments/${tournament._id}/details`)
      .set(authHeader(ownerToken))
      .send({
        specialNotes: 'Previous owner still admin',
      });
    expect(oldOwnerStillAdminPatch.statusCode).toBe(200);
  });
});
