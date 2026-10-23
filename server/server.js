require('dotenv').config();

const dns = require('dns');
const https = require('https');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const { Telegraf } = require('telegraf');
const { createAdminRouter } = require('./admin-api');

// Node 18+ Happy Eyeballs often tries Telegram's IPv6 first; that path
// commonly resets (ECONNRESET) even when IPv4 works.
dns.setDefaultResultOrder('ipv4first');

const app = express();
const allowedOrigins = [
    ...(process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(','),
    process.env.RENDER_EXTERNAL_URL,
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
    || (process.env.NODE_ENV === 'production' ? process.env.RENDER_EXTERNAL_URL : '')
    || ''
).trim();
const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
let botStatus = TELEGRAM_BOT_TOKEN ? 'starting' : 'not_configured';
let webAppUrl = null;
let webAppStatus = 'not_configured';
let databaseError = '';

if (configuredWebAppUrl) {
    try {
        const parsedWebAppUrl = new URL(configuredWebAppUrl);
        if (parsedWebAppUrl.protocol === 'https:'
            && parsedWebAppUrl.hostname
            && !['localhost', '127.0.0.1', '::1'].includes(parsedWebAppUrl.hostname)
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
        '⚠️ Telegram Mini App button is disabled. Set WEB_APP_URL to a public HTTPS URL (for example, an HTTPS tunnel or production domain) in server/.env.'
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

function createBot(token) {
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

    bot.start((ctx) => {
        const greeting = `ሰላም ${ctx.from.first_name}! እንኳን ወደ PRIME GAMING በሰላም መጡ! 🎮`;
        if (!webAppUrl) {
            return ctx.reply(
                `${greeting}\n\nየመተግበሪያው ሊንክ ለጊዜው አልተዘጋጀም። Please try again later.`
            );
        }

        return ctx.reply(
            `${greeting}\n\nየውድድር መተግበሪያውን ለመክፈት ከታች ይጫኑ።`,
            {
                reply_markup: {
                    inline_keyboard: [[{
                        text: '🎮 Open PRIME GAMING App',
                        web_app: { url: webAppUrl },
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
                    '❌ Telegram rejected the bot token (HTTP 404). Create or copy a current token from @BotFather, set TELEGRAM_BOT_TOKEN in server/.env, then restart the server.'
                );
                return;
            }
            console.error(
                `❌ Bot launch error (attempt ${attempt}):`,
                sanitizeError(err)
            );

            if (!retryable) {
                botStatus = 'unavailable';
                console.error('❌ Bot launch failed with a non-retryable error. HTTP API will keep running.');
                return;
            }

            try {
                bot.stop('retry');
            } catch (_) {
                // Not running yet (failed during getMe) — safe to ignore.
            }

            console.log(`⏳ Retrying Telegram connection in ${delay / 1000}s...`);
            botStatus = 'retrying';
            await sleep(delay);
        }
    }
}

let bot = null;

if (!TELEGRAM_BOT_TOKEN) {
    botStatus = 'not_configured';
    console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing!');
} else if (!TELEGRAM_TOKEN_PATTERN.test(TELEGRAM_BOT_TOKEN)) {
    botStatus = 'invalid_token';
    console.error(
        '❌ TELEGRAM_BOT_TOKEN has an invalid format. Expected the BotFather token format "<bot-id>:<token>". The HTTP API will continue running; replace the value in server/.env and restart.'
    );
} else {
    bot = createBot(TELEGRAM_BOT_TOKEN);
    launchBotWithRetry(bot);

    const stop = (signal) => {
        try {
            bot.stop(signal);
        } catch (_) {
            // Bot never finished launching.
        }
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
}

app.get('/api/health', (req, res) => {
    res.json({
        message: 'Welcome to PRIME GAMING API!',
        bot: bot && bot.botInfo ? { username: bot.botInfo.username, id: bot.botInfo.id } : null,
        botStatus,
        webAppStatus,
        databaseStatus: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState]
            || 'unknown',
        databaseError,
    });
});

if (process.env.NODE_ENV === 'production') {
    const clientDistPath = path.resolve(__dirname, '../client/dist');
    app.use(express.static(clientDistPath));
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
        if (!req.accepts('html')) return next();
        return res.sendFile(path.join(clientDistPath, 'index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`🚀 PRIME GAMING Server running on port ${PORT}`);
});

if (!process.env.MONGODB_URI) {
    databaseError = 'MONGODB_URI is not configured.';
    console.error('❌ MONGODB_URI is missing; registration and admin data endpoints are unavailable.');
} else {
    function describeMongoError(error) {
        if (error?.code === 8000 || /authentication failed|bad auth/i.test(error?.message || '')) {
            return 'MongoDB authentication failed. Check the Atlas database username/password, authentication database, and URL-encode special characters in the password.';
        }
        if (/ENOTFOUND|getaddrinfo/i.test(error?.message || '')) {
            return 'MongoDB hostname could not be resolved. Check the Atlas cluster hostname and network/DNS access.';
        }
        if (/IP.*access list|not authorized|IP address/i.test(error?.message || '')) {
            return 'MongoDB network access is blocked. Add this server IP to the Atlas Network Access list.';
        }
        return `${error?.name || 'MongoDB connection error'}: connection unavailable. Check Atlas network access and the connection string.`;
    }

    mongoose.connection.on('connected', () => {
        databaseError = '';
        console.log('✅ Tournament database connected.');
    });
    mongoose.connection.on('disconnected', () => {
        console.error('⚠️ MongoDB disconnected; database-backed API routes will return 503 until reconnection.');
    });
    mongoose.connection.on('reconnected', () => {
        databaseError = '';
        console.log('✅ MongoDB connection restored.');
    });
    mongoose.connection.on('error', (error) => {
        databaseError = describeMongoError(error);
        console.error('❌ MongoDB connection error:', databaseError);
    });

    async function connectToMongoWithRetry() {
        let attempt = 0;
        while (mongoose.connection.readyState !== 1) {
            attempt += 1;
            try {
                await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
                databaseError = '';
                return;
            } catch (error) {
                databaseError = describeMongoError(error);
                console.error(`❌ MongoDB connection attempt ${attempt} failed:`, databaseError);
                const delay = Math.min(30_000, 2_000 * attempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    connectToMongoWithRetry();
}
