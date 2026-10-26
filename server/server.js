const path = require('path');
const dns = require('dns');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
    createAdminRouter,
    linkTelegramUsername,
    sendMatchDayReminders,
    setTelegramMessenger,
    setTelegramPassMessenger,
} = require('./admin-api');
const { closeDatabase, getPool, initializeDatabase } = require('./db');

// Node 18+ Happy Eyeballs setup for Telegram IPv4 preference
dns.setDefaultResultOrder('ipv4first');

const app = express();
const allowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(process.env.CLIENT_ORIGIN || '').split(','),
    process.env.WEB_APP_URL,
]
    .flatMap((origin) => (origin || '').split(','))
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Request origin is not allowed.'));
    },
    credentials: true,
}));

app.use(express.json({ limit: '8mb' }));
app.use('/api', createAdminRouter());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 5000;
const configuredWebAppUrl = (
    process.env.WEB_APP_URL
    || ''
).trim();

const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
let botStatus = TELEGRAM_BOT_TOKEN ? 'starting' : 'not_configured';
let webAppUrl = null;
let webAppStatus = 'not_configured';
let reminderTimer = null;

if (configuredWebAppUrl) {
    try {
        const parsedWebAppUrl = new URL(configuredWebAppUrl);
        if (parsedWebAppUrl.protocol === 'https:'
            && parsedWebAppUrl.hostname
            && !parsedWebAppUrl.username
            && !parsedWebAppUrl.password) {
            webAppUrl = parsedWebAppUrl.toString().replace(/\/+$/, '');
            webAppStatus = 'ready';
        } else {
            webAppStatus = 'invalid_url';
        }
    } catch {
        webAppStatus = 'invalid_url';
    }
}

if (webAppStatus !== 'ready') {
    console.error(
        '⚠️ Telegram Mini App button warning. Set WEB_APP_URL to a valid public HTTPS URL (such as your Ngrok URL) in server/.env.'
    );
}

const telegramAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    family: 4,
    timeout: 60_000,
    maxSockets: 50,
    maxFreeSockets: 10,
});

const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
]);

function sanitizeError(err) {
    const message = err && err.message ? err.message : String(err);
    return message.replace(/\/(bot|user)\d+:[^/\s]+/gi, '/$1[REDACTED]');
}

function isRetryableBotError(err) {
    if (!err) return false;
    if (RETRYABLE_CODES.has(err.code)) return true;
    if (err.name === 'FetchError') return true;
    if (typeof err.message === 'string') {
        if (/ECONNRESET|socket hang up|network|timed? ?out/i.test(err.message)) {
            return true;
        }
    }
    const code = err.code || err.error_code;
    if (code === 429 || code === 409) return true;
    if (typeof code === 'number' && code >= 500) return true;
    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBot(token, miniAppUrl = webAppUrl) {
    const bot = new Telegraf(token, {
        telegram: {
            agent: telegramAgent,
            attachmentAgent: telegramAgent,
        },
        handlerTimeout: 90_000,
    });

    bot.catch((err, ctx) => {
        console.error(
            `❌ Bot handler error (${ctx?.updateType || 'unknown'}):`,
            sanitizeError(err)
        );
    });

    bot.start(async (ctx) => {
        const greeting = `ሰላም ${ctx.from.first_name}! እንኳን ወደ PRIME GAMING በሰላም መጡ! 🎮`;
        let linked = false;
        if (ctx.from.username) {
            try {
                linked = await linkTelegramUsername(ctx.from.username, ctx.chat.id);
            } catch (error) {
                console.error('Telegram account could not be linked:', error?.message || error);
            }
        }
        const alerts = linked
            ? '\n\nTelegram match and support alerts are now connected to your player account.'
            : '\n\nTo connect alerts, add your Telegram username to your player profile, then send /start here.';
        if (!miniAppUrl) {
            return ctx.reply(
                `${greeting}\n\nየመተግበሪያው ሊንክ ለጊዜው አልተዘጋጀም። Please try again later.${alerts}`
            );
        }

        return ctx.reply(
            `${greeting}\n\nየውድድር መተግበሪያውን ለመክፈት ከታች ይጫኑ።${alerts}`,
            {
                reply_markup: {
                    inline_keyboard: [[{
                        text: '🎮 Open PRIME GAMING App',
                        web_app: { url: miniAppUrl },
                    }]],
                },
            }
        );
    });

    return bot;
}

async function launchBotWithRetry(bot) {
    let attempt = 0;

    while (true) {
        attempt += 1;
        try {
            await bot.launch(
                { dropPendingUpdates: true },
                () => {
                    botStatus = 'running';
                    const username = bot.botInfo && bot.botInfo.username;
                    console.log(
                        `🤖 Telegram Bot started successfully${username ? ` as @${username}` : ''}!`
                    );
                }
            );
            return;
        } catch (err) {
            const retryable = isRetryableBotError(err);
            const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
            const telegramErrorCode = err.response?.error_code || err.code;
            if (telegramErrorCode === 404) {
                botStatus = 'invalid_token';
                console.error(
                    '❌ Telegram rejected the bot token (HTTP 404). Check TELEGRAM_BOT_TOKEN in server/.env.'
                );
                return;
            }
            console.error(
                `❌ Bot launch error (attempt ${attempt}):`,
                sanitizeError(err)
            );

            if (!retryable) {
                botStatus = 'unavailable';
                console.error('❌ Bot launch failed with a non-retryable error.');
                return;
            }

            try {
                bot.stop('retry');
            } catch (_) {}

            console.log(`⏳ Retrying Telegram connection in ${delay / 1000}s...`);
            botStatus = 'retrying';
            await sleep(delay);
        }
    }
}

let bot = null;
let databaseStatus = 'disconnected';
let databaseRetryTimer = null;
let databaseCheckInProgress = false;

async function maintainDatabaseConnection() {
    if (databaseCheckInProgress) return;
    databaseCheckInProgress = true;
    try {
        if (databaseStatus === 'connected') {
            try {
                await getPool().query('SELECT 1');
                return;
            } catch (error) {
                databaseStatus = 'unavailable';
                console.error('MySQL health check failed; reconnecting:', error.message);
                await closeDatabase();
            }
        }

        await initializeDatabase();
        databaseStatus = 'connected';
        sendMatchDayReminders().catch((error) => {
            console.error('Match-day reminders could not be checked:', error?.message || error);
        });
    } catch (error) {
        databaseStatus = 'unavailable';
        console.error('MySQL connection failed; retrying automatically:', error.message);
        try {
            await closeDatabase();
        } catch (closeError) {
            console.error('Failed MySQL pool could not be closed:', closeError.message);
        }
    } finally {
        databaseCheckInProgress = false;
    }
}

app.get('/api/health', (req, res) => {
    res.json({
        message: 'Welcome to PRIME GAMING API (Local Mode)!',
        bot: bot && bot.botInfo ? { username: bot.botInfo.username, id: bot.botInfo.id } : null,
        botStatus,
        webAppStatus,
        databaseStatus,
    });
});

app.use((error, req, res, next) => {
    if (error.message === 'Request origin is not allowed.') {
        return res.status(403).json({ error: error.message });
    }
    return next(error);
});

async function startServer() {
    const server = app.listen(PORT, () => {
        console.log(`🚀 PRIME GAMING Local Server running on port ${PORT}`);
    });

    await maintainDatabaseConnection();
    databaseRetryTimer = setInterval(maintainDatabaseConnection, 5000);
    reminderTimer = setInterval(() => {
        if (databaseStatus !== 'connected') return;
        sendMatchDayReminders().catch((error) => {
            console.error('Match-day reminders could not be checked:', error?.message || error);
        });
    }, 5 * 60 * 1000);

    if (!TELEGRAM_BOT_TOKEN) {
        botStatus = 'not_configured';
        console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing!');
    } else if (!TELEGRAM_TOKEN_PATTERN.test(TELEGRAM_BOT_TOKEN)) {
        botStatus = 'invalid_token';
        console.error('❌ TELEGRAM_BOT_TOKEN has an invalid format.');
    } else {
        bot = createBot(TELEGRAM_BOT_TOKEN);
        setTelegramMessenger((chatId, message) => bot.telegram.sendMessage(chatId, message));
        setTelegramPassMessenger((chatId, image, caption) => (
            bot.telegram.sendPhoto(chatId, { source: image }, { caption })
        ));
        launchBotWithRetry(bot);
    }

    const stop = async (signal) => {
        if (bot) {
            try {
                bot.stop(signal);
            } catch (_) {}
        }
        if (reminderTimer) clearInterval(reminderTimer);
        if (databaseRetryTimer) clearInterval(databaseRetryTimer);
        server.close();
        await closeDatabase();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) {
    startServer();
}

module.exports = { app, createBot, startServer };
