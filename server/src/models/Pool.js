const mongoose = require('mongoose');

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
    },
  },
  {
    timestamps: true,
  }
);

const Pool = mongoose.model('Pool', PoolSchema);

module.exports = Pool;
