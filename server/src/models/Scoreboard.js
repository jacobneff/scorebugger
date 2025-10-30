const crypto = require('crypto');
const mongoose = require('mongoose');

const TeamSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: 'Team',
      trim: true,
    },
    color: {
      type: String,
      default: '#ffffff',
    },
    teamTextColor: {
      type: String,
      default: '#ffffff',
    },
    setColor: {
      type: String,
      default: '#0b1a3a',
    },
    scoreTextColor: {
      type: String,
      default: '#ffffff',
    },
    textColor: {
      type: String,
      default: '#ffffff',
    },
    score: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const SetSchema = new mongoose.Schema(
  {
    scores: {
      type: [Number],
      default: [0, 0],
      validate: {
        validator: (value) =>
          Array.isArray(value) &&
          value.length === 2 &&
          value.every((score) => Number.isFinite(score) && score >= 0),
        message: 'Each set must include scores for both teams.',
      },
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const ScoreboardSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      unique: true,
      index: true,
      default: () =>
        crypto.randomBytes(3).toString('hex').toUpperCase(), // 6 hex chars
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: 'New Scoreboard',
    },
    teams: {
      type: [TeamSchema],
      validate: {
        validator: (value) => Array.isArray(value) && value.length === 2,
        message: 'Scoreboard must have exactly two teams',
      },
      default: [
        {
          name: 'Home',
          color: '#2563eb',
          teamTextColor: '#ffffff',
          setColor: '#0b1a3a',
          scoreTextColor: '#ffffff',
          textColor: '#ffffff',
          score: 0,
        },
        {
          name: 'Away',
          color: '#16a34a',
          teamTextColor: '#ffffff',
          setColor: '#0b1a3a',
          scoreTextColor: '#ffffff',
          textColor: '#ffffff',
          score: 0,
        },
      ],
    },
    servingTeamIndex: {
      type: Number,
      enum: [0, 1],
      default: 0,
    },
    sets: {
      type: [SetSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Scoreboard = mongoose.model('Scoreboard', ScoreboardSchema);

module.exports = Scoreboard;
