const MATCH_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  ENDED: 'ended',
  FINAL: 'final',
};

const VALID_MATCH_STATUSES = new Set(Object.values(MATCH_STATUS));

function normalizeMatchStatus(value, fallback = MATCH_STATUS.SCHEDULED) {
  const normalizedFallback = VALID_MATCH_STATUSES.has(fallback)
    ? fallback
    : MATCH_STATUS.SCHEDULED;
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';

  return VALID_MATCH_STATUSES.has(normalizedValue)
    ? normalizedValue
    : normalizedFallback;
}

function getMatchStatusMeta(status) {
  const normalized = normalizeMatchStatus(status);

  if (normalized === MATCH_STATUS.FINAL) {
    return {
      value: MATCH_STATUS.FINAL,
      label: 'Finalized',
      badgeClassName: 'phase1-status-badge--final',
    };
  }

  if (normalized === MATCH_STATUS.LIVE) {
    return {
      value: MATCH_STATUS.LIVE,
      label: 'Live',
      badgeClassName: 'phase1-status-badge--live',
    };
  }

  if (normalized === MATCH_STATUS.ENDED) {
    return {
      value: MATCH_STATUS.ENDED,
      label: 'Ended',
      badgeClassName: 'phase1-status-badge--ended',
    };
  }

  return {
    value: MATCH_STATUS.SCHEDULED,
    label: 'Scheduled',
    badgeClassName: 'phase1-status-badge--scheduled',
  };
}

function normalizeLifecycleTimestamp(value) {
  if (!value) {
    return '';
  }

  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? '' : asDate.toISOString();
}

function buildTournamentMatchControlHref({ matchId, scoreboardKey, status, startedAt, endedAt }) {
  const normalizedMatchId = typeof matchId === 'string' ? matchId.trim() : '';
  const normalizedScoreboardKey =
    typeof scoreboardKey === 'string' ? scoreboardKey.trim() : '';

  if (!normalizedMatchId || !normalizedScoreboardKey) {
    return '';
  }

  const query = new URLSearchParams({ status: normalizeMatchStatus(status) });
  const normalizedStartedAt = normalizeLifecycleTimestamp(startedAt);
  const normalizedEndedAt = normalizeLifecycleTimestamp(endedAt);

  if (normalizedStartedAt) {
    query.set('startedAt', normalizedStartedAt);
  }

  if (normalizedEndedAt) {
    query.set('endedAt', normalizedEndedAt);
  }

  return `/tournaments/matches/${encodeURIComponent(normalizedMatchId)}/control/${encodeURIComponent(
    normalizedScoreboardKey
  )}?${query.toString()}`;
}

export {
  MATCH_STATUS,
  buildTournamentMatchControlHref,
  getMatchStatusMeta,
  normalizeLifecycleTimestamp,
  normalizeMatchStatus,
};
