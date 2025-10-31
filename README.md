# scorebugger

## Deploying to Render
1. Push your changes, then create a new “Blueprint” in Render using this repository.
2. Render detects `render.yaml` at the repo root and provisions two services:
   - `scorebugger-api` (Node web service, root `server/`)
   - `scorebugger-client` (static site, root `client/`)
3. When prompted, add the required environment variables (see below) and launch the deploy. After the first deploy completes you can copy each service’s `RENDER_EXTERNAL_URL` into the corresponding variables so the API and frontend know about each other.

### Required environment variables
- **scorebugger-api**  
  - `MONGODB_URI` — MongoDB connection string.
  - `JWT_SECRET` — secret used for signing authentication tokens.
  - `CLIENT_ORIGIN` — Set to the deployed client URL (e.g., the `RENDER_EXTERNAL_URL` from `scorebugger-client`). Add additional origins as a comma-separated list if needed.
  - `EMAIL_FROM` — Address used as the sender for verification and reset emails.
  - `SMTP_HOST` — Outgoing SMTP host. When omitted the API falls back to logging verification/reset links to the console.
  - `SMTP_PORT` — SMTP port (defaults to `587`).
  - `SMTP_USER` / `SMTP_PASSWORD` — Credentials for authenticated SMTP connections (optional).
  - `SMTP_SECURE` — Set to `true` to require TLS/SSL (defaults to `false`).
  - `APP_BASE_URL` — (Optional) Base URL used in email links; falls back to `CLIENT_ORIGIN` or `http://localhost:5173` in development.
- **scorebugger-client**  
  - `VITE_API_URL` / `VITE_SOCKET_URL` — Set to the deployed API URL (e.g., the `RENDER_EXTERNAL_URL` from `scorebugger-api`). Update if you later attach a custom domain.

### Post-deploy checklist
- Confirm the health check at `/health` returns `{ "status": "ok" }`.
- If you add a custom domain on either service, update `CLIENT_ORIGIN`, `VITE_API_URL`, and `VITE_SOCKET_URL` accordingly.
- For preview PR builds, configure dedicated Mongo databases or environment groups before enabling auto-deploys.

### Email verification & password resets
- Registration now requires email verification; the API sends a link via SMTP (or logs it to the console when SMTP is not configured).
- Users can resend the verification email from the sign-in panel or by opening `/auth/verify?token=...` links.
- Password resets are handled through the `/auth/reset-password?token=...` page, and authenticated users can change their password from the dashboard.
