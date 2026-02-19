const mongoose = require('mongoose');

const ALLOWED_HOME_COURTS = ['SRC-1', 'SRC-2', 'SRC-3', 'VC-1', 'VC-2'];

const resolveMaxTeamCount = (context) => {
  const fromDocument = Number(context?.requiredTeamCount);
  if (Number.isFinite(fromDocument) && fromDocument > 0) {
    return Math.floor(fromDocument);
  }

  if (typeof context?.getUpdate === 'function') {
    const update = context.getUpdate() || {};
    const fromUpdate = Number(
      update?.requiredTeamCount ??
        update?.$set?.requiredTeamCount ??
        update?.$setOnInsert?.requiredTeamCount
    );

    if (Number.isFinite(fromUpdate) && fromUpdate > 0) {
      return Math.floor(fromUpdate);
    }
  }

  return 3;
};

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
    stageKey: {
      type: String,
      default: null,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    requiredTeamCount: {
      type: Number,
      default: null,
      min: 1,
      max: 32,
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
        validator(value) {
          if (!Array.isArray(value)) {
            return false;
          }
          const maxTeamCount = resolveMaxTeamCount(this);

          return value.length <= maxTeamCount;
        },
        message() {
          const maxTeamCount = resolveMaxTeamCount(this);
          return `A pool can include at most ${maxTeamCount} teams.`;
        },
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

PoolSchema.index({ tournamentId: 1, phase: 1, stageKey: 1, name: 1 }, { unique: true });

const Pool = mongoose.model('Pool', PoolSchema);

module.exports = Pool;
