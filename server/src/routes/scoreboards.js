const express = require('express');
const mongoose = require('mongoose');
const Scoreboard = require('../models/Scoreboard');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const MAX_TITLE_LENGTH = 30;
const TEMPORARY_LIFETIME_MS = 24 * 60 * 60 * 1000;

const sanitizeTeams = (teams) => {
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
};

const resolveScoreboardQuery = (idOrCode) =>
  mongoose.Types.ObjectId.isValid(idOrCode)
    ? { _id: idOrCode }
    : { code: idOrCode.toUpperCase() };

// POST /api/scoreboards -> create a new scoreboard instance
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { teams, servingTeamIndex, title } = req.body ?? {};
    const parsedServingIndex = Number(servingTeamIndex);

    // Determine the base title
    let scoreboardTitle = title?.trim();
    if (scoreboardTitle) {
      scoreboardTitle = scoreboardTitle.slice(0, MAX_TITLE_LENGTH);
    } else {
      const count = await Scoreboard.countDocuments({ owner: req.user.id });
      scoreboardTitle = count === 0 ? 'New Scoreboard' : `New Scoreboard (${count + 1})`;
    }

    const scoreboard = new Scoreboard({
      title: scoreboardTitle,
      teams: sanitizeTeams(teams),
      servingTeamIndex: [0, 1].includes(parsedServingIndex) ? parsedServingIndex : undefined,
      owner: req.user.id,
      temporary: false,
      expiresAt: null,
    });

    await scoreboard.save();
    res.status(201).json(scoreboard.toObject());
  } catch (error) {
    next(error);
  }
});

// POST /api/scoreboards/guest -> create a temporary scoreboard for anonymous users
router.post('/guest', async (req, res, next) => {
  try {
    const { teams, servingTeamIndex, title } = req.body ?? {};
    const parsedServingIndex = Number(servingTeamIndex);
    const now = Date.now();

    const scoreboard = new Scoreboard({
      title: typeof title === 'string' && title.trim()
        ? title.trim().slice(0, MAX_TITLE_LENGTH)
        : 'Temporary Scoreboard',
      teams: sanitizeTeams(teams),
      servingTeamIndex: [0, 1].includes(parsedServingIndex) ? parsedServingIndex : undefined,
      owner: null,
      temporary: true,
      expiresAt: new Date(now + TEMPORARY_LIFETIME_MS),
    });

    await scoreboard.save();
    res.status(201).json(scoreboard.toObject());
  } catch (error) {
    next(error);
  }
});


// GET /api/scoreboards/mine -> list scoreboards owned by current user
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const boards = await Scoreboard.find({ owner: req.user.id })
      .sort({ updatedAt: -1 })
      .lean();

    res.json(boards);
  } catch (error) {
    next(error);
  }
});

// GET /api/scoreboards/:id -> fetch scoreboard by Mongo id or code
router.get('/:idOrCode', async (req, res, next) => {
  try {
    const { idOrCode } = req.params;
    const query = resolveScoreboardQuery(idOrCode);

    const scoreboard = await Scoreboard.findOne(query).lean();

    if (!scoreboard) {
      return res.status(404).json({ message: 'Scoreboard not found' });
    }

    return res.json(scoreboard);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/scoreboards/:id/claim -> attach a temporary scoreboard to the current user
router.patch('/:idOrCode/claim', requireAuth, async (req, res, next) => {
  try {
    const { idOrCode } = req.params;
    const query = resolveScoreboardQuery(idOrCode);

    const scoreboard = await Scoreboard.findOne(query);

    if (!scoreboard) {
      return res.status(404).json({ message: 'Scoreboard not found' });
    }

    const ownerId = scoreboard.owner ? scoreboard.owner.toString() : null;
    if (ownerId && ownerId !== req.user.id) {
      return res.status(403).json({ message: 'Scoreboard already claimed' });
    }

    scoreboard.owner = req.user.id;
    scoreboard.temporary = false;
    scoreboard.expiresAt = null;

    if (!scoreboard.title?.trim()) {
      scoreboard.title = 'New Scoreboard';
    }

    await scoreboard.save();

    const io = req.app?.get('io');
    if (io && scoreboard?._id) {
      io.to(scoreboard._id.toString()).emit('scoreboard:state', scoreboard.toObject());
    }

    res.json(scoreboard.toObject());
  } catch (error) {
    next(error);
  }
});

// PATCH /api/scoreboards/:id -> rename a scoreboard
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'Invalid title provided' });
    }

    const ownerCandidates = mongoose.Types.ObjectId.isValid(req.user.id)
      ? [new mongoose.Types.ObjectId(req.user.id), req.user.id]
      : [req.user.id];

    const board = await Scoreboard.findOneAndUpdate(
      { _id: id, owner: { $in: ownerCandidates } },
      { title: title.trim() },
      { new: true, runValidators: true }
    );

    if (!board) {
      const legacyBoard = await Scoreboard.findOne({ _id: id, owner: null });

      if (legacyBoard) {
        legacyBoard.title = title.trim();
        legacyBoard.owner = req.user.id;
        legacyBoard.temporary = false;
        legacyBoard.expiresAt = null;
        await legacyBoard.save();
        return res.json(legacyBoard.toObject());
      }

      // eslint-disable-next-line no-console
      console.warn('Scoreboard rename failed', {
        scoreboardId: id,
        ownerId: req.user.id,
      });
      return res.status(404).json({ message: 'Scoreboard not found or unauthorized' });
    }

    res.json(board.toObject());
  } catch (error) {
    next(error);
  }
});


// DELETE /api/scoreboards/:id -> remove a scoreboard
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const deleted = await Scoreboard.findOneAndDelete({
      _id: id,
      owner: req.user.id,
    }).lean();

    if (!deleted) {
      return res.status(404).json({ message: 'Scoreboard not found or unauthorized' });
    }

    res.json({ message: 'Scoreboard deleted successfully', id });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
