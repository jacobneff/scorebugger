# Scorebugger

Scorebugger keeps volleyball broadcasts and in-venue displays synchronized with a live, browser-based scoreboard. The project pairs a React control surface with an Express/Socket.IO backend so operators can update the match state in real time while viewers see a polished overlay.

## Highlights
- **Control panel built for operators** — manage scores, sets, team branding, and serving indicators with keyboard shortcuts and quick toggles.
- **Broadcast-ready overlay** — renders a responsive scoreboard panel that mirrors the production design used on the stream.
- **Real-time synchronization** — Socket.IO keeps every connected display, controller, and observer in lockstep.
- **Account-based ownership** — users claim scoreboards, rename them, and revisit saved matches after signing in.
- **Email flows baked in** — registration, verification, and password reset endpoints support end-to-end account management.

## Architecture Overview
- **Client (`client/`)** — Vite + React application that hosts the control panel, overlay view, and authentication flows. State is managed through hooks such as `useScoreboard`, which bridges REST and Socket.IO updates.
- **Server (`server/`)** — Express API backed by MongoDB. Routes under `/api/scoreboards` handle CRUD and live state updates, while `/api/auth` manages registration and session lifecycles. Socket.IO broadcasts scoreboard changes to every participant in the same room.
- **Shared conventions** — scoreboards always contain two teams, up to five sets worth of history, and a six-character uppercase code that doubles as a shareable link.

## Local Development
```bash
# Install dependencies
cd client && npm install
cd ../server && npm install

# Start the development servers
cd ../client && npm run dev        # React/Vite app on http://localhost:5173
cd ../server && npm run dev        # Express API + Socket.IO on http://localhost:5000
```

### Required Environment Variables
Create a `.env` in `server/` with:
```
MONGODB_URI=mongodb://localhost:27017/scorebugger
JWT_SECRET=change-me
CLIENT_ORIGIN=http://localhost:5173
EMAIL_FROM=you@example.com           # Optional; used for transactional emails
SMTP_HOST=localhost                  # Optional; omit to log emails to the console
```

## Testing
- `cd client && npm run test` — Vitest suite covering UI helpers and scoreboard rendering
- `cd server && npm run test` — Jest + Supertest integration tests for scoreboard routes

Run `npm run lint` in `client/` and `server/` (when configured) before committing.

## Project Structure
```
client/
  src/
    components/        # Overlay & control panel building blocks
    context/           # Auth and settings providers
    hooks/             # REST + Socket.IO data hooks
    pages/             # Routed views (home, control, display, auth)
server/
  src/
    config/            # Mongo connection helpers
    middleware/        # Auth guards
    models/            # Mongoose schemas
    routes/            # REST endpoints for auth & scoreboards
    __tests__/         # Jest integration suites
```

## Future Enhancements
- Expand automated coverage to Socket.IO handlers and the Control Panel UI.
- Add role-based permissions for production crews and guest scorers.
- Surface match analytics (set momentum, run streaks) directly in the control panel.
