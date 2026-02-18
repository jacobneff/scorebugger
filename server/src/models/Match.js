const mongoose = require('mongoose');
const Tournament = require('./Tournament');

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
      required: true,
    },
    teamBId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TournamentTeam',
      required: true,
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
