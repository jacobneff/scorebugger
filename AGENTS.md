# Repository Guidelines

## Project Structure & Module Organization
- `client/` — Vite React UI with components in `client/src/components`, routed views in `client/src/pages`, and shared hooks/context under `client/src/hooks` and `client/src/context`. Static assets live in `client/public`; Vite emits bundles to `client/dist`.
- `server/` — Express + Socket.IO backend. Configuration helpers sit in `server/src/config`, Mongoose models in `server/src/models`, middleware in `server/src/middleware`, and HTTP/socket wiring in `server/src/routes` and `server/src/index.js`.
- `src/context/` — reserved for automation artifacts; leave plain text templates intact.

## Build, Test, and Development Commands
Run `npm install` in both `client/` and `server/` before first use. Key workflows:
```
cd client && npm run dev       # Launch React dev server with Vite
cd client && npm run build     # Produce static bundle in dist/
cd client && npm run lint      # Check JSX/JS style with ESLint
cd server && npm run dev       # Start API with nodemon autoreload
cd server && npm start         # Start API for production
```
Always run the relevant lint/dev command before committing.

## Coding Style & Naming Conventions
Frontend files follow modern React (hooks, ES modules) with 2-space indentation. Use PascalCase for components (`ScoreboardCard.jsx`), camelCase for functions/state, and SCREAMING_SNAKE_CASE for environment variables. ESLint (`client/eslint.config.js`) is the source of truth—enable format-on-save. Keep server code in CommonJS style, reuse async/await, and mirror existing naming when adding Mongoose models or Socket.IO events.

## Testing Guidelines
Automated tests are not in place yet; scope new work with unit or integration tests as you add logic. For the client, co-locate Vitest + React Testing Library specs in `client/src/__tests__/`. For the server, add Jest or supertest coverage under `server/src/__tests__/`, naming files after the module (`scoreboards.route.test.js`). Until suites exist, document manual checks in PRs and run `npm run lint` in both packages.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit titles (e.g., “Add scoreboard socket listeners”). Keep commits focused, avoid mixing sweeping client and server edits, and call out data-model adjustments in the body. Pull requests should summarize the change, link issues, note lint/test results, and include screenshots or screen captures for UI tweaks. Flag breaking API or socket payload changes prominently.

## Security & Configuration Tips
Create a `.env` in `server/` with `MONGODB_URI`, `JWT_SECRET`, and optional comma-separated `CLIENT_ORIGIN`. Never commit secrets. Tighten allowed origins for previews, rotate credentials after any leak, and validate incoming Socket.IO payloads just as `scoreboard:update` does.
