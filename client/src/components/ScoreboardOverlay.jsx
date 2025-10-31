import React from "react";
import { GiVolleyballBall } from "react-icons/gi";
import { MAX_COMPLETED_SETS, MAX_TOTAL_SETS } from "../constants/scoreboard.js";

function normalizeSet(set) {
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
}

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

function sanitizeTeam(team, index) {
  const base = defaultTeams[index] ?? defaultTeams[0];
  return {
    name: team?.name?.trim() || base.name,
    color: team?.color || base.color,
    teamTextColor: team?.teamTextColor || team?.textColor || base.teamTextColor || base.textColor,
    setColor: team?.setColor || team?.color || base.setColor,
    scoreTextColor: team?.scoreTextColor || base.scoreTextColor || '#ffffff',
    textColor: team?.textColor || team?.teamTextColor || base.textColor,
    score: Number.isFinite(Number(team?.score))
      ? Math.max(0, Number(team.score))
      : base.score,
  };
}

function ScoreboardOverlay({ scoreboard }) {
  if (!scoreboard) return null;

  const teams = [
    sanitizeTeam(scoreboard?.teams?.[0], 0),
    sanitizeTeam(scoreboard?.teams?.[1], 1),
  ];

  const rawCompletedSets = Array.isArray(scoreboard?.sets)
    ? scoreboard.sets.map(normalizeSet)
    : [];
  const hasRoomForLiveSet = rawCompletedSets.length < MAX_TOTAL_SETS;
  const completedSets = rawCompletedSets
    .slice(0, hasRoomForLiveSet ? MAX_COMPLETED_SETS : MAX_TOTAL_SETS);

  const liveScores = teams.map((team) => team.score ?? 0);
  const setColumns = completedSets.map((scores, index) => ({
    type: "set",
    label: `Set ${index + 1}`,
    scores,
    index,
  }));

  const allColumns = [
    {
      type: "names",
    },
    ...setColumns,
  ];

  if (hasRoomForLiveSet) {
    allColumns.push({
      type: "set",
      label: `Set ${completedSets.length + 1}`,
      scores: liveScores,
      isLive: true,
    });
  }

  const setColumnTemplate = 'minmax(96px, 96px)';
  const longestNameLength = Math.max(
    ...teams.map((team) => (team.name ? team.name.length : 0)),
    0
  );
  const calculatedNameWidth = Math.max(
    180,
    Math.min(308, 120 + longestNameLength * 11)
  );
  const columnTemplate = [
    `minmax(${calculatedNameWidth}px, ${calculatedNameWidth}px)`,
    ...Array(Math.max(allColumns.length - 1, 0)).fill(setColumnTemplate),
  ].join(' ');

  const rows = teams.map((team, index) => ({
    ...team,
    key: index === 0 ? "home" : "away",
    index,
    isServing: scoreboard?.servingTeamIndex === index,
  }));

  const sharedSetColor = teams[0]?.setColor || teams[0]?.color || "#0b1a3a";

  const frameClassName = `overlay-frame${scoreboard?.compact ? " is-compact" : ""}`;

  return (
    <div className={frameClassName}>
      <div className="overlay-grid" style={{ gridTemplateColumns: columnTemplate }}>
        {rows.map((row) =>
          allColumns.map((column, columnIndex) => {
            const isFirstColumn = columnIndex === 0;
            const isLastColumn = columnIndex === allColumns.length - 1;
            const edgeClasses = [
              isFirstColumn && row.index === 0 ? 'overlay-grid-cell--first-top' : null,
              isFirstColumn && row.index === 1 ? 'overlay-grid-cell--first-bottom' : null,
              isLastColumn && row.index === 0 ? 'overlay-grid-cell--last-top' : null,
              isLastColumn && row.index === 1 ? 'overlay-grid-cell--last-bottom' : null,
            ].filter(Boolean).join(' ');

            if (column.type === "names") {
              return (
                <div
                  key={`${row.key}-names-${columnIndex}`}
                  className={`overlay-grid-cell overlay-grid-cell--names${
                    row.index === 1 ? " overlay-grid-cell--bottom" : ""
                  }${row.isServing ? " is-serving" : ""}${edgeClasses ? ` ${edgeClasses}` : ""}`}
                  style={{ "--row-bg": row.color, "--row-text": row.teamTextColor || row.textColor }}
                >
                  <div className="overlay-name-content">
                    <span className="overlay-team-name" title={row.name}>
                      {formatTeamName(row.name)}
                    </span>
                    {row.isServing && (
                      <span className="overlay-serve-icon" aria-label={`${row.name} serving`}>
                        <GiVolleyballBall />
                      </span>
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div
                key={`${row.key}-col-${columnIndex}`}
                className={`overlay-grid-cell overlay-grid-cell--set${
                  column.isLive ? " is-live" : ""
                }${row.index === 1 ? " overlay-grid-cell--bottom" : ""}${edgeClasses ? ` ${edgeClasses}` : ""}`}
                style={{ "--row-bg": sharedSetColor, "--row-text": row.scoreTextColor || row.textColor }}
              >
                {row.index === 0 ? (
                  <span className="overlay-set-label">{column.label}</span>
                ) : (
                  <span className="overlay-set-label overlay-set-label--spacer" aria-hidden="true">
                    {column.label}
                  </span>
                )}
                <span className="overlay-set-score">{column.scores[row.index] ?? 0}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ScoreboardOverlay;
