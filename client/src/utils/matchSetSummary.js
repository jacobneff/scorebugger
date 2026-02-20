function clampScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function normalizeCompletedSetScores(setScores) {
  return (Array.isArray(setScores) ? setScores : [])
    .map((set, index) => ({
      setNo: Number.isFinite(Number(set?.setNo)) ? Number(set.setNo) : index + 1,
      a: clampScore(set?.a),
      b: clampScore(set?.b),
    }))
    .filter((set) => Number.isFinite(set.setNo));
}

function resolveCompletedSetScores(match) {
  const explicit = normalizeCompletedSetScores(match?.completedSetScores);
  if (explicit.length > 0) {
    return explicit;
  }

  const resultSetScores = normalizeCompletedSetScores(match?.result?.setScores);
  if (resultSetScores.length > 0) {
    return resultSetScores;
  }

  return normalizeCompletedSetScores(match?.setScores);
}

function formatCompletedSetScores(setScores) {
  const normalized = normalizeCompletedSetScores(setScores);
  return normalized.map((set) => `${set.a}-${set.b}`).join(', ');
}

function toSetSummaryFromScoreSummary(scoreSummary) {
  return {
    setsA: clampScore(scoreSummary?.setsA),
    setsB: clampScore(scoreSummary?.setsB),
  };
}

function toSetSummaryFromLiveSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return { setsA: 0, setsB: 0 };
  }

  if (summary.sets && typeof summary.sets === 'object') {
    return {
      setsA: clampScore(summary.sets.a),
      setsB: clampScore(summary.sets.b),
    };
  }

  return {
    setsA: clampScore(summary.setsA),
    setsB: clampScore(summary.setsB),
  };
}

function formatSetSummary(setsA, setsB) {
  return `Sets ${clampScore(setsA)}-${clampScore(setsB)}`;
}

function formatSetSummaryWithScores({ setsA, setsB }, completedSetScores) {
  const setSummary = formatSetSummary(setsA, setsB);
  const completed = formatCompletedSetScores(completedSetScores);
  return completed ? `${setSummary} • ${completed}` : setSummary;
}

export {
  formatCompletedSetScores,
  formatSetSummary,
  formatSetSummaryWithScores,
  normalizeCompletedSetScores,
  resolveCompletedSetScores,
  toSetSummaryFromLiveSummary,
  toSetSummaryFromScoreSummary,
};
