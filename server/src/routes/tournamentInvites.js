const express = require('express');

const { requireAuth } = require('../middleware/auth');
const TournamentInvite = require('../models/TournamentInvite');
const { hashToken } = require('../utils/tokens');
const {
  normalizeEmail,
  upsertTournamentAdminAccess,
} = require('../services/tournamentAccess');

const router = express.Router();

router.post('/accept', requireAuth, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      return res.status(400).json({ message: 'token is required' });
    }

    const tokenHash = hashToken(token);
    const invite = await TournamentInvite.findOne({
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).lean();

    if (!invite) {
      return res.status(400).json({ message: 'Invite token is invalid or expired' });
    }

    const inviteEmail = normalizeEmail(invite.email);
    const userEmail = normalizeEmail(req.user.email);

    if (!inviteEmail || !userEmail || inviteEmail !== userEmail) {
      return res.status(403).json({
        message: 'This invite can only be accepted by the invited email account',
      });
    }

    await upsertTournamentAdminAccess(invite.tournamentId, req.user.id);
    await TournamentInvite.updateOne(
      { _id: invite._id, usedAt: null },
      { $set: { usedAt: new Date() } }
    );

    return res.json({
      joined: true,
      role: invite.role || 'admin',
      tournamentId: String(invite.tournamentId),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
