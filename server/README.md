# PRIME GAMING server

## Configure and run

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` and `TELEGRAM_BOT_TOKEN` for your deployment. The Telegram value must be the complete token issued by `@BotFather` (including the numeric bot ID and colon); do not use the bot's username or an API key from another service.
3. Set `WEB_APP_URL` to a public HTTPS URL for the React frontend (for example, an HTTPS tunnel URL such as ngrok or the production domain). On Render, `RENDER_EXTERNAL_URL` is used automatically if `WEB_APP_URL` is unset. Telegram Mini App buttons are omitted when no valid HTTPS URL is available; localhost is not reachable from Telegram and is not accepted. Restart the bot after changing this value.
4. Set a unique `ADMIN_USERNAME` and a long, unique `ADMIN_PASSWORD` in `server/.env`. Admin sign-in returns `503` until both are configured.
5. Set `CLIENT_ORIGIN` to the exact comma-separated frontend origins allowed to call the API.
6. Start the API with `npm start`.

Keep `.env` private and out of version control. The `/admin` dashboard uses an HttpOnly, SameSite=Strict session cookie; admin requests are checked against the configured client origins. In production, serve the API over HTTPS so the session cookie is Secure.

From the repository root, run `npm run install:all` to install all dependencies. Use `npm run dev` to start the API and Vite frontend together, `npm run build` to build and validate the production app, and `npm start` to run it. The production Express server serves `client/dist` and exposes health information at `/api/health`. Render deployment is configured in `render.yaml`; set the prompted MongoDB URI, Telegram token, and admin credentials in the Render dashboard. The service’s generated HTTPS URL is used as the Mini App URL and allowed frontend origin by default. The blueprint uses Render's free web-service tier; for always-on production availability, select a paid instance in Render's dashboard.

The Vite development server proxies `/api` to `http://localhost:5000`. For separate frontend hosting in production, set `CLIENT_ORIGIN` to the exact comma-separated frontend origins and set `WEB_APP_URL` to the public HTTPS frontend URL before starting the server. The root API health response includes `botStatus` and `webAppStatus`; `invalid_token` means the server-side token must be replaced with a valid token from `@BotFather`, while `webAppStatus: "not_configured"` or `"invalid_url"` means the HTTPS frontend URL must be set.

Registration requests, receipt images, payment reviews, tournament availability, and approved-player rosters are stored in MongoDB. The server retries an unavailable initial connection with backoff and automatically recovers from later connection drops. Health details are available at `/api/health` without returning credentials. If MongoDB is unavailable, the HTTP server remains running and database-backed API routes return `503`. For Atlas authentication failures, verify the database user and password (not the Atlas website login), the user's authentication database, and URL-encode any special characters in the password. Also ensure the deployment host is allowed in Atlas Network Access. Payment approval uses an atomic slot decrement and rejects approvals when no open slot remains. Slot counts shown in the admin dashboard can be manually edited by the organizer.
