require('dotenv').config();

const cors = require('cors');
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const Scoreboard = require('./models/Scoreboard');
const scoreboardRoutes = require('./routes/scoreboards');
const authRoutes = require('./routes/auth');

const PORT = process.env.PORT || 5000;
const DEFAULT_CLIENT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

const CLIENT_ORIGINS = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((origin) => origin.trim())
  : DEFAULT_CLIENT_ORIGINS;

async function bootstrap() {
  await connectDB();

  const app = express();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: CLIENT_ORIGINS,
      methods: ['GET', 'POST', 'PATCH'],
    },
  });

  app.use(
    cors({
      origin: CLIENT_ORIGINS,
      credentials: true,
    })
  );
  app.use(express.json());

  app.use('/api/auth', authRoutes);
  app.use('/api/scoreboards', scoreboardRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Centralized error handler so Express responses stay consistent
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    const message = err.message || 'Internal server error';
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(status).json({ message });
  });

  io.on('connection', (socket) => {
    // Scorekeeper or viewer wants to subscribe to live updates
    socket.on('scoreboard:join', async ({ scoreboardId }) => {
      const key = typeof scoreboardId === 'string' ? scoreboardId.trim() : '';

      if (!key) {
        socket.emit('scoreboard:error', { message: 'Missing scoreboard identifier' });
        return;
      }

      const query = mongoose.Types.ObjectId.isValid(key)
        ? { _id: key }
        : { code: key.toUpperCase() };

      try {
        const scoreboard = await Scoreboard.findOne(query).lean();

        if (!scoreboard) {
          socket.emit('scoreboard:error', { message: 'Scoreboard not found' });
          return;
        }

        const room = scoreboard._id.toString();
        socket.join(room);
        socket.data.room = room;
        socket.emit('scoreboard:state', scoreboard);
      } catch (error) {
        socket.emit('scoreboard:error', { message: 'Failed to load scoreboard' });
      }
    });

    // Control clients send new state after user interactions
    socket.on('scoreboard:update', async ({ scoreboardId, state }) => {
      const key = typeof scoreboardId === 'string' ? scoreboardId.trim() : '';
      const room = socket.data.room;
      const MAX_SET_COUNT = 5;

      if (!key && !room) {
        socket.emit('scoreboard:error', { message: 'No scoreboard joined' });
        return;
      }

      if (
        !state ||
        !Array.isArray(state.teams) ||
        state.teams.length !== 2 ||
        ![0, 1].includes(state.servingTeamIndex)
      ) {
        socket.emit('scoreboard:error', { message: 'Invalid scoreboard payload' });
        return;
      }

      const query = key
        ? mongoose.Types.ObjectId.isValid(key)
          ? { _id: key }
          : { code: key.toUpperCase() }
        : { _id: room };

      try {
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

        const sanitizedSets = Array.isArray(state.sets)
          ? state.sets.map(sanitizeSet).filter(Boolean)
          : undefined;

        if (sanitizedSets && sanitizedSets.length > MAX_SET_COUNT) {
          socket.emit('scoreboard:error', {
            message: `Only ${MAX_SET_COUNT} sets are supported for a match`,
          });
          return;
        }

        const update = {
          teams: state.teams.map((team, index) => ({
            name: team.name?.toString().trim() || `Team ${index + 1}`,
            color: team.color || '#ffffff',
            teamTextColor: team.teamTextColor || team.textColor || '#ffffff',
            setColor: team.setColor || team.color || '#0b1a3a',
            scoreTextColor: team.scoreTextColor || '#ffffff',
            textColor: team.textColor || team.teamTextColor || '#ffffff',
            score: Number.isFinite(Number(team.score))
              ? Math.max(0, Number(team.score))
              : 0,
          })),
          servingTeamIndex: state.servingTeamIndex,
        };

        if (sanitizedSets) {
          update.sets = sanitizedSets;
        } else if (Array.isArray(state.sets) && state.sets.length === 0) {
          update.sets = [];
        }

        const scoreboard = await Scoreboard.findOneAndUpdate(query, update, {
          new: true,
          runValidators: true,
          omitUndefined: true,
        }).lean();

        if (!scoreboard) {
          socket.emit('scoreboard:error', { message: 'Scoreboard not found' });
          return;
        }

        const liveRoom = scoreboard._id.toString();
        socket.join(liveRoom);
        socket.data.room = liveRoom;

        io.to(liveRoom).emit('scoreboard:state', scoreboard);
      } catch (error) {
        socket.emit('scoreboard:error', { message: 'Failed to save scoreboard' });
      }
    });

    socket.on('disconnect', () => {
      socket.data.room = null;
    });
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🚀 Server listening on port ${PORT}`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap server', error);
  process.exit(1);
});
