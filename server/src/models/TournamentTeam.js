const mongoose = require('mongoose');

const TournamentTeamSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    shortName: {
      type: String,
      required: true,
      trim: true,
    },
    logoUrl: {
      type: String,
      default: null,
      trim: true,
    },
    seed: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const TournamentTeam = mongoose.model('TournamentTeam', TournamentTeamSchema);

module.exports = TournamentTeam;
