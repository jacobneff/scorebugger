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

### Environment Configuration
1. Copy the example files to create real secrets:
   ```bash
   cp server/.env.development.example server/.env.development
   cp server/.env.production.example server/.env.production   # filled only in deployment
   ```
2. Update `server/.env.development` with `MONGODB_URI_DEV` (for example, `scorebugger_dev` in your shared cluster), optionally set `MONGODB_URI_PROD` for end-to-end tests, and add a local JWT secret plus any optional email settings. The server automatically loads `.env.development` whenever `NODE_ENV` is unset or `development`.
3. When deploying, provide the variables from `server/.env.production.example` via your hosting provider's secret manager and ensure `NODE_ENV=production` so the server reads `MONGODB_URI_PROD` and connects to the production database.
4. For the frontend, add matching Vite files (`client/.env.development`, `client/.env.production`) with `VITE_API_BASE_URL` pointing at the corresponding API host.

Sample development values:
```
PORT=5000
MONGODB_URI_DEV=mongodb+srv://<dev-username>:<dev-password>@<cluster-host>/scorebugger_dev
MONGODB_URI_PROD=mongodb+srv://<prod-username>:<prod-password>@<cluster-host>/scorebugger
JWT_SECRET=dev-secret-change-me
CLIENT_ORIGIN=http://localhost:5173
APP_BASE_URL=http://localhost:5173
EMAIL_FROM=dev@example.com
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_SECURE=false
NODE_VERSION=22
```

In MongoDB Atlas you can reuse a single cluster and create two databases (`scorebugger-dev`, `scorebugger`) or provision separate clusters if you prefer isolation. Grant credentials that are scoped to each database so production data stays protected during development.

## Testing
- `cd client && npm run test` — Vitest suite covering UI helpers and scoreboard rendering
- `cd server && npm run test` — Jest + Supertest integration tests for scoreboard routes

Run `npm run lint` in `client/` and `server/` (when configured) before committing.

## Branching Workflow
- Keep `main` production-ready and deploy from it only.
- Create a long-lived `develop` branch for day-to-day work: `git checkout -b develop` and push it to the remote.
- Open feature branches from `develop` (for example, `git checkout -b feature/live-timer`), merge them back into `develop` via pull requests, and only promote `develop` into `main` when you're ready to release.
- Seed and test new functionality against the development database before merging to `main`.

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
