const mongoose = require('mongoose');

const FACILITY_DEFAULTS = {
  SRC: ['SRC-1', 'SRC-2', 'SRC-3'],
  VC: ['VC-1', 'VC-2'],
};

const SCORING_DEFAULTS = {
  setTargets: [25, 25, 15],
  winBy: 2,
  caps: [27, 27, 17],
};

const TournamentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    timezone: {
      type: String,
      default: 'America/New_York',
      trim: true,
    },
    publicCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 6,
      maxlength: 6,
      match: /^[A-Z0-9]{6}$/,
      index: true,
    },
    status: {
      type: String,
      enum: ['setup', 'phase1', 'phase2', 'playoffs', 'complete'],
      default: 'setup',
    },
    facilities: {
      SRC: {
        type: [String],
        default: () => [...FACILITY_DEFAULTS.SRC],
      },
      VC: {
        type: [String],
        default: () => [...FACILITY_DEFAULTS.VC],
      },
    },
    settings: {
      scoring: {
        setTargets: {
          type: [Number],
          default: () => [...SCORING_DEFAULTS.setTargets],
        },
        winBy: {
          type: Number,
          default: SCORING_DEFAULTS.winBy,
        },
        caps: {
          type: [Number],
          default: () => [...SCORING_DEFAULTS.caps],
        },
      },
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

const Tournament = mongoose.model('Tournament', TournamentSchema);

module.exports = Tournament;
