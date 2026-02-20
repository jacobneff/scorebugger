const mongoose = require('mongoose');

const TournamentAccessSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin'],
      required: true,
      default: 'admin',
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
  }
);

TournamentAccessSchema.index({ tournamentId: 1, userId: 1 }, { unique: true });

const TournamentAccess = mongoose.model('TournamentAccess', TournamentAccessSchema);

module.exports = TournamentAccess;
