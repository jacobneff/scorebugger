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

const SCHEDULE_DEFAULTS = {
  dayStartTime: '09:00',
  matchDurationMinutes: 60,
  lunchDurationMinutes: 45,
};

const TOURNAMENT_DETAILS_DEFAULTS = {
  specialNotes: '',
  foodText: '',
  foodLinkUrl: '',
  facilitiesInfo: '',
  parkingInfo: '',
  mapImageUrls: [],
};

const StandingsPhaseOverridesSchema = new mongoose.Schema(
  {
    poolOrderOverrides: {
      type: Map,
      of: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'TournamentTeam',
        },
      ],
      default: undefined,
    },
    overallOrderOverrides: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'TournamentTeam',
        },
      ],
      default: undefined,
    },
  },
  { _id: false }
);

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
      schedule: {
        dayStartTime: {
          type: String,
          default: SCHEDULE_DEFAULTS.dayStartTime,
          trim: true,
        },
        matchDurationMinutes: {
          type: Number,
          default: SCHEDULE_DEFAULTS.matchDurationMinutes,
        },
        lunchStartTime: {
          type: String,
          default: undefined,
          trim: true,
        },
        lunchDurationMinutes: {
          type: Number,
          default: SCHEDULE_DEFAULTS.lunchDurationMinutes,
        },
      },
    },
    standingsOverrides: {
      phase1: {
        type: StandingsPhaseOverridesSchema,
        default: undefined,
      },
      phase2: {
        type: StandingsPhaseOverridesSchema,
        default: undefined,
      },
    },
    details: {
      specialNotes: {
        type: String,
        default: TOURNAMENT_DETAILS_DEFAULTS.specialNotes,
      },
      foodInfo: {
        text: {
          type: String,
          default: TOURNAMENT_DETAILS_DEFAULTS.foodText,
        },
        linkUrl: {
          type: String,
          default: TOURNAMENT_DETAILS_DEFAULTS.foodLinkUrl,
        },
      },
      facilitiesInfo: {
        type: String,
        default: TOURNAMENT_DETAILS_DEFAULTS.facilitiesInfo,
      },
      parkingInfo: {
        type: String,
        default: TOURNAMENT_DETAILS_DEFAULTS.parkingInfo,
      },
      mapImageUrls: {
        type: [String],
        default: () => [...TOURNAMENT_DETAILS_DEFAULTS.mapImageUrls],
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
