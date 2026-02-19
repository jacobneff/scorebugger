const mongoose = require('mongoose');

const TournamentShareLinkSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      unique: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['admin'],
      required: true,
      default: 'admin',
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    createdByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const TournamentShareLink = mongoose.model('TournamentShareLink', TournamentShareLinkSchema);

module.exports = TournamentShareLink;
