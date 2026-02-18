const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");

const normalizeLogoUrl = (value) => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeSeed = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
};

const serializeComparableTeam = (team) => ({
  name: normalizeText(team?.name),
  shortName: normalizeText(team?.shortName),
  seed: normalizeSeed(team?.seed),
  logoUrl: normalizeLogoUrl(team?.logoUrl),
});

const buildCreatePayload = (team) => {
  const normalized = serializeComparableTeam(team);
  const payload = {
    name: normalized.name,
    shortName: normalized.shortName,
  };

  if (normalized.seed !== null) {
    payload.seed = normalized.seed;
  }

  if (normalized.logoUrl !== null) {
    payload.logoUrl = normalized.logoUrl;
  }

  return payload;
};

const buildPatchPayload = (existingTeam, draftTeam) => {
  const previous = serializeComparableTeam(existingTeam);
  const current = serializeComparableTeam(draftTeam);
  const payload = {};

  if (previous.name !== current.name) {
    payload.name = current.name;
  }

  if (previous.shortName !== current.shortName) {
    payload.shortName = current.shortName;
  }

  if (previous.seed !== current.seed) {
    payload.seed = current.seed;
  }

  if (previous.logoUrl !== current.logoUrl) {
    payload.logoUrl = current.logoUrl;
  }

  return payload;
};

export function planTournamentTeamSync(existingTeams, draftTeams) {
  const existing = Array.isArray(existingTeams) ? existingTeams : [];
  const draft = Array.isArray(draftTeams) ? draftTeams : [];
  const existingById = new Map(
    existing
      .filter((team) => team?._id)
      .map((team) => [String(team._id), team])
  );

  const patches = [];
  const creates = [];
  const deletes = [];
  const keptIds = new Set();

  draft.forEach((team) => {
    const id = team?._id ? String(team._id) : "";
    const normalizedName = normalizeText(team?.name);
    const normalizedShortName = normalizeText(team?.shortName);

    if (id && existingById.has(id)) {
      keptIds.add(id);
      const payload = buildPatchPayload(existingById.get(id), team);
      if (Object.keys(payload).length > 0) {
        patches.push({ id, payload });
      }
      return;
    }

    if (!normalizedName && !normalizedShortName) {
      return;
    }

    creates.push(buildCreatePayload(team));
  });

  existingById.forEach((_team, id) => {
    if (!keptIds.has(id)) {
      deletes.push(id);
    }
  });

  return {
    patches,
    creates,
    deletes,
  };
}

