const defaultTeams = [
  {
    name: "Home",
    color: "#2563eb",
    teamTextColor: "#ffffff",
    setColor: "#2563eb",
    scoreTextColor: "#ffffff",
    textColor: "#ffffff",
    score: 0,
  },
  {
    name: "Away",
    color: "#16a34a",
    teamTextColor: "#ffffff",
    setColor: "#16a34a",
    scoreTextColor: "#ffffff",
    textColor: "#ffffff",
    score: 0,
  },
];

const formatTeamName = (raw = "") => {
  const name = raw.trim().toUpperCase();
  if (!name) return "TEAM";
  return name.length > 10 ? name.slice(0, 10) : name;
};

const normalizeSet = (set) => {
  if (Array.isArray(set?.scores) && set.scores.length === 2) {
    const [home, away] = set.scores.map((value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : 0;
    });
    return [home, away];
  }

  const fallback = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };

  return [fallback(set?.home), fallback(set?.away)];
};

const sanitizeTeam = (team, index) => {
  const base = defaultTeams[index] ?? defaultTeams[0];
  return {
    name: team?.name?.trim() || base.name,
    color: team?.color || base.color,
    teamTextColor: team?.teamTextColor || team?.textColor || base.teamTextColor || base.textColor,
    setColor: team?.setColor || team?.color || base.setColor,
    scoreTextColor: team?.scoreTextColor || base.scoreTextColor || "#ffffff",
    textColor: team?.textColor || team?.teamTextColor || base.textColor,
    score: Number.isFinite(Number(team?.score))
      ? Math.max(0, Number(team.score))
      : base.score,
  };
};

export { defaultTeams, formatTeamName, normalizeSet, sanitizeTeam };
