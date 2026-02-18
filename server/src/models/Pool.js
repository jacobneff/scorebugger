const mongoose = require('mongoose');

const ALLOWED_HOME_COURTS = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

const PoolRematchWarningSchema = new mongoose.Schema(
  {
    teamIdA: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      required: true,
    },
    teamIdB: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      required: true,
    },
  },
  { _id: false }
);

const PoolSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      index: true,
    },
    phase: {
      type: String,
      enum: ['phase1', 'phase2'],
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    teamIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'TournamentTeam',
        },
      ],
      required: true,
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length <= 3,
        message: 'A pool can include at most 3 teams in PR1.',
      },
    },
    homeCourt: {
      type: String,
      default: null,
      trim: true,
      set: (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
      validate: {
        validator: (value) => value === null || value === undefined || ALLOWED_HOME_COURTS.includes(value),
        message: 'homeCourt must be one of SRC-1, SRC-2, SRC-3, VC-1, or VC-2.',
      },
    },
    rematchWarnings: {
      type: [PoolRematchWarningSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Pool = mongoose.model('Pool', PoolSchema);

module.exports = Pool;
