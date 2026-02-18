const Scoreboard = require('../models/Scoreboard');
const { normalizeScoringConfig } = require('./phase1');

const MAX_TITLE_LENGTH = 30;
const TEMPORARY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function sanitizeTeams(teams) {
  if (!Array.isArray(teams) || teams.length !== 2) {
    return undefined;
  }

  const fallbackNames = ['Home', 'Away'];

  return teams.map((team, index) => {
    const name =
      typeof team?.name === 'string'
        ? team.name.trim().slice(0, 10) || fallbackNames[index]
        : fallbackNames[index];

    const payload = {
      name,
      score: 0,
    };

    if (typeof team?.color === 'string' && team.color.trim()) {
      payload.color = team.color;
    }
    if (typeof team?.teamTextColor === 'string' && team.teamTextColor.trim()) {
      payload.teamTextColor = team.teamTextColor;
    }
    if (typeof team?.setColor === 'string' && team.setColor.trim()) {
      payload.setColor = team.setColor;
    }
    if (typeof team?.scoreTextColor === 'string' && team.scoreTextColor.trim()) {
      payload.scoreTextColor = team.scoreTextColor;
    }
    if (typeof team?.textColor === 'string' && team.textColor.trim()) {
      payload.textColor = team.textColor;
    }

    return payload;
  });
}

function normalizeServingTeamIndex(value) {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  return [0, 1].includes(parsed) ? parsed : undefined;
}

function resolveScoreboardTitle(title) {
  if (typeof title !== 'string') {
    return null;
  }

  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null;
}

async function createScoreboard({
  ownerId = null,
  title,
  teams,
  servingTeamIndex,
  temporary = false,
  scoring,
}) {
  const scoreboard = new Scoreboard({
    title: resolveScoreboardTitle(title) || undefined,
    teams: sanitizeTeams(teams),
    servingTeamIndex: normalizeServingTeamIndex(servingTeamIndex),
    owner: ownerId,
    temporary: Boolean(temporary),
    expiresAt: temporary ? new Date(Date.now() + TEMPORARY_LIFETIME_MS) : null,
    scoring: normalizeScoringConfig(scoring),
  });

  await scoreboard.save();
  return scoreboard;
}

async function createMatchScoreboard({
  ownerId,
  title,
  teamA,
  teamB,
  scoring,
}) {
  return createScoreboard({
    ownerId,
    title,
    teams: [
      {
        name: teamA?.shortName || teamA?.name || 'Team A',
      },
      {
        name: teamB?.shortName || teamB?.name || 'Team B',
      },
    ],
    servingTeamIndex: null,
    temporary: false,
    scoring,
  });
}

module.exports = {
  MAX_TITLE_LENGTH,
  TEMPORARY_LIFETIME_MS,
  createMatchScoreboard,
  createScoreboard,
  sanitizeTeams,
};
