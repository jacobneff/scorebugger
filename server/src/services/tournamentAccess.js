const mongoose = require('mongoose');

const Tournament = require('../models/Tournament');
const TournamentAccess = require('../models/TournamentAccess');

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

function toIdString(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value._id) {
    return String(value._id);
  }

  return String(value);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveTournamentProjection(projection = '') {
  const requiredFields = ['_id', 'createdByUserId', 'publicCode'];
  const requestedFields =
    typeof projection === 'string'
      ? projection
          .split(/\s+/)
          .map((field) => field.trim())
          .filter(Boolean)
      : [];

  return [...new Set([...requiredFields, ...requestedFields])].join(' ');
}

async function getTournamentAccessContext(tournamentId, userId, projection = '') {
  if (!isObjectId(tournamentId) || !isObjectId(userId)) {
    return null;
  }

  const tournament = await Tournament.findById(tournamentId)
    .select(resolveTournamentProjection(projection))
    .lean();

  if (!tournament) {
    return null;
  }

  const ownerUserId = toIdString(tournament.createdByUserId);
  const normalizedUserId = toIdString(userId);

  if (ownerUserId && ownerUserId === normalizedUserId) {
    return {
      tournament,
      role: 'owner',
      isOwner: true,
      isAdmin: true,
    };
  }

  const adminAccess = await TournamentAccess.findOne({
    tournamentId: tournament._id,
    userId,
    role: 'admin',
  })
    .select('_id role')
    .lean();

  if (!adminAccess) {
    return null;
  }

  return {
    tournament,
    role: 'admin',
    isOwner: false,
    isAdmin: true,
  };
}

async function requireTournamentAdminContext(tournamentId, userId, projection = '') {
  return getTournamentAccessContext(tournamentId, userId, projection);
}

async function requireTournamentOwnerContext(tournamentId, userId, projection = '') {
  const context = await getTournamentAccessContext(tournamentId, userId, projection);
  return context?.isOwner ? context : null;
}

async function listUserAccessibleTournamentIds(userId) {
  if (!isObjectId(userId)) {
    return [];
  }

  const [ownerIds, adminIds] = await Promise.all([
    Tournament.find({ createdByUserId: userId }).distinct('_id'),
    TournamentAccess.find({ userId, role: 'admin' }).distinct('tournamentId'),
  ]);

  return [...new Set([...ownerIds, ...adminIds].map((entry) => toIdString(entry)).filter(Boolean))];
}

async function upsertTournamentAdminAccess(tournamentId, userId) {
  if (!isObjectId(tournamentId) || !isObjectId(userId)) {
    return null;
  }

  const tournament = await Tournament.findById(tournamentId).select('_id createdByUserId').lean();
  if (!tournament) {
    return null;
  }

  const ownerUserId = toIdString(tournament.createdByUserId);
  if (ownerUserId && ownerUserId === toIdString(userId)) {
    return {
      skipped: true,
      reason: 'owner',
    };
  }

  await TournamentAccess.updateOne(
    {
      tournamentId,
      userId,
    },
    {
      $set: {
        role: 'admin',
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    {
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  return TournamentAccess.findOne({ tournamentId, userId }).lean();
}

async function removeTournamentAdminAccess(tournamentId, userId) {
  if (!isObjectId(tournamentId) || !isObjectId(userId)) {
    return {
      deletedCount: 0,
    };
  }

  return TournamentAccess.deleteOne({
    tournamentId,
    userId,
    role: 'admin',
  });
}

async function listTournamentAdminAccessEntries(tournamentId) {
  if (!isObjectId(tournamentId)) {
    return [];
  }

  return TournamentAccess.find({
    tournamentId,
    role: 'admin',
  })
    .populate('userId', 'email displayName')
    .sort({ createdAt: 1 })
    .lean();
}

async function transferTournamentOwnership({ tournamentId, currentOwnerUserId, nextOwnerUserId }) {
  if (!isObjectId(tournamentId) || !isObjectId(currentOwnerUserId) || !isObjectId(nextOwnerUserId)) {
    return null;
  }

  const tournament = await Tournament.findOne({
    _id: tournamentId,
    createdByUserId: currentOwnerUserId,
  }).select('_id createdByUserId');

  if (!tournament) {
    return null;
  }

  const currentOwnerId = toIdString(currentOwnerUserId);
  const newOwnerId = toIdString(nextOwnerUserId);

  if (currentOwnerId === newOwnerId) {
    return tournament.toObject();
  }

  tournament.createdByUserId = nextOwnerUserId;
  await tournament.save();

  await Promise.all([
    TournamentAccess.deleteOne({
      tournamentId,
      userId: nextOwnerUserId,
    }),
    TournamentAccess.updateOne(
      {
        tournamentId,
        userId: currentOwnerUserId,
      },
      {
        $set: { role: 'admin' },
        $setOnInsert: { createdAt: new Date() },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ),
  ]);

  return tournament.toObject();
}

module.exports = {
  getTournamentAccessContext,
  listTournamentAdminAccessEntries,
  listUserAccessibleTournamentIds,
  normalizeEmail,
  removeTournamentAdminAccess,
  requireTournamentAdminContext,
  requireTournamentOwnerContext,
  toIdString,
  transferTournamentOwnership,
  upsertTournamentAdminAccess,
};
