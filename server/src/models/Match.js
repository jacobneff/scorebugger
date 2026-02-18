const mongoose = require('mongoose');
const Tournament = require('./Tournament');

const MatchResultSetScoreSchema = new mongoose.Schema(
  {
    setNo: {
      type: Number,
      required: true,
      min: 1,
    },
    a: {
      type: Number,
      required: true,
      min: 0,
    },
    b: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const MatchResultSchema = new mongoose.Schema(
  {
    winnerTeamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      required: true,
    },
    loserTeamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      required: true,
    },
    setsWonA: {
      type: Number,
      required: true,
      min: 0,
    },
    setsWonB: {
      type: Number,
      required: true,
      min: 0,
    },
    setsPlayed: {
      type: Number,
      required: true,
      min: 0,
    },
    pointsForA: {
      type: Number,
      required: true,
      min: 0,
    },
    pointsAgainstA: {
      type: Number,
      required: true,
      min: 0,
    },
    pointsForB: {
      type: Number,
      required: true,
      min: 0,
    },
    pointsAgainstB: {
      type: Number,
      required: true,
      min: 0,
    },
    setScores: {
      type: [MatchResultSetScoreSchema],
      default: [],
    },
  },
  { _id: false }
);

const MatchSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      index: true,
    },
    phase: {
      type: String,
      enum: ['phase1', 'phase2', 'playoffs'],
      required: true,
    },
    poolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pool',
      default: null,
    },
    bracket: {
      type: String,
      enum: ['gold', 'silver', 'bronze'],
      default: null,
    },
    bracketRound: {
      type: String,
      enum: ['R1', 'R2', 'R3'],
      default: null,
    },
    bracketMatchKey: {
      type: String,
      default: null,
      trim: true,
    },
    seedA: {
      type: Number,
      default: null,
      min: 1,
      max: 5,
    },
    seedB: {
      type: Number,
      default: null,
      min: 1,
      max: 5,
    },
    teamAFromMatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Match',
      default: null,
    },
    teamAFromSlot: {
      type: String,
      enum: ['winner', 'loser'],
      default: null,
    },
    teamBFromMatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Match',
      default: null,
    },
    teamBFromSlot: {
      type: String,
      enum: ['winner', 'loser'],
      default: null,
    },
    roundBlock: {
      type: Number,
      default: null,
    },
    facility: {
      type: String,
      enum: ['SRC', 'VC'],
      required: true,
    },
    court: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: async function validateCourt(value) {
          if (!value || !this.tournamentId || !this.facility) {
            return false;
          }

          const tournament = await Tournament.findById(this.tournamentId)
            .select('facilities')
            .lean();

          if (!tournament?.facilities) {
            return false;
          }

          const courts = Array.isArray(tournament.facilities[this.facility])
            ? tournament.facilities[this.facility]
            : [];

          return courts.includes(value);
        },
        message: 'Court must match a configured court for the selected facility.',
      },
    },
    teamAId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      default: null,
      validate: {
        validator(value) {
          if (this.phase === 'playoffs') {
            return true;
          }

          return Boolean(value);
        },
        message: 'teamAId is required for non-playoff matches',
      },
    },
    teamBId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      default: null,
      validate: {
        validator(value) {
          if (this.phase === 'playoffs') {
            return true;
          }

          return Boolean(value);
        },
        message: 'teamBId is required for non-playoff matches',
      },
    },
    refTeamIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'TournamentTeam',
        },
      ],
      default: [],
    },
    scoreboardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Scoreboard',
      default: null,
    },
    status: {
      type: String,
      enum: ['scheduled', 'live', 'final'],
      default: 'scheduled',
    },
    result: {
      type: MatchResultSchema,
      default: null,
    },
    finalizedAt: {
      type: Date,
      default: null,
    },
    finalizedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Match = mongoose.model('Match', MatchSchema);

module.exports = Match;
