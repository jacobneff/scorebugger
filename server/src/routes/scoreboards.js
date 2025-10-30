const express = require('express');
const mongoose = require('mongoose');
const Scoreboard = require('../models/Scoreboard');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/scoreboards -> create a new scoreboard instance
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { teams, servingTeamIndex, title } = req.body ?? {};
    const parsedServingIndex = Number(servingTeamIndex);

    // Determine the base title
    let scoreboardTitle = title?.trim();
    if (!scoreboardTitle) {
      const count = await Scoreboard.countDocuments({ owner: req.user.id });
      scoreboardTitle = count === 0 ? 'New Scoreboard' : `New Scoreboard (${count + 1})`;
    }

    const scoreboard = new Scoreboard({
      title: scoreboardTitle,
      teams: Array.isArray(teams) && teams.length === 2 ? teams : undefined,
      servingTeamIndex: [0, 1].includes(parsedServingIndex) ? parsedServingIndex : undefined,
      owner: req.user.id,
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
    const query = mongoose.Types.ObjectId.isValid(idOrCode)
      ? { _id: idOrCode }
      : { code: idOrCode.toUpperCase() };

    const scoreboard = await Scoreboard.findOne(query).lean();

    if (!scoreboard) {
      return res.status(404).json({ message: 'Scoreboard not found' });
    }

    return res.json(scoreboard);
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

    const board = await Scoreboard.findOneAndUpdate(
      { _id: id, owner: req.user.id },
      { title: title.trim() },
      { new: true, runValidators: true } // "new" returns the updated document
    );

    if (!board) {
      return res.status(404).json({ message: 'Scoreboard not found or unauthorized' });
    }

    // ✅ This is where you add this line
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
