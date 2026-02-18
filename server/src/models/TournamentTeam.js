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
    location: {
      label: {
        type: String,
        default: '',
        trim: true,
        maxlength: 160,
      },
      latitude: {
        type: Number,
        default: null,
        min: -90,
        max: 90,
      },
      longitude: {
        type: Number,
        default: null,
        min: -180,
        max: 180,
      },
    },
    orderIndex: {
      type: Number,
      default: null,
    },
    seed: {
      type: Number,
      default: null,
    },
    publicTeamCode: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      minlength: 8,
      maxlength: 8,
      match: /^[A-Z0-9]{8}$/,
    },
  },
  {
    timestamps: true,
  }
);

TournamentTeamSchema.index(
  { tournamentId: 1, publicTeamCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      publicTeamCode: { $type: 'string' },
    },
  }
);

const TournamentTeam = mongoose.model('TournamentTeam', TournamentTeamSchema);

module.exports = TournamentTeam;
