function toStartedAtMs(startedAt) {
  if (!startedAt) {
    return null;
  }

  const parsed = new Date(startedAt).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getElapsedSeconds(startedAt, nowMs = Date.now()) {
  const startedAtMs = toStartedAtMs(startedAt);
  if (startedAtMs === null) {
    return 0;
  }

  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}

function formatElapsedTimer(startedAt, nowMs = Date.now()) {
  const elapsedSeconds = getElapsedSeconds(startedAt, nowMs);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export { formatElapsedTimer, getElapsedSeconds };
