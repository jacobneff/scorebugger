# setpoint

## Deploying to Render
1. Push your changes, then create a new “Blueprint” in Render using this repository.
2. Render detects `render.yaml` at the repo root and provisions two services:
   - `setpoint-api` (Node web service, root `server/`)
   - `setpoint-client` (static site, root `client/`)
3. When prompted, add the required environment variables (see below) and launch the deploy.

### Required environment variables
- **setpoint-api**  
  - `MONGODB_URI` — MongoDB connection string.
  - `JWT_SECRET` — secret used for signing authentication tokens.
  - `CLIENT_ORIGIN` — (auto) set via blueprint to the static site URL; add additional origins as a comma-separated list if needed.
- **setpoint-client**  
  - `VITE_API_URL` / `VITE_SOCKET_URL` — (auto) set to the backend URL; override if using a custom domain.

### Post-deploy checklist
- Confirm the health check at `/health` returns `{ "status": "ok" }`.
- If you add a custom domain on either service, update `CLIENT_ORIGIN`, `VITE_API_URL`, and `VITE_SOCKET_URL` accordingly.
- For preview PR builds, configure dedicated Mongo databases or environment groups before enabling auto-deploys.
