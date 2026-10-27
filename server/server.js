const path = require('path');
const dns = require('dns');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { discoverNgrokPublicUrl, initializeTelegramWebhook } = require('./telegram-webhook');

const {
    createAdminRouter,
    findTelegramPlayer,
    getTelegramPaymentAccounts,
    isValidContact,
    listTelegramPlayerRegistrations,
    listTelegramTournaments,
    parseTelegramUsername,
    registerPlayerForTournament,
    registerPlayersForTournament,
    registerTelegramPlayer,
    resubmitPlayerPayment,
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

app.post('/api/telegram/webhook', express.json({ limit: '1mb' }), async (req, res) => {
    const providedSecret = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') || ''));
    const expectedSecret = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
    if (providedSecret.length !== expectedSecret.length
        || !crypto.timingSafeEqual(providedSecret, expectedSecret)) {
        return res.status(401).json({ error: 'Invalid Telegram webhook secret.' });
    }
    if (!bot) return res.sendStatus(503);
    try {
        await bot.handleUpdate(req.body);
        return res.sendStatus(200);
    } catch (error) {
        console.error('Telegram webhook update failed:', sanitizeError(error));
        return res.sendStatus(500);
    }
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = Number(process.env.PORT || 5000);
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
    || crypto.randomBytes(32).toString('hex');

const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
let botStatus = TELEGRAM_BOT_TOKEN ? 'starting' : 'not_configured';
let telegramWebhookStatus = TELEGRAM_BOT_TOKEN ? 'awaiting_tunnel' : 'not_configured';
let reminderTimer = null;

const telegramAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    family: 4,
    timeout: 60_000,
    maxSockets: 50,
    maxFreeSockets: 10,
});

function sanitizeError(err) {
    const message = err && err.message ? err.message : String(err);
    return message.replace(/\/(bot|user)\d+:[^/\s]+/gi, '/$1[REDACTED]');
}

function createBot(token, services = {}) {
    const chatServices = {
        findTelegramPlayer,
        getTelegramPaymentAccounts,
        isValidContact,
        listTelegramPlayerRegistrations,
        listTelegramTournaments,
        parseTelegramUsername,
        registerPlayerForTournament,
        registerPlayersForTournament,
        registerTelegramPlayer,
        resubmitPlayerPayment,
        fetch: (...args) => fetch(...args),
        ...services,
    };
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

    const conversations = new Map();
    const stateFor = (chatId) => conversations.get(String(chatId));
    const setState = (chatId, state) => conversations.set(String(chatId), state);
    const clearState = (chatId) => conversations.delete(String(chatId));
    const mainMenu = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Register for a tournament', callback_data: 'prime:register' }],
                [{ text: 'Open tournaments', callback_data: 'prime:tournaments' }, { text: 'My registrations', callback_data: 'prime:registrations' }],
                [{ text: 'Help', callback_data: 'prime:help' }],
            ],
        },
    };

    bot.use(async (ctx, next) => {
        if (ctx.chat?.type && ctx.chat.type !== 'private') {
            return ctx.reply('For privacy, please use this bot in a private chat.');
        }
        return next();
    });

    async function sendTournamentOptions(ctx) {
        const player = await chatServices.findTelegramPlayer(ctx.from.id);
        if (!player) {
            setState(ctx.chat.id, { step: 'contact' });
            return ctx.reply('To register, first verify your player identity by sharing your own phone number.', {
                reply_markup: {
                    keyboard: [[{ text: 'Share my phone number', request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            });
        }
        const tournaments = await chatServices.listTelegramTournaments();
        if (!tournaments.length) return ctx.reply('There are no open tournaments accepting registrations right now.', mainMenu);
        setState(ctx.chat.id, { step: 'tournament', playerId: player.id });
        return ctx.reply('Choose a tournament:', {
            reply_markup: {
                inline_keyboard: tournaments.map((tournament) => ([{
                    text: `${tournament.name} · ${tournament.availableSlots} spots · ${tournament.entryFee.toLocaleString()} ETB`,
                    callback_data: `prime:tournament:${tournament.weekId}`,
                }])),
            },
        });
    }

    async function sendRegistrationSummary(ctx) {
        const entries = await chatServices.listTelegramPlayerRegistrations(ctx.from.id);
        if (!entries.length) return ctx.reply('No registrations are linked to this Telegram account yet.', mainMenu);
        const summary = entries.map((entry) => (
            `${entry.tournament?.name || `Cup ${Number(entry.weekId) + 1}`} · ${entry.playerName} · ${entry.paymentStatus}`
            + (entry.rejectionReason ? `\nReason: ${entry.rejectionReason}` : '')
            + (entry.hasPass ? `\nPass: ${entry.confirmationCode}` : '')
        )).join('\n\n');
        const appealButtons = entries.filter((entry) => entry.paymentStatus === 'rejected' && entry.id)
            .map((entry) => ([{
                text: `Appeal / re-submit · ${entry.playerName}`.slice(0, 60),
                callback_data: `prime:appeal:${entry.id}`,
            }]));
        return ctx.reply(summary, {
            reply_markup: {
                inline_keyboard: [...appealButtons, ...mainMenu.reply_markup.inline_keyboard],
            },
        });
    }

    async function showParticipants(ctx, state) {
        const participants = state.participants || [];
        const roster = participants.length
            ? participants.map((participant, index) => `${index + 1}. ${participant.playerName} · ${participant.contact}`).join('\n')
            : 'No players added yet.';
        const buttons = participants.map((participant, index) => ([{
            text: `Remove ${index + 1}`,
            callback_data: `prime:participant:remove:${index}`,
        }]));
        if (!participants.some((participant) => participant.isAccountOwner)) {
            buttons.unshift([{ text: 'Register myself', callback_data: 'prime:participant:self' }]);
        }
        buttons.push([{ text: 'Add Another Player / ሌላ ተጫዋች ጨምር', callback_data: 'prime:participant:add' }]);
        if (participants.length) buttons.push([{ text: 'Continue to receipt', callback_data: 'prime:participants:continue' }]);
        buttons.push([{ text: 'Cancel', callback_data: 'prime:cancel' }]);
        return ctx.reply(`Players for ${state.tournamentName}:\n${roster}`, {
            reply_markup: { inline_keyboard: buttons },
        });
    }

    async function begin(ctx) {
        clearState(ctx.chat.id);
        return ctx.reply(
            `🎮 እንኳን ወደ Prime Game Zone በደህና መጡ! 🏆
የጨዋታ ችሎታዎን የሚያሳዩበት፣ ከሌሎች ተጫዋቾች ጋር የሚፎካከሩበት እና አጓጊ ሽልማቶችን የሚያሸንፉበት ቁጥር አንድ መድረክ።

አሁን ከየትኛውም ቦታ ሆኖ በቀጥታ በዚህ የቴሌግራም ቻት ውስጥ ሆነው ውድድሮችን መከታተል፣ መመዝገብ እና የክፍያ ማረጋገጫዎችን መላክ ይችላሉ!

የሚከተሉትን ትዕዛዞች በመጠቀም አገልግሎቱን ማግኘት ይችላሉ፦
* 🏆 /tournaments - ያሉትን ቶርናመንቶች ለመመልከት
* 📝 /register - ለውድድር ለመመዝገብ (ለራስዎ ወይም ለሌላ ተጫዋች)
* 👤 /myregistrations - የምዝገባ ሁኔታዎን ለመፈተሽ
* ❓ /help - እርዳታ ለማግኘት

ለመጀመር ከታች ካሉት አማራጮች አንዱን ይጫኑ ወይም የሚፈልጉትን ትዕዛዝ ይጻፉ! 🚀`,
            mainMenu,
        );
    }

    bot.start(begin);
    bot.command('register', sendTournamentOptions);
    bot.command('tournaments', async (ctx) => {
        const tournaments = await chatServices.listTelegramTournaments();
        if (!tournaments.length) return ctx.reply('There are no open tournaments right now.', mainMenu);
        return ctx.reply(tournaments.map((tournament) => (
            `${tournament.name} · ${tournament.availableSlots} spots · ${tournament.entryFee.toLocaleString()} ETB`
        )).join('\n'), mainMenu);
    });
    bot.command('myregistrations', sendRegistrationSummary);
    bot.command('cancel', (ctx) => {
        clearState(ctx.chat.id);
        return ctx.reply('Registration cancelled.', mainMenu);
    });
    bot.command('help', (ctx) => ctx.reply('Use /register to choose an open tournament, select a payment method, and send your payment screenshot. Use /myregistrations to check status or /cancel to stop.', mainMenu));

    bot.action('prime:register', async (ctx) => {
        await ctx.answerCbQuery();
        return sendTournamentOptions(ctx);
    });
    bot.action('prime:tournaments', async (ctx) => {
        await ctx.answerCbQuery();
        const tournaments = await chatServices.listTelegramTournaments();
        if (!tournaments.length) return ctx.reply('There are no open tournaments right now.', mainMenu);
        return ctx.reply(tournaments.map((tournament) => (
            `${tournament.name} · ${tournament.availableSlots} spots · ${tournament.entryFee.toLocaleString()} ETB`
        )).join('\n'), mainMenu);
    });
    bot.action('prime:registrations', async (ctx) => {
        await ctx.answerCbQuery();
        return sendRegistrationSummary(ctx);
    });
    bot.action('prime:help', async (ctx) => {
        await ctx.answerCbQuery();
        return ctx.reply('Use /register to choose a tournament, pick Telebirr or CBE, then send your payment screenshot. Use /myregistrations to check status and /cancel to stop.', mainMenu);
    });
    bot.action(/^prime:tournament:(\d+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const weekId = Number(ctx.match[1]);
        const player = await chatServices.findTelegramPlayer(ctx.from.id);
        if (!player) {
            clearState(ctx.chat.id);
            return ctx.reply('Use /register to verify your player identity first.', mainMenu);
        }
        const tournaments = await chatServices.listTelegramTournaments();
        const tournament = tournaments.find((item) => item.weekId === weekId);
        if (!tournament) return ctx.reply('That tournament is no longer accepting registrations.', mainMenu);
        const accounts = await chatServices.getTelegramPaymentAccounts();
        const accountText = accounts.map((account) => (
            `${account.type === 'cbe' ? 'CBE Bank' : 'Telebirr'}${account.name ? ` · ${account.name}` : ''}: ${account.number || 'Contact the organizer for current account details'}`
        )).join('\n');
        setState(ctx.chat.id, {
            step: 'payment',
            playerId: player.id,
            weekId,
            tournamentName: tournament.name,
        });
        return ctx.reply(`${tournament.name}\nEntry fee: ${tournament.entryFee.toLocaleString()} ETB\n\n${accountText}\n\nChoose your payment method:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Telebirr', callback_data: `prime:payment:${weekId}:telebirr` }],
                    [{ text: 'CBE Bank', callback_data: `prime:payment:${weekId}:cbe` }],
                    [{ text: 'Cash', callback_data: `prime:payment:${weekId}:cash` }],
                    [{ text: 'Cancel', callback_data: 'prime:cancel' }],
                ],
            },
        });
    });
    bot.action(/^prime:payment:(\d+):(telebirr|cbe|cash)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const state = stateFor(ctx.chat.id);
        const weekId = Number(ctx.match[1]);
        const payment = ctx.match[2];
        if (!state || state.step !== 'payment' || state.weekId !== weekId) {
            return ctx.reply('Please start again with /register.', mainMenu);
        }
        const nextState = { ...state, step: 'participants', payment, participants: [] };
        setState(ctx.chat.id, nextState);
        return ctx.reply('Who will play in this tournament? Add yourself, another player, or both.', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Register myself', callback_data: 'prime:participant:self' }],
                    [{ text: 'Add Other Player / ሌላ ተጫዋች ጨምር', callback_data: 'prime:participant:add' }],
                    [{ text: 'Cancel', callback_data: 'prime:cancel' }],
                ],
            },
        });
    });
    bot.action('prime:participant:self', async (ctx) => {
        await ctx.answerCbQuery();
        const state = stateFor(ctx.chat.id);
        if (!state || state.step !== 'participants') return ctx.reply('Start again with /register.', mainMenu);
        if ((state.participants || []).some((participant) => participant.isAccountOwner)) {
            return showParticipants(ctx, state);
        }
        const player = await chatServices.findTelegramPlayer(ctx.from.id);
        if (!player || !chatServices.isValidContact(player.contact)) {
            return ctx.reply('Your linked player profile needs a valid phone number. Use /cancel and /register to update it.', mainMenu);
        }
        const participant = {
            playerName: player.displayName,
            contact: player.contact,
            telegramUsername: player.telegramUsername || ctx.from.username || '',
            sessionPreference: 'any',
            isAccountOwner: true,
        };
        const nextState = { ...state, participants: [...(state.participants || []), participant] };
        setState(ctx.chat.id, nextState);
        return showParticipants(ctx, nextState);
    });
    bot.action('prime:participant:add', async (ctx) => {
        await ctx.answerCbQuery();
        const state = stateFor(ctx.chat.id);
        if (!state || state.step !== 'participants') return ctx.reply('Start again with /register.', mainMenu);
        setState(ctx.chat.id, { ...state, step: 'other_name' });
        return ctx.reply('Send the other player’s name (1–60 characters).');
    });
    bot.action(/^prime:participant:remove:(\d+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const state = stateFor(ctx.chat.id);
        const index = Number(ctx.match[1]);
        if (!state || state.step !== 'participants' || !state.participants?.[index]) {
            return ctx.reply('That player entry is no longer in this checkout.', mainMenu);
        }
        const nextState = { ...state, participants: state.participants.filter((_, position) => position !== index) };
        setState(ctx.chat.id, nextState);
        return showParticipants(ctx, nextState);
    });
    bot.action('prime:participants:continue', async (ctx) => {
        await ctx.answerCbQuery();
        const state = stateFor(ctx.chat.id);
        if (!state || state.step !== 'participants' || !state.participants?.length) {
            return ctx.reply('Add at least one player before continuing.', mainMenu);
        }
        setState(ctx.chat.id, { ...state, step: 'group_receipt' });
        return ctx.reply(`Send one payment screenshot for ${state.participants.length} player${state.participants.length === 1 ? '' : 's'}. It will be reviewed for the whole group.`, {
            reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'prime:cancel' }]] },
        });
    });
    bot.action('prime:cancel', async (ctx) => {
        await ctx.answerCbQuery();
        clearState(ctx.chat.id);
        return ctx.reply('Registration cancelled.', mainMenu);
    });
    bot.action(/^prime:appeal:([a-f0-9]{24})$/i, async (ctx) => {
        await ctx.answerCbQuery();
        const player = await chatServices.findTelegramPlayer(ctx.from.id);
        if (!player) return ctx.reply('Link your player profile with /register before appealing a payment.', mainMenu);
        const registrations = await chatServices.listTelegramPlayerRegistrations(ctx.from.id);
        const entry = registrations.find((registration) => (
            String(registration.id) === ctx.match[1] && registration.paymentStatus === 'rejected'
        ));
        if (!entry) return ctx.reply('That rejected registration is no longer available for appeal.', mainMenu);
        const accounts = await chatServices.getTelegramPaymentAccounts();
        const accountText = accounts.map((account) => (
            `${account.type === 'cbe' ? 'CBE Bank' : 'Telebirr'}${account.name ? ` · ${account.name}` : ''}: ${account.number || 'Contact the organizer for current account details'}`
        )).join('\n');
        setState(ctx.chat.id, { step: 'appeal_payment', playerId: player.id, registrationId: entry.id });
        return ctx.reply(`Payment was rejected${entry.rejectionReason ? `: ${entry.rejectionReason}` : '.'}\n\n${accountText}\n\nChoose your payment method for the corrected receipt:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Telebirr', callback_data: `prime:appeal-payment:${entry.id}:telebirr` }],
                    [{ text: 'CBE Bank', callback_data: `prime:appeal-payment:${entry.id}:cbe` }],
                    [{ text: 'Cash', callback_data: `prime:appeal-payment:${entry.id}:cash` }],
                    [{ text: 'Cancel', callback_data: 'prime:cancel' }],
                ],
            },
        });
    });
    bot.action(/^prime:appeal-payment:([a-f0-9]{24}):(telebirr|cbe|cash)$/i, async (ctx) => {
        await ctx.answerCbQuery();
        const state = stateFor(ctx.chat.id);
        if (!state || state.step !== 'appeal_payment' || String(state.registrationId) !== ctx.match[1]) {
            return ctx.reply('Start again from /myregistrations to appeal this payment.', mainMenu);
        }
        setState(ctx.chat.id, { ...state, step: 'appeal_receipt', payment: ctx.match[2] });
        return ctx.reply('Send the corrected payment screenshot as a photo. It will replace the old receipt and return the same registration to review.', {
            reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'prime:cancel' }]] },
        });
    });

    bot.on('contact', async (ctx) => {
        const state = stateFor(ctx.chat.id);
        const contact = ctx.message.contact;
        if (!state || state.step !== 'contact') return ctx.reply('Use /register to begin.', mainMenu);
        if (String(contact.user_id || '') !== String(ctx.from.id)) {
            return ctx.reply('Please use the Telegram button to share your own phone number.');
        }
        if (!/^0[79]\d{8}$|^251[79]\d{8}$/.test(String(contact.phone_number || '').replace(/\D/g, ''))) {
            return ctx.reply('That phone number format is not supported. Share a valid Ethiopian mobile number.');
        }
        setState(ctx.chat.id, { step: 'display_name', contact: contact.phone_number });
        return ctx.reply('Now send the player name you want shown on the tournament roster.', {
            reply_markup: { remove_keyboard: true },
        });
    });
    bot.on('text', async (ctx) => {
        const state = stateFor(ctx.chat.id);
        if (!state) return;
        const text = ctx.message.text.trim();
        if (state.step === 'other_name') {
            if (!text || text.length > 60) return ctx.reply('Player names must be between 1 and 60 characters. Send the name again.');
            setState(ctx.chat.id, { ...state, step: 'other_contact', pendingName: text });
            return ctx.reply('Send this player’s Ethiopian mobile number (for example 0912345678).');
        }
        if (state.step === 'other_contact') {
            if (!chatServices.isValidContact(text)) return ctx.reply('That phone number is invalid. Send a valid Ethiopian mobile number.');
            setState(ctx.chat.id, { ...state, step: 'other_telegram', pendingContact: text });
            return ctx.reply('Send the player’s Telegram username (for example @player_one), or type /skip if they do not have one.');
        }
        if (state.step === 'other_telegram') {
            const telegramUsername = text.toLowerCase() === '/skip' ? '' : chatServices.parseTelegramUsername(text).username;
            if (text.toLowerCase() !== '/skip' && chatServices.parseTelegramUsername(text).error) {
                return ctx.reply('That Telegram username is invalid. Send 5–32 letters, numbers, or underscores, or type /skip.');
            }
            const participant = {
                playerName: state.pendingName,
                contact: state.pendingContact,
                telegramUsername,
                sessionPreference: 'any',
                isAccountOwner: false,
            };
            const nextState = {
                step: 'participants',
                playerId: state.playerId,
                weekId: state.weekId,
                payment: state.payment,
                tournamentName: state.tournamentName,
                participants: [...(state.participants || []), participant],
            };
            setState(ctx.chat.id, nextState);
            return showParticipants(ctx, nextState);
        }
        if (state.step !== 'display_name') return;
        const displayName = text;
        if (!displayName || displayName.length > 60) return ctx.reply('Player names must be between 1 and 60 characters. Send the name again.');
        try {
            const player = await chatServices.registerTelegramPlayer({
                chatId: ctx.from.id,
                username: ctx.from.username || '',
                displayName,
                contact: state.contact,
            });
            clearState(ctx.chat.id);
            return ctx.reply(`Player profile linked to ${player.playerCode}. You can now register in chat.`, mainMenu);
        } catch (error) {
            console.error('Telegram player profile could not be linked:', error?.message || error);
            return ctx.reply(error.code === 'TELEGRAM_PROFILE_CONFLICT'
                ? error.message
                : 'Your player profile could not be linked. Check your phone number and try /register again.', mainMenu);
        }
    });
    bot.on('photo', async (ctx) => {
        const state = stateFor(ctx.chat.id);
        if (!state || !['receipt', 'appeal_receipt', 'group_receipt'].includes(state.step)) {
            return ctx.reply('Use /register or /myregistrations to begin a checkout.', mainMenu);
        }
        try {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            const response = await chatServices.fetch(fileLink, { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error('Telegram did not provide the uploaded image.');
            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
                return ctx.reply('The screenshot must be 5 MB or smaller. Send another photo.');
            }
            const mime = /\.png$/i.test(fileLink.pathname) ? 'image/png' : 'image/jpeg';
            const receiptData = `data:${mime};base64,${buffer.toString('base64')}`;
            if (state.step === 'appeal_receipt') {
                await chatServices.resubmitPlayerPayment({
                    playerId: state.playerId,
                    registrationId: state.registrationId,
                    payment: state.payment,
                    receiptData,
                });
                clearState(ctx.chat.id);
                return ctx.reply('Corrected receipt submitted. Your existing registration is pending organizer review again.', mainMenu);
            }
            if (state.step === 'group_receipt') {
                const result = await chatServices.registerPlayersForTournament({
                    playerId: state.playerId,
                    weekId: state.weekId,
                    payment: state.payment,
                    receiptData,
                    participants: state.participants,
                });
                clearState(ctx.chat.id);
                const confirmations = result.registrations.map((entry) => `${entry.playerName}: ${entry.confirmationCode}`).join('\n');
                return ctx.reply(`Group registration saved for ${result.registrations.length} players in ${result.tournament.name}. Payment is pending organizer approval.\n\n${confirmations}`, mainMenu);
            }
            const result = await chatServices.registerPlayerForTournament({
                playerId: state.playerId,
                weekId: state.weekId,
                payment: state.payment,
                receiptData,
            });
            clearState(ctx.chat.id);
            return ctx.reply(`Registration saved for ${result.tournament.name}. Payment is pending organizer approval. Confirmation: ${result.registration.confirmationCode}.`, mainMenu);
        } catch (error) {
            console.error('Telegram registration could not be submitted:', sanitizeError(error));
            const message = error.code === 'REGISTRATION_DUPLICATE'
                || error.code === 'ACTIVE_TOURNAMENT_CONFLICT'
                || error.code === 'REGISTRATION_CLOSED'
                || error.code === 'GROUP_REGISTRATION_CLOSED'
                || error.code === 'REGISTRATION_DUPLICATE'
                || error.code === 'RESUBMIT_CONFLICT'
                || error.code === 'RESUBMIT_NOT_FOUND'
                || error.code === 'RECEIPT_ALREADY_USED'
                ? error.message
                : 'Registration could not be completed. Send /register to try again or /cancel to stop.';
            clearState(ctx.chat.id);
            return ctx.reply(message, mainMenu);
        }
    });

    return bot;
}

let bot = null;
let databaseStatus = 'disconnected';
let databaseRetryTimer = null;
let databaseCheckInProgress = false;
let webhookRetryTimer = null;
let webhookSetupInProgress = false;

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

async function configureTelegramWebhook() {
    if (!bot || webhookSetupInProgress || botStatus === 'invalid_token') return;
    webhookSetupInProgress = true;
    try {
        const clientPublicUrl = await discoverNgrokPublicUrl({ port: 5173 });
        const webhookPublicUrl = clientPublicUrl || await discoverNgrokPublicUrl({ port: PORT });
        if (!webhookPublicUrl) {
            telegramWebhookStatus = 'awaiting_tunnel';
            botStatus = 'awaiting_tunnel';
            console.log(`Telegram webhook waiting for an HTTPS Ngrok tunnel targeting Vite port 5173 or API port ${PORT}.`);
            return;
        }
        const { botInfo, webhookUrl } = await initializeTelegramWebhook({
            bot,
            publicUrl: webhookPublicUrl,
            secretToken: TELEGRAM_WEBHOOK_SECRET,
        });
        botStatus = 'running';
        telegramWebhookStatus = clientPublicUrl ? 'ready' : 'backend_tunnel';
        console.log(`Telegram webhook registered at ${webhookUrl}${botInfo.username ? ` for @${botInfo.username}` : ''}.`);
    } catch (error) {
        const errorCode = Number(error.response?.error_code || error.code);
        if (errorCode === 401 || errorCode === 404) {
            botStatus = 'invalid_token';
            telegramWebhookStatus = 'invalid_token';
            console.error('Telegram rejected the configured bot token. Rotate/update TELEGRAM_BOT_TOKEN in server/.env.');
            return;
        }
        botStatus = 'retrying';
        telegramWebhookStatus = 'retrying';
        console.error('Telegram webhook setup failed; retrying:', sanitizeError(error));
    } finally {
        webhookSetupInProgress = false;
        if (bot && botStatus !== 'running' && botStatus !== 'invalid_token' && !webhookRetryTimer) {
            webhookRetryTimer = setTimeout(() => {
                webhookRetryTimer = null;
                configureTelegramWebhook().catch((error) => {
                    console.error('Telegram webhook retry failed:', sanitizeError(error));
                });
            }, 5000);
        }
    }
}

app.get('/api/health', (req, res) => {
    res.json({
        message: 'Welcome to PRIME GAMING API (Local Mode)!',
        bot: bot && bot.botInfo ? { username: bot.botInfo.username, id: bot.botInfo.id } : null,
        botStatus,
        telegramWebhookStatus,
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
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535.');
    }
    const server = await new Promise((resolve, reject) => {
        const listeningServer = app.listen(PORT, () => resolve(listeningServer));
        listeningServer.once('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                reject(new Error(`Port ${PORT} is already in use. Stop the process using it, then restart the server.`));
                return;
            }
            reject(error);
        });
    });
    console.log(`PRIME GAMING API listening on http://0.0.0.0:${PORT}`);

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
        configureTelegramWebhook().catch((error) => {
            console.error('Telegram webhook initialization failed:', sanitizeError(error));
        });
    }

    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        if (reminderTimer) clearInterval(reminderTimer);
        if (databaseRetryTimer) clearInterval(databaseRetryTimer);
        if (webhookRetryTimer) clearTimeout(webhookRetryTimer);
        if (bot && botStatus === 'running') {
            try {
                await bot.telegram.deleteWebhook({ drop_pending_updates: false });
            } catch (error) {
                console.error('Telegram webhook could not be removed during shutdown:', sanitizeError(error));
            }
        }
        await new Promise((resolve) => server.close(resolve));
        await closeDatabase();
        console.log(`PRIME GAMING API stopped (${signal}).`);
    };
    process.once('SIGINT', () => stop('SIGINT').catch((error) => {
        console.error('Server shutdown failed:', error.message);
        process.exitCode = 1;
    }));
    process.once('SIGTERM', () => stop('SIGTERM').catch((error) => {
        console.error('Server shutdown failed:', error.message);
        process.exitCode = 1;
    }));
    return { server, stop };
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { app, configureTelegramWebhook, createBot, startServer };
