const MAX_TITLE_LENGTH = 30;
const MAX_TEAM_NAME_LENGTH = 30;
const MAX_SET_COUNT = 5;

const sanitizeTeams = (teams) => {
  if (!Array.isArray(teams) || teams.length !== 2) {
    return undefined;
  }

  const fallbackNames = ['Home', 'Away'];

  return teams.map((team, index) => {
    const name =
      typeof team?.name === 'string'
        ? team.name.trim().slice(0, MAX_TEAM_NAME_LENGTH) || fallbackNames[index]
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

    if (Number.isFinite(Number(team?.score))) {
      payload.score = Math.max(0, Number(team.score));
    }

    return payload;
  });
};

const sanitizeSet = (set) => {
  if (!set || !Array.isArray(set.scores) || set.scores.length !== 2) {
    return null;
  }

  const [homeScore, awayScore] = set.scores;
  const createdAt =
    set.createdAt && !Number.isNaN(Date.parse(set.createdAt))
      ? new Date(set.createdAt)
      : new Date();

  return {
    scores: [
      Math.max(0, Number(homeScore) || 0),
      Math.max(0, Number(awayScore) || 0),
    ],
    createdAt,
  };
};

module.exports = {
  MAX_TITLE_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  MAX_SET_COUNT,
  sanitizeTeams,
  sanitizeSet,
};
