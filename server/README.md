# PRIME GAMING server

## Local XAMPP setup

1. Install the root, client, and server dependencies with `npm run install:all` from the repository root. The server uses `mysql2`.
2. Start **MySQL** in the XAMPP Control Panel. The server connects to `localhost:3307` as `root` with an empty password by default and creates the `prime_gaming_db` database and its tables automatically.
3. If your XAMPP MySQL root account has a password or uses another port, update `MYSQL_PASSWORD` or `MYSQL_PORT` in `server/.env`. `DB_PORT` is also accepted as a fallback. `MYSQL_HOST`, `MYSQL_USER`, and `MYSQL_DATABASE` can also be changed there.
4. Set `TELEGRAM_BOT_TOKEN` to the token issued by `@BotFather`. `WEB_APP_URL` is configured for the current Ngrok HTTPS URL; update it whenever the tunnel URL changes.
5. Keep `CLIENT_ORIGIN` set to the exact local frontend origin (`http://localhost:5173`) and any tunnel origin used by the browser. Same-origin requests forwarded through Vite are normalized to the local frontend origin, so LAN IP addresses do not need to be added. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to enable admin sign-in.
6. Start both services with `npm run dev` from the repository root.

The API listens on port 5000 and Vite listens on port 5173. Vite proxies same-origin `/api` requests to `http://127.0.0.1:5000`; set `API_PROXY_TARGET` if the backend listens elsewhere. Session cookies are HttpOnly and are sent automatically by the frontend, so authentication tokens are not stored in browser-accessible storage. `/api/health` reports database connectivity as `connected`, `unavailable`, or `disconnected`. If MySQL is unavailable, the HTTP health endpoint remains reachable and database-backed API routes report a `503`; check the backend log and start XAMPP MySQL.

Tournament, registration, and player records are stored in MySQL tables created automatically by the server. If `server/data/local-data.json` exists from an earlier local setup and all MySQL tables are empty, its contents are imported once at startup. Back up the database before making schema or data changes.

Player notifications are stored in the `notifications` table and linked to the authenticated `pgz_players` account (not the separate Telegram `users` table). The player session cookie scopes `GET /api/player/notifications`, `PATCH /api/player/notifications/:id/read`, and `PATCH /api/player/notifications/read-all` to that player. Registration submissions, admin payment reviews, match kickoff changes, and posted match results create notifications automatically. Authenticated admins can publish a broadcast announcement with `POST /api/admin/notifications` or message one player with `POST /api/admin/notifications/direct` and JSON `playerId`, `title`, and `message`; `GET /api/admin/players` supplies the account list for the direct-message selector. Match kickoff times are set in the admin match editor and sent to both players when changed. Tournament prize pools default to 20,000 ETB and can be changed in the admin tournament editor; the displayed placement awards use a 50% / 25% / 15% / remainder split so they add up to the configured pool.

The Telegram bot uses Telegram's Bot API and needs internet access to poll for `/start` messages. Its Mini App button uses `WEB_APP_URL`, which must be a public HTTPS URL reachable by Telegram; localhost URLs cannot be opened from Telegram. The app's API and frontend run locally.

Run `npm run build` from the repository root to build the client and validate the server. Run `npm test --prefix server` to execute the server tests.

## Player support and competition modules

- Player and organizer chat messages, attachment blobs, read receipts, reactions, pins, typing/online leases, and moderation state are persisted in `player_chats`, `chat_messages`, `chat_message_reactions`, and `chat_presence`. The player app and admin inbox refresh conversation history every few seconds; all conversation and attachment routes are scoped by the authenticated session.
- Chat messages support editing, deletion, copying, one pinned announcement per conversation, emoji reactions, bold (`**text**`) and italic (`*text*`) formatting, searchable history, and date dividers. Links are rendered as safe in-app previews; the application does not fetch third-party preview metadata.
- Players and organizers can share PNG/JPG/WebP/GIF images, supported voice recordings, and PDF/TXT/DOC/DOCX/XLS/XLSX documents up to 5 MB. Voice capture requires browser microphone permission and a supported `MediaRecorder`; attachments are stored in MySQL and served only to the conversation participants or an authenticated organizer.
- Read ticks update when the other participant opens the conversation. Typing and online indicators use short-lived MySQL presence leases refreshed by the chat polling requests. Admins can block a player from support messaging; players can submit a report for organizer review.
- The chat wallpaper picker resizes PNG/JPG/WebP images and stores each player's or organizer's private background in `chat_backgrounds`. The selected image is also cached in that browser and applied across the app/chat surfaces; it is never shared with other accounts.
- A player may have at most one pending or approved entry in a tournament that is not completed. Registration uses a MySQL advisory lock per player to prevent simultaneous requests from creating overlapping active entries. The lock is also used for manual organizer roster additions.
- When the approved roster reaches tournament capacity, the server generates the single-elimination draw automatically. The final result marks the tournament completed. Match scheduling supports an optional location.
- Enter a Telegram username on account registration, then send `/start` to the configured bot from that Telegram account. The bot links its chat ID to the matching player account; usernames alone cannot be messaged through Telegram's Bot API. Admin replies trigger the in-app notification and, when linked, a Telegram alert. Scheduled same-day reminders run every five minutes in the `Africa/Addis_Ababa` timezone.
- `GET /api/leaderboard` ranks players by 3 points per match win and 10 additional points per completed tournament title.
- Players submit match reports through `/api/player/disputes`; PNG/JPG/WebP proof images up to 5 MB are stored in MySQL. Admins review, resolve, and add notes in the organizer dashboard.
- `/api/admin/finance` reports approved-entry fees, configured prize pools for completed and active tournaments, and estimated fees after completed prize pools. These are estimates based on tournament settings, not an audited ledger of cash actually paid.
- The player app supports a locally persisted dark/light appearance preference. Small click tones and vibration are best-effort browser feedback; browsers without audio or vibration support continue normally.

## Group checkout and venue staff

- A signed-in player can submit one checkout for multiple named participants. Every participant gets a separate tournament registration and session preference, while the payment receipt and admin decision are shared by the group. Group submissions and configurable payment accounts are stored in `payment_submissions` and `payment_accounts`; schema changes are applied automatically at startup.
- Super-admins can update the CBE and Telebirr account details from the payment settings panel. Payment rejection requires a reason; approval issues a unique QR pass to every participant. Pass images appear in the associated player's profile and are sent to the linked Telegram chat when one is configured.
- The separate `/staff` console uses `STAFF_USERNAME` and `STAFF_PASSWORD`. Staff sessions can view daily fixtures, reschedule matches, check in approved passes, and reply to player support messages. Staff credentials do not grant access to super-admin or financial routes. Configure unique staff credentials in `server/.env` before sharing the portal.
- Check-in accepts either the QR payload (`PGZ-PASS:<token>`) or its token. A pass can be checked in only once; a successful check-in also marks that participant ready.

Validate the client and server with `npm run build` from the repository root, `npm run lint --prefix client`, and `npm test --prefix server`. Database transaction and live QR-scanner integration tests require a separately configured MySQL instance and a supported camera/browser.
