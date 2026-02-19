const express = require('express');

const {
  listFormats,
  suggestFormats,
} = require('../tournamentFormats/formatRegistry');

const router = express.Router();

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
};

const toFormatSummary = (formatDef) => ({
  id: formatDef.id,
  name: formatDef.name,
  description: formatDef.description || '',
  supportedTeamCounts: Array.isArray(formatDef.supportedTeamCounts)
    ? formatDef.supportedTeamCounts
    : [],
  minCourts: Number.isFinite(Number(formatDef.minCourts))
    ? Number(formatDef.minCourts)
    : null,
  maxCourts: Number.isFinite(Number(formatDef.maxCourts))
    ? Number(formatDef.maxCourts)
    : null,
});

// GET /api/tournament-formats
router.get('/', (_req, res) => {
  const formats = listFormats();
  return res.json(formats.map(toFormatSummary));
});

// GET /api/tournament-formats/suggest?teamCount=14&courtCount=5
router.get('/suggest', (req, res) => {
  const teamCount = toPositiveInteger(req.query?.teamCount);
  const courtCount = toPositiveInteger(req.query?.courtCount);

  if (!teamCount || !courtCount) {
    return res.status(400).json({
      message: 'teamCount and courtCount must be positive integers',
    });
  }

  const suggestions = suggestFormats(teamCount, courtCount);
  return res.json(suggestions.map(toFormatSummary));
});

module.exports = router;
