const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { getPool, isDuplicateKeyError } = require('./db');
const { MySqlModel, isValidObjectId } = require('./mysql-store');

const CAPACITY = 128;
const DEFAULT_CAPACITY = 32;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const PLAYER_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const PAYMENT_METHODS = ['telebirr', 'cbe', 'cash'];
const STATUSES = ['open', 'full', 'live', 'completed'];
const ACTIVE_TOURNAMENT_STATUSES = ['open', 'full', 'live'];
const ADMIN_STATUSES = ['upcoming', 'live', 'completed'];
const TOURNAMENT_TYPES = ['daily', 'weekly', 'monthly'];
const TOURNAMENT_FORMATS = ['knockout', 'league'];
const MATCH_STATUSES = ['pending', 'ongoing', 'finished', 'bye'];
const PASS_STAGE_ORDER = ['not_started', 'check_in', 'play_off', 'end_of_play'];
const REGISTRATION_IDENTITY_LOCK = 'pgz_registration_identity';
const MAX_PRIZE_POOL = 10_000_000;
const MAX_PRIZE_TIERS = 128;
const MATCH_REMINDER_WINDOW_MS = 15 * 60 * 1000;

function normalizeTelegramUsername(value) {
    return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function telegramUsernameConflict(players, username, playerId = null) {
    const normalized = normalizeTelegramUsername(username);
    return Boolean(normalized && players.some((player) => (
        normalizeTelegramUsername(player.telegramUsername) === normalized
        && String(player._id) !== String(playerId || '')
    )));
}

function parseTelegramUsername(value) {
    if (typeof value !== 'string') return { error: 'Enter a valid Telegram username.' };
    const username = normalizeTelegramUsername(value);
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
        return { error: 'Telegram username must be 5–32 letters, numbers, or underscores.' };
    }
    return { username: username.toLowerCase() };
}

function parseRegistrationReceipt(receiptData) {
    if (typeof receiptData !== 'string' || !receiptData) {
        return { error: 'Upload a payment receipt before submitting this registration.' };
    }
    const match = receiptData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return { error: 'Receipt must be a PNG, JPG, or WebP image up to 5 MB.' };
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) {
        return { error: 'Receipt image must be 5 MB or smaller.' };
    }
    if (buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
        return { error: 'Receipt image data is invalid. Upload the image again.' };
    }
    return { data: receiptData, mime: match[1], buffer };
}

async function acquireRegistrationIdentityLock(connection) {
    const [rows] = await connection.execute('SELECT GET_LOCK(?, 5) AS acquired', [REGISTRATION_IDENTITY_LOCK]);
    return Number(rows[0]?.acquired) === 1;
}

function registrationReceiptKey(registration) {
    return String(registration.paymentGroupId || registration._id || '');
}

async function claimPaymentReceipt(connection, receipt, claimKey, playerId) {
    const receiptHash = crypto.createHash('sha256').update(receipt.buffer).digest('hex');
    const [existingClaims] = await connection.execute(
        'SELECT claim_key AS claimKey FROM payment_receipt_claims WHERE receipt_hash = ? FOR UPDATE',
        [receiptHash],
    );
    if (existingClaims.length) {
        if (existingClaims[0].claimKey === claimKey) return receiptHash;
        throw Object.assign(new Error('This payment receipt has already been used for another registration.'), { code: 'RECEIPT_ALREADY_USED' });
    }

    try {
        await connection.execute(
            'INSERT INTO payment_receipt_claims (receipt_hash, claim_key, player_id) VALUES (?, ?, ?)',
            [receiptHash, claimKey, playerId ? String(playerId) : null],
        );
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const [claims] = await connection.execute(
            'SELECT claim_key AS claimKey FROM payment_receipt_claims WHERE receipt_hash = ? FOR UPDATE',
            [receiptHash],
        );
        if (claims[0]?.claimKey !== claimKey) {
            throw Object.assign(new Error('This payment receipt has already been used for another registration.'), { code: 'RECEIPT_ALREADY_USED' });
        }
    }
    return receiptHash;
}

const tournamentName = (weekId) => `Prime Ethiopia Cup ${weekId + 1}`;

function nextPassStage(stage) {
    const index = PASS_STAGE_ORDER.indexOf(stage);
    return index >= 0 && index < PASS_STAGE_ORDER.length - 1 ? PASS_STAGE_ORDER[index + 1] : null;
}

function currentPassStage(registration) {
    return registration.passStage
        || (registration.checkInStatus === 'checked_in' ? 'check_in' : 'not_started');
}
const WeeklyTournament = new MySqlModel('tournaments', {
    defaults: {
        capacity: DEFAULT_CAPACITY,
        entryFee: 1500,
        prizePool: 20000,
        prizeTiers: [],
        type: 'weekly',
        format: 'knockout',
        slotsReconciled: false,
        status: 'open',
        matches: [],
    },
    unique: ['weekId'],
});
const Registration = new MySqlModel('registrations', {
    defaults: {
        psnId: '',
        telegramUsername: '',
        playerId: null,
        playerCode: '',
        avatar: '',
        slotReserved: false,
        receiptData: '',
        paymentStatus: 'pending',
        approvedAt: null,
        rejectedAt: null,
    },
    unique: ['confirmationCode'],
});
const Player = new MySqlModel('players', {
    defaults: {
        telegramUsername: '',
        psnId: '',
        avatar: '',
        passwordHash: '',
    },
    unique: ['contact', 'contactKey', 'playerCode'],
});
const PlayerCounter = new MySqlModel('counters', {
    timestamps: false,
    defaults: { value: 0 },
});
const TournamentCounter = new MySqlModel('counters', {
    timestamps: false,
    defaults: { value: 0 },
});

const sessions = new Map();
const playerSessions = new Map();
const staffSessions = new Map();
const loginAttempts = new Map();
const playerLoginAttempts = new Map();
let telegramMessenger = null;
let telegramPassMessenger = null;

function setTelegramMessenger(messenger) {
    telegramMessenger = messenger;
}

function setTelegramPassMessenger(messenger) {
    telegramPassMessenger = messenger;
}

async function sendPassTelegram(player, registration) {
    if (!player?.telegramChatId) return;
    const caption = `Your Prime Ethiopia Cup digital pass for ${registration.playerName}. Keep this QR code ready at check-in.`;
    try {
        if (!telegramPassMessenger) {
            await notifyTelegram(player, `${caption} Pass code: ${registration.passToken}`);
            return;
        }
        const image = await QRCode.toBuffer(`PGZ-PASS:${registration.passToken}`, {
            type: 'png',
            width: 360,
            margin: 2,
            errorCorrectionLevel: 'M',
        });
        await telegramPassMessenger(String(player.telegramChatId), image, caption);
    } catch (error) {
        console.error('Telegram digital pass could not be sent:', error?.message || error);
    }
}

async function notifyTelegram(player, message) {
    if (!telegramMessenger || !player?.telegramChatId) return;
    try {
        await telegramMessenger(String(player.telegramChatId), message);
    } catch (error) {
        console.error('Telegram notification could not be sent:', error?.message || error);
    }
}

async function linkTelegramUsername(username, chatId) {
    const normalized = normalizeTelegramUsername(username);
    if (!/^[a-z0-9_]{5,32}$/.test(normalized) || !/^\d+$/.test(String(chatId))) return false;
    const [rows] = await getPool().execute(
        `SELECT id FROM pgz_players
         WHERE LOWER(JSON_UNQUOTE(JSON_EXTRACT(document, '$.telegramUsername'))) = ?
         LIMIT 1`,
        [normalized],
    );
    if (!rows.length) return false;
    const player = await Player.findById(rows[0].id);
    if (!player) return false;
    const players = await Player.find({});
    if (players.some((candidate) => (
        String(candidate._id) !== String(player._id)
        && String(candidate.telegramChatId || '') === String(chatId)
    ))) return false;
    player.telegramChatId = String(chatId);
    await player.save();
    return true;
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map((cookie) => {
        const separator = cookie.indexOf('=');
        if (separator < 0) return ['', ''];
        return [
            cookie.slice(0, separator).trim(),
            cookie.slice(separator + 1).trim(),
        ];
    }).filter(([name]) => name));
}

function clientOrigins() {
    return [
        'http://localhost:5173,http://127.0.0.1:5173',
        process.env.CLIENT_ORIGIN,
        process.env.WEB_APP_URL,
    ]
        .flatMap((origin) => (origin || '').split(','))
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

function sendDatabaseError(res, error, message) {
    console.error(`${message} failed:`, error?.message || error);
    if (error?.code === 'DB_NOT_CONNECTED') {
        return res.status(503).json({ error: 'MySQL is unavailable. Start XAMPP MySQL and try again.' });
    }
    if (error?.fatal || [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EPIPE',
        'PROTOCOL_CONNECTION_LOST',
        'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
        'PROTOCOL_SEQUENCE_TIMEOUT',
        'ER_SERVER_SHUTDOWN',
    ].includes(error?.code)) {
        return res.status(503).json({ error: 'The database connection was interrupted. Please retry shortly.' });
    }
    return res.status(500).json({ error: message });
}

async function createPlayerNotification(playerId, { type, title, message }) {
    const pool = getPool();
    await pool.execute(
        'INSERT INTO notifications (player_id, type, title, message) VALUES (?, ?, ?, ?)',
        [String(playerId), type, title, message],
    );
}

async function tryCreatePlayerNotification(playerId, notification) {
    try {
        await createPlayerNotification(playerId, notification);
        return null;
    } catch (error) {
        console.error('Player notification could not be created:', error?.message || error);
        return 'The main action succeeded, but its notification could not be saved.';
    }
}

async function getUnreadNotificationCount(playerId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT COUNT(*) AS count FROM notifications WHERE player_id = ? AND is_read = FALSE',
        [String(playerId)],
    );
    return Number(rows[0].count);
}

function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store, private');
    const token = parseCookies(req.headers.cookie).prime_admin_session;
    const session = token && sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        if (token) sessions.delete(token);
        return res.status(401).json({ error: 'Admin sign-in is required.' });
    }
    session.expiresAt = Date.now() + SESSION_LIFETIME_MS;
    return next();
}

function requireTrustedOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin && !clientOrigins().includes(origin)) {
        return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    return next();
}

function nextMonthWeeks() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
    return Array.from({ length: 4 }, (_, weekId) => {
        const start = new Date(monthStart.getFullYear(), monthStart.getMonth(), weekId * 7 + 1);
        const end = new Date(monthStart.getFullYear(), monthStart.getMonth(), weekId * 7 + 7);
        return {
            weekId,
            name: tournamentName(weekId),
            dateRange: `${formatter.format(start)} - ${formatter.format(end)}`,
            capacity: DEFAULT_CAPACITY,
            availableSlots: DEFAULT_CAPACITY,
            status: 'open',
        };
    });
}

async function nextTournamentWeekId(tournaments) {
    const highestExistingId = tournaments.reduce(
        (maximum, tournament) => Math.max(maximum, tournament.weekId),
        -1,
    );
    const existingCounter = await TournamentCounter.findOne({ _id: 'tournament-sequence' });
    if (existingCounter) {
        const counter = await TournamentCounter.findOneAndUpdate(
            { _id: 'tournament-sequence' },
            { $inc: { value: 1 } },
            { new: true },
        );
        return counter.value;
    }
    try {
        const counter = await TournamentCounter.findOneAndUpdate(
            { _id: 'tournament-sequence' },
            { $set: { value: highestExistingId }, $inc: { value: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        return counter.value;
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const counter = await TournamentCounter.findOneAndUpdate(
            { _id: 'tournament-sequence' },
            { $inc: { value: 1 } },
            { new: true },
        );
        return counter.value;
    }
}

async function ensureWeeks() {
    const defaults = nextMonthWeeks();
    if (!(await WeeklyTournament.exists({}))) {
        try {
            await WeeklyTournament.insertMany(defaults, { ordered: false });
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
    }
    const unreconciled = await WeeklyTournament.find({ slotsReconciled: { $ne: true } });
    for (const tournament of unreconciled) {
        await Registration.updateMany(
            { weekId: tournament.weekId, paymentStatus: { $in: ['pending', 'approved'] } },
            { $set: { slotReserved: true } },
        );
        const reserved = await Registration.countDocuments({
            weekId: tournament.weekId,
            paymentStatus: { $in: ['pending', 'approved'] },
        });
        tournament.availableSlots = Math.max(0, tournament.capacity - reserved);
        if (tournament.status === 'open' || tournament.status === 'full') {
            tournament.status = tournament.availableSlots === 0 ? 'full' : 'open';
        }
        tournament.slotsReconciled = true;
        await tournament.save();
    }
    for (const tournament of await WeeklyTournament.find({})) {
        let changed = false;
        const name = tournamentName(tournament.weekId);
        if (tournament.name !== name) {
            tournament.name = name;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(tournament, 'theme')) {
            delete tournament.theme;
            changed = true;
        }
        if (!Number.isInteger(tournament.prizePool)) {
            tournament.prizePool = 20000;
            changed = true;
        }
        if (!TOURNAMENT_TYPES.includes(tournament.type)) {
            tournament.type = 'weekly';
            changed = true;
        }
        if (!TOURNAMENT_FORMATS.includes(tournament.format)) {
            tournament.format = 'knockout';
            changed = true;
        }
        const prizeTiers = normalizePrizeTiers(tournament.prizeTiers);
        if (!prizeTiers) {
            tournament.prizeTiers = defaultPrizeTiers(tournament.prizePool);
            changed = true;
        } else if (JSON.stringify(prizeTiers) !== JSON.stringify(tournament.prizeTiers)) {
            tournament.prizeTiers = prizeTiers;
            changed = true;
        }
        if (changed) {
            await tournament.save();
        }
    }
    return WeeklyTournament.find({}).sort({ weekId: 1 });
}

function defaultPrizeTiers(prizePool = 20000) {
    const first = Math.round(prizePool * 0.5);
    const second = Math.round(prizePool * 0.25);
    const third = Math.round(prizePool * 0.15);
    return [first, second, third, prizePool - first - second - third]
        .map((amount, index) => ({ rank: index + 1, amount, reward: '' }));
}

function normalizePrizeTiers(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRIZE_TIERS) return null;
    let total = 0;
    const tiers = [];
    for (const [index, tier] of value.entries()) {
        if (!tier || tier.rank !== index + 1 || !Number.isInteger(tier.amount)
            || tier.amount < 0 || typeof (tier.reward ?? '') !== 'string'
            || (tier.reward ?? '').trim().length > 120) return null;
        total += tier.amount;
        if (total > MAX_PRIZE_POOL) return null;
        tiers.push({ rank: tier.rank, amount: tier.amount, reward: (tier.reward || '').trim() });
    }
    return tiers;
}

function parsePrizeDistribution(value, fallbackPool = 20000) {
    if (value === undefined) {
        if (!Number.isInteger(fallbackPool) || fallbackPool < 0 || fallbackPool > MAX_PRIZE_POOL) return null;
        return { prizeTiers: defaultPrizeTiers(fallbackPool), prizePool: fallbackPool };
    }
    const prizeTiers = normalizePrizeTiers(value);
    if (!prizeTiers) return null;
    return {
        prizeTiers,
        prizePool: prizeTiers.reduce((sum, tier) => sum + tier.amount, 0),
    };
}

function normalizeContact(contact) {
    const digits = String(contact || '').replace(/\D/g, '');
    const localMobile = digits.match(/^0([79]\d{8})$/);
    if (localMobile) return `251${localMobile[1]}`;
    if (/^251[79]\d{8}$/.test(digits)) return digits;
    return digits || String(contact || '').trim().toLowerCase();
}

function isValidContact(contact) {
    const digits = String(contact || '').replace(/\D/g, '');
    return /^(?:0[79]\d{8}|251[79]\d{8})$/.test(digits);
}

function normalizePlayerName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function registrationWasEliminated(registration, tournament) {
    const registrationId = String(registration._id || '');
    if (!registrationId || registration.paymentStatus !== 'approved') return false;
    return (tournament?.matches || []).some((match) => (
        match.status === 'finished'
        && match.player1Id && match.player2Id
        && (String(match.player1Id) === registrationId || String(match.player2Id) === registrationId)
        && match.winnerId
        && String(match.winnerId) !== registrationId
    ));
}

function registrationIsActive(registration, tournament) {
    return ['pending', 'approved'].includes(registration.paymentStatus)
        && ACTIVE_TOURNAMENT_STATUSES.includes(tournament?.status)
        && !registrationWasEliminated(registration, tournament);
}

function findActiveRegistration(registrations, tournaments) {
    const tournamentByWeek = new Map(tournaments.map((tournament) => [Number(tournament.weekId), tournament]));
    return registrations.find((registration) => (
        registration.registeredForOthers !== true
        && registrationIsActive(registration, tournamentByWeek.get(Number(registration.weekId)))
    )) || null;
}

function registrationIdentityMatches(registration, candidate) {
    const contactKey = candidate.contact ? normalizeContact(candidate.contact) : '';
    const nameKey = normalizePlayerName(candidate.playerName);
    const telegramKey = String(candidate.telegramUsername || '').trim().replace(/^@/, '').toLowerCase();
    return (candidate.ownsAccount && registration.registeredForOthers !== true
        && String(registration.playerId || '') === String(candidate.playerId || ''))
        || (contactKey && normalizeContact(registration.contact) === contactKey)
        || (nameKey && normalizePlayerName(registration.playerName) === nameKey)
        || (telegramKey && String(registration.telegramUsername || '').replace(/^@/, '').toLowerCase() === telegramKey);
}

function findRegistrationIdentityConflict(registrations, candidates, weekId, tournament) {
    const active = registrations.filter((registration) => (
        Number(registration.weekId) === Number(weekId)
        && registrationIsActive(registration, tournament)
    ));
    const seenCandidates = [];
    for (const candidate of candidates) {
        const contactKey = candidate.contact ? normalizeContact(candidate.contact) : '';
        const nameKey = normalizePlayerName(candidate.playerName);
        const telegramKey = String(candidate.telegramUsername || '').trim().replace(/^@/, '').toLowerCase();
        const duplicate = active.some((registration) => registrationIdentityMatches(registration, candidate))
            || seenCandidates.some((previous) => (
            (contactKey && previous.contactKey === contactKey)
            || (nameKey && previous.nameKey === nameKey)
            || (telegramKey && previous.telegramKey === telegramKey)
        ));
        if (duplicate) return candidate.playerName || candidate.contact || 'player';
        seenCandidates.push({ contactKey, nameKey, telegramKey });
    }
    return null;
}

function findActiveIdentityConflict(registrations, candidates, requestedWeekId, tournaments) {
    const tournamentByWeek = new Map(tournaments.map((tournament) => [Number(tournament.weekId), tournament]));
    for (const candidate of candidates) {
        const conflict = registrations.find((registration) => (
            Number(registration.weekId) !== Number(requestedWeekId)
            && registrationIsActive(registration, tournamentByWeek.get(Number(registration.weekId)))
            && registrationIdentityMatches(registration, candidate)
        ));
        if (conflict) return Number(conflict.weekId);
    }
    return null;
}

async function createPlayerCode() {
    let counter;
    try {
        counter = await PlayerCounter.findOneAndUpdate(
            { _id: 'player-code' },
            { $inc: { value: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        counter = await PlayerCounter.findOneAndUpdate(
            { _id: 'player-code' },
            { $inc: { value: 1 } },
            { new: true },
        );
    }
    return `PGZ${String(counter.value).padStart(3, '0')}`;
}

async function ensurePlayer({ contact, displayName, psnId = '', telegramUsername = '' }) {
    const contactKey = normalizeContact(contact);
    let player = await findPlayerByContact(contact);
    if (telegramUsername && telegramUsernameConflict(await Player.find({}), telegramUsername, player?._id)) {
        throw Object.assign(new Error('This Telegram username is already linked to another player account.'), { code: 'TELEGRAM_IDENTITY_CONFLICT' });
    }
    if (player) {
        if (player.contactKey !== contactKey) {
            player.contactKey = contactKey;
            await player.save();
        }
        if (telegramUsername && player.telegramUsername !== telegramUsername) {
            player.telegramUsername = telegramUsername;
            await player.save();
        }
        return player;
    }
    const playerCode = await createPlayerCode();
    try {
        player = await Player.create({
            contact: contact.trim(),
            contactKey,
            displayName: displayName.trim(),
            psnId: psnId.trim(),
            telegramUsername,
            playerCode,
        });
        return player;
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        player = await findPlayerByContact(contact);
        if (player) return player;
        throw error;
    }
}

async function findPlayerByContact(contact, includePasswordHash = false) {
    const contactKey = normalizeContact(contact);
    const exactQuery = Player.findOne({ contactKey });
    if (includePasswordHash) exactQuery.select('+passwordHash');
    const exactMatch = await exactQuery;
    if (exactMatch) return exactMatch;

    const allPlayersQuery = Player.find({});
    if (includePasswordHash) allPlayersQuery.select('+passwordHash');
    const players = await allPlayersQuery;
    return players.find((player) => normalizeContact(player.contact || player.contactKey) === contactKey) || null;
}

function publicPlayer(player) {
    return {
        id: player._id,
        displayName: player.displayName,
        contact: player.contact,
        telegramUsername: player.telegramUsername,
        psnId: player.psnId,
        playerCode: player.playerCode,
        avatar: player.avatar || '',
    };
}

function chatIdForPlayer(playerId) {
    return getPool().execute(
        'INSERT INTO player_chats (player_id) VALUES (?) ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP',
        [String(playerId)],
    ).then(async () => {
        const [rows] = await getPool().execute(
            'SELECT id FROM player_chats WHERE player_id = ?',
            [String(playerId)],
        );
        if (!rows.length) throw new Error('Chat conversation could not be initialized.');
        return rows[0].id;
    });
}

const CHAT_REACTIONS = ['👍', '❤️', '🔥', '😂', '🙌'];
const CHAT_ATTACHMENT_LIMIT = 5 * 1024 * 1024;
const CHAT_ATTACHMENT_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
    'application/pdf', 'text/plain', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function parseChatMessageInput(input = {}) {
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (body.length > 2000) return { error: 'Messages must be 2,000 characters or fewer.' };

    let attachment = null;
    if (input.attachmentData) {
        if (typeof input.attachmentData !== 'string' || input.attachmentData.length > 7_100_000) {
            return { error: 'Chat attachments must be 5 MB or smaller.' };
        }
        const match = input.attachmentData.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i);
        if (!match || !CHAT_ATTACHMENT_TYPES.has(match[1].toLowerCase())) {
            return { error: 'Choose a supported image, audio recording, or document.' };
        }
        const data = Buffer.from(match[2], 'base64');
        if (!data.length || data.length > CHAT_ATTACHMENT_LIMIT) {
            return { error: 'Chat attachments must be 5 MB or smaller.' };
        }
        const mime = match[1].toLowerCase();
        const type = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file';
        if (input.messageType && input.messageType !== type) {
            return { error: 'The attachment type does not match its content.' };
        }
        const name = typeof input.attachmentName === 'string'
            ? input.attachmentName.replace(/[\\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 180)
            : '';
        attachment = { data, mime, name: name || `${type}-attachment` , type };
    } else if (input.messageType && input.messageType !== 'text') {
        return { error: 'Add a matching attachment to send this message type.' };
    }

    if (!body && !attachment) return { error: 'Write a message or attach a file before sending.' };
    return { body, attachment };
}

function parseChatBackground(input = {}) {
    const imageData = input.imageData;
    if (typeof imageData !== 'string' || imageData.length > 2_800_000) {
        return { error: 'Choose a resized background image no larger than 2 MB.' };
    }
    const match = imageData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return { error: 'Background images must be PNG, JPG, or WebP.' };
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > 2 * 1024 * 1024) {
        return { error: 'Background images must be 2 MB or smaller after resizing.' };
    }
    return { data, mime: match[1] };
}

async function loadChatMessages(pool, chatId, playerId) {
    const [messages] = await pool.execute(
        `SELECT id, sender, body, message_type AS messageType,
                attachment_mime AS attachmentMime, attachment_name AS attachmentName,
                is_pinned AS isPinned, edited_at AS editedAt, deleted_at AS deletedAt,
                read_at AS readAt, created_at AS createdAt
         FROM chat_messages WHERE chat_id = ?
         ORDER BY id DESC LIMIT 200`,
        [chatId],
    );
    messages.reverse();
    if (!messages.length) return messages;

    const ids = messages.map((message) => message.id);
    const [reactions] = await pool.query(
        `SELECT message_id AS messageId, actor, actor_id AS actorId, emoji
         FROM chat_message_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`,
        ids,
    );
    const reactionsByMessage = new Map();
    for (const reaction of reactions) {
        const grouped = reactionsByMessage.get(String(reaction.messageId)) || new Map();
        const existing = grouped.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, reacted: false };
        existing.count += 1;
        existing.reacted ||= reaction.actor === playerId.actor && reaction.actorId === String(playerId.id);
        grouped.set(reaction.emoji, existing);
        reactionsByMessage.set(String(reaction.messageId), grouped);
    }
    return messages.map((message) => ({
        ...message,
        body: message.deletedAt ? '' : message.body || '',
        messageType: message.messageType || 'text',
        isPinned: Boolean(message.isPinned),
        attachmentUrl: message.attachmentMime
            ? playerId.admin
                ? `/api/admin/chats/${playerId.playerId}/messages/${message.id}/attachment`
                : `/api/player/chat/messages/${message.id}/attachment`
            : null,
        reactions: [...(reactionsByMessage.get(String(message.id))?.values() || [])],
    }));
}

async function insertChatMessage(pool, { chatId, sender, body, attachment }) {
    const [result] = await pool.execute(
        `INSERT INTO chat_messages
            (chat_id, sender, body, message_type, attachment_data, attachment_mime, attachment_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            chatId,
            sender,
            body || '',
            attachment?.type || 'text',
            attachment?.data || null,
            attachment?.mime || null,
            attachment?.name || null,
        ],
    );
    await pool.execute('UPDATE player_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [chatId]);
    return result.insertId;
}

async function setChatTyping(pool, chatId, actor, typing) {
    const column = actor === 'player' ? 'player_typing_until' : 'admin_typing_until';
    await pool.execute(
        `INSERT INTO chat_presence (chat_id, ${column}) VALUES (?, IF(?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 7 SECOND), NULL))
         ON DUPLICATE KEY UPDATE ${column} = IF(?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 7 SECOND), NULL)`,
        [chatId, typing, typing],
    );
}

async function toggleChatReaction(pool, messageId, actor, actorId, emoji) {
    const [existing] = await pool.execute(
        'SELECT message_id FROM chat_message_reactions WHERE message_id = ? AND actor = ? AND actor_id = ? AND emoji = ?',
        [messageId, actor, String(actorId), emoji],
    );
    if (existing.length) {
        await pool.execute(
            'DELETE FROM chat_message_reactions WHERE message_id = ? AND actor = ? AND actor_id = ? AND emoji = ?',
            [messageId, actor, String(actorId), emoji],
        );
        return false;
    }
    await pool.execute(
        'INSERT INTO chat_message_reactions (message_id, actor, actor_id, emoji) VALUES (?, ?, ?, ?)',
        [messageId, actor, String(actorId), emoji],
    );
    return true;
}

async function pinChatMessage(pool, chatId, messageId) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('SELECT id FROM player_chats WHERE id = ? FOR UPDATE', [chatId]);
        const [existing] = await connection.execute(
            'SELECT is_pinned AS isPinned FROM chat_messages WHERE id = ? AND chat_id = ? AND deleted_at IS NULL',
            [messageId, chatId],
        );
        if (!existing.length) {
            await connection.commit();
            return null;
        }
        if (existing[0].isPinned) {
            await connection.execute(
                'UPDATE chat_messages SET is_pinned = FALSE WHERE id = ? AND chat_id = ?',
                [messageId, chatId],
            );
            await connection.commit();
            return false;
        }
        await connection.execute('UPDATE chat_messages SET is_pinned = FALSE WHERE chat_id = ?', [chatId]);
        await connection.execute(
            'UPDATE chat_messages SET is_pinned = TRUE WHERE id = ? AND chat_id = ? AND deleted_at IS NULL',
            [messageId, chatId],
        );
        await connection.commit();
        return true;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function sendChatAttachment(res, pool, chatId, messageId) {
    const [rows] = await pool.execute(
        `SELECT attachment_data AS data, attachment_mime AS mime, attachment_name AS name, message_type AS messageType
         FROM chat_messages WHERE id = ? AND chat_id = ? AND deleted_at IS NULL`,
        [messageId, chatId],
    );
    if (!rows.length || !rows[0].data) return res.status(404).json({ error: 'Chat attachment not found.' });
    const { data, mime, name, messageType } = rows[0];
    res.set('Cache-Control', 'no-store, private');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', mime);
    const disposition = messageType === 'image' || messageType === 'audio' ? 'inline' : 'attachment';
    const safeName = String(name || 'chat-attachment');
    const fallbackName = safeName.replace(/[^\x20-\x7e]|["\\;]/g, '_');
    const encodedName = encodeURIComponent(safeName).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set('Content-Disposition', `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
    return res.send(data);
}

async function sendMatchDayReminders() {
    const now = Date.now();
    const tournaments = await WeeklyTournament.find({ status: { $ne: 'completed' } });
    for (const tournament of tournaments) {
        let changed = false;
        const registrations = await Registration.find({ weekId: tournament.weekId, paymentStatus: 'approved' });
        const registrationsById = new Map(registrations.map((item) => [String(item._id), item]));
        for (const match of tournament.matches || []) {
            if (!shouldSendMatchReminder(match, now)) continue;
            const players = [match.player1Id, match.player2Id]
                .map((id) => registrationsById.get(String(id)))
                .filter((item) => item?.playerId);
            const kickoff = new Intl.DateTimeFormat('en-ET', {
                timeZone: 'Africa/Addis_Ababa',
                hour: 'numeric',
                minute: '2-digit',
            }).format(new Date(match.scheduledAt));
            const location = match.location ? ` at ${match.location}` : '';
            for (const [index, registration] of players.entries()) {
                const opponent = players[1 - index];
                const message = `Your match starts in about 15 minutes at ${kickoff}${location}${opponent ? ` vs ${opponent.playerName}` : ''}.`;
                await tryCreatePlayerNotification(registration.playerId, {
                    type: 'match_reminder',
                    title: 'Match today',
                    message,
                });
                const player = await Player.findById(registration.playerId);
                await notifyTelegram(player, message);
            }
            match.reminderSentFor = new Date(match.scheduledAt).toISOString();
            changed = true;
        }
        if (changed) {
            await tournament.save();
        }
    }
}

function shouldSendMatchReminder(match, now = Date.now()) {
    if (!match?.scheduledAt || match.status !== 'pending'
        || !match.player1Id || !match.player2Id) return false;
    const scheduledAt = new Date(match.scheduledAt).getTime();
    if (!Number.isFinite(scheduledAt) || scheduledAt <= now
        || scheduledAt - now > MATCH_REMINDER_WINDOW_MS) return false;
    return match.reminderSentFor !== new Date(scheduledAt).toISOString();
}

function requirePlayer(req, res, next) {
    res.set('Cache-Control', 'no-store, private');
    const token = parseCookies(req.headers.cookie).prime_player_session;
    const session = token && playerSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        if (token) playerSessions.delete(token);
        return res.status(401).json({ error: 'Player sign-in is required.' });
    }
    req.playerId = session.playerId;
    session.expiresAt = Date.now() + PLAYER_SESSION_LIFETIME_MS;
    return next();
}

function requireStaff(req, res, next) {
    res.set('Cache-Control', 'no-store, private');
    const token = parseCookies(req.headers.cookie).prime_staff_session;
    const session = token && staffSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        if (token) staffSessions.delete(token);
        return res.status(401).json({ error: 'Staff sign-in is required.' });
    }
    session.expiresAt = Date.now() + SESSION_LIFETIME_MS;
    req.staffId = session.staffId;
    return next();
}

function setPlayerSession(res, token) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.set('Set-Cookie', `prime_player_session=${token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${PLAYER_SESSION_LIFETIME_MS / 1000}${secure}`);
}

async function attachPlayerToRegistration(registration) {
    if (registration.playerId && registration.playerCode) return registration;
    const player = await ensurePlayer({
        contact: registration.contact,
        displayName: registration.playerName,
        psnId: registration.psnId || '',
    });
    registration.playerId = player._id;
    registration.playerCode = player.playerCode;
    registration.avatar = player.avatar || '';
    await registration.save();
    return registration;
}

async function linkPlayerRegistrations(player) {
    const playerContactKey = normalizeContact(player.contact || player.contactKey);
    const unlinked = await Registration.find({ playerId: null }).select('_id contact');
    const matchingIds = unlinked
        .filter((registration) => normalizeContact(registration.contact) === playerContactKey)
        .map((registration) => registration._id);
    if (!matchingIds.length) return;
    await Registration.updateMany(
        { _id: { $in: matchingIds }, playerId: null },
        { $set: {
            playerId: player._id,
            playerCode: player.playerCode,
            avatar: player.avatar || '',
        } },
    );
}

function activeTournamentWeekIdFrom(registrations, tournaments) {
    const registeredWeekIds = new Set(registrations
        .map((registration) => Number(registration.weekId))
        .filter((weekId) => Number.isInteger(weekId) && weekId >= 0));
    const eligibleRegistrations = registrations.filter((registration) => (
        registration.registeredForOthers !== true
        &&
        registeredWeekIds.has(Number(registration.weekId))
        && registrationIsActive(registration, tournaments.find((tournament) => (
            Number(tournament.weekId) === Number(registration.weekId)
        )))
    ));
    const activeTournament = tournaments.find((tournament) => eligibleRegistrations.some((registration) => (
        Number(registration.weekId) === Number(tournament.weekId)
    )));
    return activeTournament ? Number(activeTournament.weekId) : null;
}

function hasDifferentActiveTournament(activeWeekId, requestedWeekId) {
    if (activeWeekId === null || activeWeekId === undefined) return false;
    const activeId = Number(activeWeekId);
    const requestedId = Number(requestedWeekId);
    return Number.isInteger(activeId) && Number.isInteger(requestedId) && activeId !== requestedId;
}

async function activeTournamentWeekId(playerId) {
    const registrations = await Registration.find({
        playerId,
        paymentStatus: { $in: ['pending', 'approved'] },
        registeredForOthers: { $ne: true },
    }).select('_id weekId paymentStatus registeredForOthers');
    const weekIds = [...new Set(registrations
        .map((registration) => Number(registration.weekId))
        .filter((weekId) => Number.isInteger(weekId) && weekId >= 0))];
    if (!weekIds.length) return null;
    const tournaments = await WeeklyTournament.find({ weekId: { $in: weekIds } }).select('weekId status matches');
    return activeTournamentWeekIdFrom(registrations, tournaments);
}

function adminTournament(tournament) {
    const { matches = [], ...details } = tournament.toObject();
    const prizeTiers = normalizePrizeTiers(details.prizeTiers)
        || defaultPrizeTiers(details.prizePool ?? 20000);
    delete details.theme;
    return {
        ...details,
        name: tournamentName(details.weekId),
        prizePool: prizeTiers.reduce((sum, tier) => sum + tier.amount, 0),
        prizeTiers,
        type: TOURNAMENT_TYPES.includes(details.type) ? details.type : 'weekly',
        format: TOURNAMENT_FORMATS.includes(details.format) ? details.format : 'knockout',
        matchesGenerated: matches.length > 0,
        status: tournament.status === 'open' || tournament.status === 'full'
            ? 'upcoming'
            : tournament.status,
    };
}

function roundLabel(round, totalRounds) {
    const remaining = 2 ** (totalRounds - round);
    if (remaining === 2) return 'Final';
    if (remaining === 4) return 'Semi-Finals';
    if (remaining === 8) return 'Quarter-Finals';
    return `Round of ${remaining}`;
}

function nextMatchReady(match) {
    if (!match.player1Ready || !match.player2Ready) return false;
    if (match.player1Id && match.player2Id) {
        match.status = 'pending';
        return false;
    }
    if (!match.player1Id && !match.player2Id) {
        match.status = 'bye';
        match.winnerId = null;
        return true;
    }
    match.status = 'finished';
    match.winnerId = match.player1Id || match.player2Id;
    return true;
}

function advanceMatchWinner(matches, match, winnerId) {
    const nextRound = match.round + 1;
    const nextIndex = Math.floor((match.matchNumber - 1) / 2);
    const next = matches.find((item) => item.round === nextRound && item.matchNumber === nextIndex + 1);
    if (!next) return;

    const isFirstSlot = (match.matchNumber - 1) % 2 === 0;
    const playerKey = isFirstSlot ? 'player1Id' : 'player2Id';
    const readyKey = isFirstSlot ? 'player1Ready' : 'player2Ready';
    next[playerKey] = winnerId;
    next[readyKey] = true;
    if (nextMatchReady(next)) advanceMatchWinner(matches, next, next.winnerId);
}

function generateFixtures(players, random = Math.random, format = 'knockout') {
    if (format === 'league') return generateLeagueFixtures(players);
    const shuffled = [...players];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }

    const totalRounds = Math.ceil(Math.log2(shuffled.length));
    const bracketSize = 2 ** totalRounds;
    const matches = [];
    for (let round = 0; round < totalRounds; round += 1) {
        const count = bracketSize / (2 ** (round + 1));
        for (let index = 0; index < count; index += 1) {
            const match = {
                matchId: `r${round + 1}m${index + 1}`,
                round,
                roundName: roundLabel(round, totalRounds),
                matchNumber: index + 1,
                player1Id: null,
                player2Id: null,
                player1Ready: round === 0,
                player2Ready: round === 0,
                score1: null,
                score2: null,
                status: 'pending',
                winnerId: null,
            };
            if (round === 0) {
                match.player1Id = shuffled[index * 2]?._id || null;
                match.player2Id = shuffled[index * 2 + 1]?._id || null;
            }
            matches.push(match);
        }
    }

    for (const match of matches.filter((item) => item.round === 0)) {
        if (nextMatchReady(match)) {
            advanceMatchWinner(matches, match, match.winnerId);
        }
    }
    return matches;
}

function generateLeagueFixtures(players) {
    if (players.length < 2) return [];
    const rotation = [...players];
    if (rotation.length % 2) rotation.push(null);
    const matches = [];
    const roundCount = rotation.length - 1;
    for (let round = 0; round < roundCount; round += 1) {
        const matchCount = rotation.length / 2;
        for (let index = 0; index < matchCount; index += 1) {
            const first = rotation[index];
            const second = rotation[rotation.length - 1 - index];
            if (!first && !second) continue;
            matches.push({
                matchId: `r${round + 1}m${index + 1}`,
                round,
                roundName: `League Round ${round + 1}`,
                matchNumber: index + 1,
                player1Id: first?._id || null,
                player2Id: second?._id || null,
                player1Ready: true,
                player2Ready: true,
                score1: null,
                score2: null,
                status: first && second ? 'pending' : 'bye',
                winnerId: null,
            });
        }
        rotation.splice(1, 0, rotation.pop());
    }
    return matches;
}

async function maybeGenerateClosedTournamentFixtures(tournament) {
    if (!tournament || tournament.matches?.length
        || !['live', 'full'].includes(tournament.status)) return false;
    const pendingCount = await Registration.countDocuments({
        weekId: tournament.weekId,
        paymentStatus: 'pending',
    });
    if (pendingCount) return false;
    const approved = await Registration.find({ weekId: tournament.weekId, paymentStatus: 'approved' })
        .sort({ approvedAt: 1, createdAt: 1 })
        .limit(tournament.capacity);
    if (approved.length < 2) return false;
    for (const entry of approved) await attachPlayerToRegistration(entry);
    tournament.matches = generateFixtures(approved, Math.random, tournament.format || 'knockout');
    await WeeklyTournament.save(tournament);
    return true;
}

function tournamentStandings(players, matches, format = 'knockout') {
    const finalRound = Math.max(-1, ...matches.map((match) => match.round));
    const stats = new Map(players.map((player) => [String(player._id), {
        player: publicRegistration(player),
        played: 0,
        wins: 0,
        losses: 0,
        points: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        eliminatedRound: -1,
        champion: false,
    }]));

    for (const match of matches) {
        if (match.status !== 'finished' || !match.player1Id || !match.player2Id
            || !Number.isInteger(match.score1) || !Number.isInteger(match.score2)) continue;
        const first = stats.get(String(match.player1Id));
        const second = stats.get(String(match.player2Id));
        if (!first || !second) continue;
        first.played += 1;
        second.played += 1;
        first.goalsFor += match.score1;
        first.goalsAgainst += match.score2;
        second.goalsFor += match.score2;
        second.goalsAgainst += match.score1;
        const winner = stats.get(String(match.winnerId));
        const loser = winner === first ? second : first;
        if (winner) {
            winner.wins += 1;
            if (format === 'league') winner.points += 3;
        }
        loser.losses += 1;
        if (format !== 'league') loser.eliminatedRound = Math.max(loser.eliminatedRound, match.round);
        if (format !== 'league' && match.round === finalRound) {
            if (winner) winner.champion = true;
        }
    }

    const standings = [...stats.values()]
        .sort((left, right) => Number(right.champion) - Number(left.champion)
            || (format === 'league' ? right.points - left.points : 0)
            || right.eliminatedRound - left.eliminatedRound
            || right.wins - left.wins
            || (right.goalsFor - right.goalsAgainst) - (left.goalsFor - left.goalsAgainst)
            || left.player.playerName.localeCompare(right.player.playerName))
        .map((standing, index) => ({ rank: index + 1, ...standing }));
    if (format === 'league' && matches.length
        && matches.every((match) => ['finished', 'bye'].includes(match.status))
        && standings[0]) standings[0].champion = true;
    return standings;
}

function publicMatches(matches, registrations) {
    const players = new Map(registrations.map((player) => [String(player._id), publicRegistration(player)]));
    return matches.map((match) => {
        const plainMatch = typeof match.toObject === 'function' ? match.toObject() : match;
        return {
            ...plainMatch,
            player1: match.player1Id ? players.get(String(match.player1Id)) || null : null,
            player2: match.player2Id ? players.get(String(match.player2Id)) || null : null,
        };
    });
}

function scheduledMatchForRegistration(tournament, registrationId) {
    if (!tournament || !Array.isArray(tournament.matches)) return null;
    const id = String(registrationId);
    return tournament.matches.find((match) => (
        (String(match.player1Id || '') === id || String(match.player2Id || '') === id)
        && match.scheduledAt
        && !Number.isNaN(new Date(match.scheduledAt).getTime())
    )) || null;
}

function checkInAvailabilityError(match, now = Date.now()) {
    if (!match?.scheduledAt || Number.isNaN(new Date(match.scheduledAt).getTime())
        || now >= new Date(match.scheduledAt).getTime()) return null;
    const kickoff = new Intl.DateTimeFormat('en-ET', {
        timeZone: 'Africa/Addis_Ababa',
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(match.scheduledAt));
    return `This player's match is scheduled for ${kickoff}${match.location ? ` at ${match.location}` : ''}. Please ask them to come back at their match time.`;
}

function publicRegistration(registration, includeAvatar = true) {
    const result = {
        id: registration._id,
        playerName: registration.playerName,
        contact: registration.contact,
        psnId: registration.psnId,
        telegramUsername: registration.telegramUsername || '',
        playerCode: registration.playerCode || '',
        confirmationCode: registration.confirmationCode,
        weekId: registration.weekId,
        payment: registration.payment,
        paymentStatus: registration.paymentStatus,
        paymentGroupId: registration.paymentGroupId || null,
        registeredForOthers: registration.registeredForOthers === true,
        sessionPreference: registration.sessionPreference || 'any',
        rejectionReason: registration.rejectionReason || null,
        hasPass: registration.paymentStatus === 'approved' && Boolean(registration.passToken),
        checkInStatus: registration.checkInStatus || 'not_checked_in',
        readyStatus: registration.readyStatus || 'not_ready',
        passStage: currentPassStage(registration),
        createdAt: registration.createdAt,
        approvedAt: registration.approvedAt,
    };
    if (includeAvatar) result.avatar = registration.avatar || '';
    return result;
}

function publicBracketPlayer(player) {
    if (!player) return null;
    return {
        id: player.id,
        playerName: player.playerName,
        psnId: player.psnId,
        playerCode: player.playerCode || '',
        avatar: player.avatar || '',
    };
}

async function registerPlayerForTournament({ playerId, weekId, payment, receiptData, sessionPreference = 'any' }) {
    const parsedWeekId = Number(weekId);
    if (!['any', 'morning', 'afternoon', 'evening'].includes(sessionPreference)
        || !PAYMENT_METHODS.includes(payment)
        || !Number.isInteger(parsedWeekId) || parsedWeekId < 0) {
        throw Object.assign(new Error('Enter valid payment, tournament, and session details.'), { code: 'REGISTRATION_INPUT_INVALID' });
    }
    const receipt = parseRegistrationReceipt(receiptData);
    if (receipt.error) throw Object.assign(new Error(receipt.error), { code: 'REGISTRATION_RECEIPT_INVALID' });

    let registrationLock = null;
    let registrationLockName = '';
    let identityLockAcquired = false;
    try {
        await ensureWeeks();
        const player = await Player.findById(playerId);
        if (!player) throw Object.assign(new Error('Player account was not found.'), { code: 'PLAYER_NOT_FOUND' });
        await linkPlayerRegistrations(player);
        registrationLock = await getPool().getConnection();
        registrationLockName = `pgz_active_${String(player._id)}`;
        const [lockRows] = await registrationLock.execute('SELECT GET_LOCK(?, 5) AS acquired', [registrationLockName]);
        if (Number(lockRows[0]?.acquired) !== 1) {
            throw Object.assign(new Error('Registration is busy for this account. Please try again.'), { code: 'REGISTRATION_BUSY' });
        }
        identityLockAcquired = await acquireRegistrationIdentityLock(registrationLock);
        if (!identityLockAcquired) {
            throw Object.assign(new Error('Registration is busy. Please try again shortly.'), { code: 'REGISTRATION_BUSY' });
        }

        const checkout = await Registration.withTransaction(async (connection) => {
            const registrations = await Registration.findRows(connection, true);
            const tournaments = await WeeklyTournament.findRows(connection, true);
            const week = tournaments.find((tournament) => Number(tournament.weekId) === parsedWeekId);
            if (!week || !['open', 'full'].includes(week.status) || Number(week.availableSlots) < 1) {
                throw Object.assign(new Error('This tournament week is not accepting registrations.'), { code: 'REGISTRATION_CLOSED' });
            }
            const playerRegistrations = registrations.filter((registration) => (
                String(registration.playerId || '') === String(player._id)
            ));
            const activeRegistration = findActiveRegistration(playerRegistrations, tournaments);
            if (activeRegistration && Number(activeRegistration.weekId) !== parsedWeekId) {
                throw Object.assign(new Error('You can only be registered in one tournament at a time. Your current tournament must conclude first.'), {
                    code: 'ACTIVE_TOURNAMENT_CONFLICT',
                    activeWeekId: Number(activeRegistration.weekId),
                });
            }
            const candidate = {
                playerId: player._id,
                ownsAccount: true,
                playerName: player.displayName,
                contact: player.contact,
                telegramUsername: player.telegramUsername,
            };
            const activeIdentityWeekId = findActiveIdentityConflict(registrations, [candidate], parsedWeekId, tournaments);
            if (activeIdentityWeekId !== null) {
                throw Object.assign(new Error('You can only be registered in one tournament at a time. Your current tournament must conclude first.'), {
                    code: 'ACTIVE_TOURNAMENT_CONFLICT',
                    activeWeekId: activeIdentityWeekId,
                });
            }
            if (findRegistrationIdentityConflict(registrations, [candidate], parsedWeekId, week)) {
                throw Object.assign(new Error('You are already registered for this active tournament.'), { code: 'REGISTRATION_DUPLICATE' });
            }

            const entry = Registration.prepare({
                playerName: player.displayName,
                contact: player.contact,
                telegramUsername: player.telegramUsername || '',
                sessionPreference,
                playerId: player._id,
                playerCode: player.playerCode,
                avatar: player.avatar,
                slotReserved: true,
                confirmationCode: `PG-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
                weekId: parsedWeekId,
                payment,
                receiptData: receipt.data,
            }, true);
            await claimPaymentReceipt(connection, receipt, String(entry._id), player._id);
            week.availableSlots = Number(week.availableSlots) - 1;
            week.status = week.availableSlots === 0 ? 'full' : 'open';
            await WeeklyTournament.save(week, connection);
            await Registration.save(entry, connection);
            return { entry, week };
        });

        const weekName = checkout.week.name || tournamentName(parsedWeekId);
        const notificationWarning = await tryCreatePlayerNotification(player._id, {
            type: 'registration',
            title: 'Registration received',
            message: `Your request for ${weekName} is pending payment approval.`,
        });
        return {
            registration: publicRegistration(checkout.entry),
            player: publicPlayer(player),
            tournament: { weekId: parsedWeekId, name: weekName, entryFee: checkout.week.entryFee },
            ...(notificationWarning ? { notificationWarning } : {}),
        };
    } finally {
        if (registrationLock) {
            try {
                if (identityLockAcquired) await registrationLock.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
                if (registrationLockName) await registrationLock.execute('SELECT RELEASE_LOCK(?)', [registrationLockName]);
            } catch (error) {
                console.error('Registration lock release failed:', error?.message || error);
            } finally {
                registrationLock.release();
            }
        }
    }
}

async function registerPlayersForTournament({ playerId, weekId, payment, receiptData, participants }) {
    const parsedWeekId = Number(weekId);
    const validParticipants = Array.isArray(participants)
        && participants.length > 0
        && participants.length <= CAPACITY
        && participants.every((participant) => (
            participant
            && typeof participant.playerName === 'string'
            && participant.playerName.trim().length > 0
            && participant.playerName.trim().length <= 60
            && isValidContact(participant.contact)
            && (!participant.telegramUsername || !parseTelegramUsername(participant.telegramUsername).error)
            && ['any', 'morning', 'afternoon', 'evening'].includes(participant.sessionPreference || 'any')
        ));
    if (!PAYMENT_METHODS.includes(payment) || !Number.isInteger(parsedWeekId) || parsedWeekId < 0 || !validParticipants) {
        throw Object.assign(new Error('Provide valid players, phone numbers, payment method, and tournament.'), { code: 'GROUP_INPUT_INVALID' });
    }
    const receipt = parseRegistrationReceipt(receiptData);
    if (receipt.error) throw Object.assign(new Error(receipt.error), { code: 'REGISTRATION_RECEIPT_INVALID' });

    let lockConnection = null;
    let playerLockName = '';
    let identityLockAcquired = false;
    try {
        await ensureWeeks();
        const payer = await Player.findById(playerId);
        if (!payer) throw Object.assign(new Error('Link your player account before registering others.'), { code: 'PLAYER_NOT_FOUND' });
        await linkPlayerRegistrations(payer);
        lockConnection = await getPool().getConnection();
        playerLockName = `pgz_active_${String(payer._id)}`;
        const [playerLockRows] = await lockConnection.execute('SELECT GET_LOCK(?, 5) AS acquired', [playerLockName]);
        if (Number(playerLockRows[0]?.acquired) !== 1) {
            throw Object.assign(new Error('Registration is busy for this account. Please try again.'), { code: 'REGISTRATION_BUSY' });
        }
        identityLockAcquired = await acquireRegistrationIdentityLock(lockConnection);
        if (!identityLockAcquired) {
            throw Object.assign(new Error('Registration is busy. Please try again shortly.'), { code: 'REGISTRATION_BUSY' });
        }

        const groupId = crypto.randomUUID();
        const checkout = await Registration.withTransaction(async (connection) => {
            const registrations = await Registration.findRows(connection, true);
            const tournaments = await WeeklyTournament.findRows(connection, true);
            const week = tournaments.find((tournament) => Number(tournament.weekId) === parsedWeekId);
            if (!week || !['open', 'full'].includes(week.status)
                || Number(week.availableSlots) < participants.length) {
                throw Object.assign(new Error('This tournament does not have enough open slots for the full group.'), { code: 'GROUP_REGISTRATION_CLOSED' });
            }
            const includesPayer = participants.some((participant) => participant.isAccountOwner === true);
            if (includesPayer) {
                const activeRegistration = findActiveRegistration(
                    registrations.filter((entry) => String(entry.playerId || '') === String(payer._id)),
                    tournaments,
                );
                if (activeRegistration && Number(activeRegistration.weekId) !== parsedWeekId) {
                    throw Object.assign(new Error('You can only be registered in one tournament at a time. Your current tournament must conclude first.'), {
                        code: 'ACTIVE_TOURNAMENT_CONFLICT',
                        activeWeekId: Number(activeRegistration.weekId),
                    });
                }
            }
            const candidates = participants.map((participant) => ({
                playerId: payer._id,
                ownsAccount: participant.isAccountOwner === true,
                playerName: participant.playerName.trim(),
                contact: participant.contact,
                telegramUsername: participant.telegramUsername || '',
            }));
            const activeIdentityWeekId = findActiveIdentityConflict(registrations, candidates, parsedWeekId, tournaments);
            if (activeIdentityWeekId !== null) {
                throw Object.assign(new Error('A player in this group is already active in another tournament.'), {
                    code: 'ACTIVE_TOURNAMENT_CONFLICT',
                    activeWeekId: activeIdentityWeekId,
                });
            }
            if (findRegistrationIdentityConflict(registrations, candidates, parsedWeekId, week)) {
                throw Object.assign(new Error('A player in this group is already registered for this tournament.'), { code: 'REGISTRATION_DUPLICATE' });
            }

            week.availableSlots = Number(week.availableSlots) - participants.length;
            week.status = week.availableSlots === 0 ? 'full' : 'open';
            await WeeklyTournament.save(week, connection);
            await claimPaymentReceipt(connection, receipt, groupId, payer._id);
            await connection.execute(
                `INSERT INTO payment_submissions (group_id, receipt_data, receipt_mime)
                 VALUES (?, ?, ?)`,
                [groupId, receipt.buffer, receipt.mime],
            );
            const entries = await Registration.insertMany(participants.map((participant) => ({
                playerName: participant.playerName.trim(),
                contact: participant.contact,
                telegramUsername: normalizeTelegramUsername(participant.telegramUsername),
                playerId: payer._id,
                playerCode: payer.playerCode,
                avatar: payer.avatar,
                slotReserved: true,
                confirmationCode: `PG-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
                weekId: parsedWeekId,
                payment,
                paymentGroupId: groupId,
                registeredForOthers: participant.isAccountOwner !== true,
                sessionPreference: participant.sessionPreference || 'any',
                paymentStatus: 'pending',
                receiptData: '',
                passToken: '',
                checkInStatus: 'not_checked_in',
                readyStatus: 'not_ready',
            })), { connection });
            return { entries, week };
        });
        const warning = await tryCreatePlayerNotification(payer._id, {
            type: 'registration',
            title: 'Registration received',
            message: `${checkout.entries.length} entries for ${checkout.week.name || tournamentName(parsedWeekId)} are pending payment approval.`,
        });
        return {
            groupId,
            registrations: checkout.entries.map((entry) => publicRegistration(entry)),
            tournament: { weekId: parsedWeekId, name: checkout.week.name || tournamentName(parsedWeekId) },
            ...(warning ? { notificationWarning: warning } : {}),
        };
    } finally {
        if (lockConnection) {
            try {
                if (identityLockAcquired) await lockConnection.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
                if (playerLockName) await lockConnection.execute('SELECT RELEASE_LOCK(?)', [playerLockName]);
            } catch (error) {
                console.error('Group registration lock release failed:', error?.message || error);
            } finally {
                lockConnection.release();
            }
        }
    }
}

async function resubmitPlayerPayment({ playerId, registrationId, receiptData, payment }) {
    if (!isValidObjectId(registrationId)) {
        throw Object.assign(new Error('Choose a valid rejected registration.'), { code: 'RESUBMIT_INPUT_INVALID' });
    }
    if (payment !== undefined && !PAYMENT_METHODS.includes(payment)) {
        throw Object.assign(new Error('Choose a valid payment method.'), { code: 'RESUBMIT_INPUT_INVALID' });
    }
    const receipt = parseRegistrationReceipt(receiptData);
    if (receipt.error) throw Object.assign(new Error(receipt.error), { code: 'RESUBMIT_INPUT_INVALID' });

    const identityConnection = await getPool().getConnection();
    let identityLockAcquired = false;
    try {
        identityLockAcquired = await acquireRegistrationIdentityLock(identityConnection);
        if (!identityLockAcquired) {
            throw Object.assign(new Error('Registration is busy. Please try again shortly.'), { code: 'REGISTRATION_BUSY' });
        }
        const result = await Registration.withTransaction(async (connection) => {
            const registrations = await Registration.findRows(connection, true);
            const tournaments = await WeeklyTournament.findRows(connection, true);
            const target = registrations.find((registration) => (
                String(registration._id) === String(registrationId)
                && String(registration.playerId) === String(playerId)
            ));
            if (!target) throw Object.assign(new Error('Rejected registration was not found.'), { code: 'RESUBMIT_NOT_FOUND' });
            if (target.paymentStatus !== 'rejected') {
                throw Object.assign(new Error('Only rejected payments can be resubmitted.'), { code: 'RESUBMIT_CONFLICT' });
            }
            const entries = target.paymentGroupId
                ? registrations.filter((registration) => registration.paymentGroupId === target.paymentGroupId)
                : [target];
            if (entries.some((entry) => (
                String(entry.playerId) !== String(playerId)
                || entry.paymentStatus !== 'rejected'
                || Number(entry.weekId) !== Number(target.weekId)
            ))) {
                throw Object.assign(new Error('This payment group is no longer eligible for resubmission.'), { code: 'RESUBMIT_CONFLICT' });
            }

            const weekId = Number(target.weekId);
            const tournament = tournaments.find((item) => Number(item.weekId) === weekId);
            if (!tournament || !['open', 'full'].includes(tournament.status)
                || Number(tournament.availableSlots) < entries.length) {
                throw Object.assign(new Error('This tournament does not have enough open slots to resubmit the payment.'), { code: 'RESUBMIT_CONFLICT' });
            }
            const candidates = entries.map((entry) => ({
                playerId,
                ownsAccount: entry.registeredForOthers !== true,
                playerName: entry.playerName,
                contact: entry.contact,
                telegramUsername: entry.telegramUsername,
            }));
            const playerRegistrations = registrations.filter((entry) => String(entry.playerId || '') === String(playerId));
            const activeRegistration = findActiveRegistration(playerRegistrations, tournaments);
            if ((activeRegistration && Number(activeRegistration.weekId) !== weekId)
                || findActiveIdentityConflict(registrations, candidates, weekId, tournaments)) {
                throw Object.assign(new Error('You can only be registered in one tournament at a time. Your current tournament must conclude first.'), { code: 'RESUBMIT_CONFLICT' });
            }
            if (findRegistrationIdentityConflict(registrations, candidates, weekId, tournament)) {
                throw Object.assign(new Error('You are already registered for this active tournament.'), { code: 'RESUBMIT_CONFLICT' });
            }
            await claimPaymentReceipt(connection, receipt, registrationReceiptKey(target), playerId);

            tournament.availableSlots = Number(tournament.availableSlots) - entries.length;
            tournament.status = tournament.availableSlots === 0 ? 'full' : 'open';
            await WeeklyTournament.save(tournament, connection);
            if (target.paymentGroupId) {
                const [submission] = await connection.execute(
                    `UPDATE payment_submissions
                     SET receipt_data = ?, receipt_mime = ?, decision = 'pending',
                         rejection_reason = NULL, reviewed_at = NULL
                     WHERE group_id = ? AND decision = 'rejected'`,
                    [receipt.buffer, receipt.mime, target.paymentGroupId],
                );
                if (submission.affectedRows !== 1) {
                    throw Object.assign(new Error('This payment group is no longer eligible for resubmission.'), { code: 'RESUBMIT_CONFLICT' });
                }
            }
            for (const entry of entries) {
                entry.paymentStatus = 'pending';
                entry.payment = payment || entry.payment;
                entry.slotReserved = true;
                entry.rejectionReason = null;
                entry.rejectedAt = null;
                entry.approvedAt = null;
                entry.passToken = '';
                if (!target.paymentGroupId) entry.receiptData = receipt.data;
                await Registration.save(entry, connection);
            }
            return entries;
        });
        const warning = await tryCreatePlayerNotification(playerId, {
            type: 'registration',
            title: 'Payment resubmitted',
            message: 'Your corrected payment receipt has been sent for review.',
        });
        return {
            registrations: result.map((entry) => publicRegistration(entry, false)),
            ...(warning ? { notificationWarning: warning } : {}),
        };
    } finally {
        try {
            if (identityLockAcquired) await identityConnection.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
        } catch (error) {
            console.error('Registration identity lock release failed:', error?.message || error);
        } finally {
            identityConnection.release();
        }
    }
}

async function findTelegramPlayer(chatId) {
    if (!/^\d+$/.test(String(chatId || ''))) return null;
    const player = await Player.findOne({ telegramChatId: String(chatId) });
    return player ? publicPlayer(player) : null;
}

async function listTelegramPlayerRegistrations(chatId) {
    if (!/^\d+$/.test(String(chatId || ''))) return [];
    const player = await Player.findOne({ telegramChatId: String(chatId) });
    if (!player) return [];
    const registrations = await Registration.find({ playerId: player._id }).sort({ createdAt: -1 });
    const weekIds = [...new Set(registrations.map((entry) => Number(entry.weekId)))];
    const tournaments = await WeeklyTournament.find({ weekId: { $in: weekIds } }).select('weekId name dateRange');
    const tournamentByWeek = new Map(tournaments.map((tournament) => [Number(tournament.weekId), tournament]));
    return registrations.map((entry) => ({
        ...publicRegistration(entry, false),
        tournament: tournamentByWeek.get(Number(entry.weekId)) || null,
    }));
}

async function registerTelegramPlayer({ chatId, username = '', displayName, contact }) {
    const telegramChatId = String(chatId || '');
    const telegramUsername = normalizeTelegramUsername(username);
    if (!/^\d+$/.test(telegramChatId) || !isValidContact(contact)
        || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 60
        || (telegramUsername && !/^[a-z0-9_]{5,32}$/.test(telegramUsername))) {
        throw Object.assign(new Error('Share your own valid phone number and provide a valid Telegram profile.'), { code: 'TELEGRAM_PROFILE_INVALID' });
    }

    const connection = await getPool().getConnection();
    let identityLockAcquired = false;
    try {
        identityLockAcquired = await acquireRegistrationIdentityLock(connection);
        if (!identityLockAcquired) {
            throw Object.assign(new Error('Player identities are being updated. Please try again.'), { code: 'REGISTRATION_BUSY' });
        }
        let player = await Player.findOne({ telegramChatId });
        if (player && normalizeContact(player.contact) !== normalizeContact(contact)) {
            throw Object.assign(new Error('This Telegram account is already linked to a different phone number.'), { code: 'TELEGRAM_PROFILE_CONFLICT' });
        }
        if (!player) {
            player = await findPlayerByContact(contact, true);
            if (player?.telegramChatId && String(player.telegramChatId) !== telegramChatId) {
                throw Object.assign(new Error('This phone number is linked to another Telegram account.'), { code: 'TELEGRAM_PROFILE_CONFLICT' });
            }
        }
        if (telegramUsernameConflict(await Player.find({}), telegramUsername, player?._id)) {
            throw Object.assign(new Error('This Telegram username is already linked to another player profile.'), { code: 'TELEGRAM_PROFILE_CONFLICT' });
        }
        if (!player) {
            player = await ensurePlayer({ contact, displayName: displayName.trim(), telegramUsername });
        }
        player.telegramChatId = telegramChatId;
        player.telegramUsername = telegramUsername || player.telegramUsername || '';
        if (!player.displayName) player.displayName = displayName.trim();
        await player.save();
        await linkPlayerRegistrations(player);
        return publicPlayer(player);
    } finally {
        try {
            if (identityLockAcquired) await connection.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
        } finally {
            connection.release();
        }
    }
}

async function listTelegramTournaments() {
    const weeks = await ensureWeeks();
    return weeks.filter((week) => (
        ['open', 'full'].includes(week.status) && Number(week.availableSlots) > 0
    )).map((week) => ({
        weekId: Number(week.weekId),
        name: week.name || tournamentName(week.weekId),
        dateRange: week.dateRange || '',
        availableSlots: Number(week.availableSlots),
        entryFee: Number(week.entryFee || 0),
    }));
}

async function getTelegramPaymentAccounts() {
    await getPool().execute(
        `INSERT IGNORE INTO payment_accounts (account_type) VALUES ('cbe'), ('telebirr')`,
    );
    const [rows] = await getPool().execute(
        `SELECT account_type AS type, account_name AS name, account_number AS number
         FROM payment_accounts ORDER BY FIELD(account_type, 'cbe', 'telebirr')`,
    );
    return ['cbe', 'telebirr'].map((type) => (
        rows.find((row) => row.type === type) || { type, name: '', number: '' }
    ));
}

function createAdminRouter() {
    const router = express.Router();

    router.post('/admin/notifications', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { title, message } = req.body || {};
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 160
            || typeof message !== 'string' || !message.trim() || message.trim().length > 500) {
            return res.status(400).json({ error: 'Provide an announcement title and message within the allowed lengths.' });
        }
        try {
            const pool = getPool();
            const [result] = await pool.execute(
                `INSERT INTO notifications (player_id, type, title, message)
                 SELECT id, 'announcement', ?, ? FROM pgz_players`,
                [title.trim(), message.trim()],
            );
            return res.status(201).json({ created: result.affectedRows });
        } catch (error) {
            return sendDatabaseError(res, error, 'Announcement could not be published.');
        }
    });

    router.get('/admin/players', requireAdmin, async (req, res) => {
        try {
            const players = await Player.find({}).sort({ displayName: 1 }).limit(500);
            return res.json({
                players: players.map((player) => ({
                    id: String(player._id),
                    displayName: player.displayName,
                    contact: player.contact,
                    playerCode: player.playerCode || '',
                })),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Players could not be loaded.');
        }
    });

    router.post('/admin/notifications/direct', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { playerId, title, message } = req.body || {};
        if (!isValidObjectId(playerId)
            || typeof title !== 'string' || !title.trim() || title.trim().length > 160
            || typeof message !== 'string' || !message.trim() || message.trim().length > 500) {
            return res.status(400).json({ error: 'Choose a player and provide a title and message within the allowed lengths.' });
        }
        try {
            const player = await Player.findById(playerId);
            if (!player) return res.status(404).json({ error: 'Player account not found.' });
            await createPlayerNotification(player._id, {
                type: 'direct',
                title: title.trim(),
                message: message.trim(),
            });
            return res.status(201).json({
                created: 1,
                player: { id: String(player._id), displayName: player.displayName },
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Direct message could not be delivered.');
        }
    });

    router.post('/player/register', requireTrustedOrigin, async (req, res) => {
        const { displayName, contact, password, telegramUsername = '' } = req.body || {};
        const normalizedTelegramUsername = typeof telegramUsername === 'string'
            ? normalizeTelegramUsername(telegramUsername)
            : '';
        if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 60
            || typeof contact !== 'string' || !contact.trim() || contact.trim().length > 64
            || !isValidContact(contact)
            || typeof password !== 'string' || password.length < 8 || password.length > 128
            || typeof telegramUsername !== 'string'
            || (normalizedTelegramUsername && !/^[A-Za-z0-9_]{5,32}$/.test(normalizedTelegramUsername))) {
            return res.status(400).json({ error: 'Enter a player name, valid contact, and password of at least 8 characters.' });
        }
        let identityLockConnection = null;
        let identityLockAcquired = false;
        try {
            identityLockConnection = await getPool().getConnection();
            identityLockAcquired = await acquireRegistrationIdentityLock(identityLockConnection);
            if (!identityLockAcquired) {
                return res.status(503).json({ error: 'Player identity is being updated. Please try again shortly.' });
            }
            const contactKey = normalizeContact(contact);
            let player = await findPlayerByContact(contact, true);
            if (player?.passwordHash) {
                return res.status(409).json({ error: 'An account already exists for this contact. Please sign in.' });
            }
            if (telegramUsernameConflict(await Player.find({}), normalizedTelegramUsername, player?._id)) {
                return res.status(409).json({ error: 'This Telegram username is already linked to another player account.' });
            }
            if (!player) player = await ensurePlayer({ contact, displayName });
            await linkPlayerRegistrations(player);
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = crypto.scryptSync(password, salt, 64).toString('hex');
            player.displayName = displayName.trim();
            if (normalizedTelegramUsername) player.telegramUsername = normalizedTelegramUsername.toLowerCase();
            player.passwordHash = `${salt}:${hash}`;
            await player.save();
            await Registration.updateMany(
                { playerId: player._id },
                { $set: { playerName: player.displayName, psnId: player.psnId, avatar: player.avatar || '' } },
            );
            const token = crypto.randomBytes(32).toString('hex');
            playerSessions.set(token, { playerId: String(player._id), expiresAt: Date.now() + PLAYER_SESSION_LIFETIME_MS });
            setPlayerSession(res, token);
            return res.status(201).json({ player: publicPlayer(player), registrations: [] });
        } catch (error) {
            if (error.code === 'TELEGRAM_IDENTITY_CONFLICT') {
                return res.status(409).json({ error: error.message });
            }
            return sendDatabaseError(res, error, 'Player account could not be created.');
        } finally {
            if (identityLockConnection) {
                try {
                    if (identityLockAcquired) {
                        await identityLockConnection.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
                    }
                } catch (error) {
                    console.error('Registration identity lock release failed:', error?.message || error);
                } finally {
                    identityLockConnection.release();
                }
            }
        }
    });

    router.post('/player/login', requireTrustedOrigin, async (req, res) => {
        const { contact, password } = req.body || {};
        if (typeof contact !== 'string' || !contact.trim() || typeof password !== 'string' || !password) {
            return res.status(400).json({ error: 'Enter your contact and password.' });
        }
        if (!isValidContact(contact)) {
            return res.status(400).json({ error: 'Enter a valid player phone number and password.' });
        }
        const attemptKey = `${req.ip}:${normalizeContact(contact)}`;
        const attempt = playerLoginAttempts.get(attemptKey);
        if (attempt && attempt.blockedUntil > Date.now()) {
            return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
        }
        try {
            const player = await findPlayerByContact(contact, true);
            const [salt, storedHash] = (player?.passwordHash || '').split(':');
            if (player && (!salt || !storedHash)) {
                return res.status(409).json({
                    error: 'Your player profile does not have a web password yet. Choose Create player account to finish setting one up.',
                });
            }
            const actualHash = player && salt && storedHash
                ? crypto.scryptSync(password, salt, 64).toString('hex')
                : '';
            if (!player || !storedHash || !safeEqual(actualHash, storedHash)) {
                const failures = (attempt?.failures || 0) + 1;
                playerLoginAttempts.set(attemptKey, {
                    failures,
                    blockedUntil: failures >= 5 ? Date.now() + 10 * 60 * 1000 : 0,
                });
                return res.status(401).json({ error: 'Invalid player contact or password.' });
            }
            playerLoginAttempts.delete(attemptKey);
            await linkPlayerRegistrations(player);
            const token = crypto.randomBytes(32).toString('hex');
            playerSessions.set(token, { playerId: String(player._id), expiresAt: Date.now() + PLAYER_SESSION_LIFETIME_MS });
            setPlayerSession(res, token);
            return res.json({ player: publicPlayer(player) });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player sign-in could not be completed.');
        }
    });

    router.get('/player/session', async (req, res) => {
        res.set('Cache-Control', 'no-store, private');
        const token = parseCookies(req.headers.cookie).prime_player_session;
        const session = token && playerSessions.get(token);
        if (!session || session.expiresAt <= Date.now()) {
            if (token) playerSessions.delete(token);
            return res.json({ authenticated: false });
        }
        req.playerId = session.playerId;
        session.expiresAt = Date.now() + PLAYER_SESSION_LIFETIME_MS;
        try {
            const player = await Player.findById(req.playerId);
            if (!player) {
                playerSessions.delete(token);
                return res.json({ authenticated: false });
            }
            const registrations = await Registration.find({ playerId: player._id }).sort({ createdAt: -1 }).lean();
            for (const [index, registration] of registrations.entries()) {
                if (registration.paymentStatus !== 'approved' || registration.passToken) continue;
                const passToken = crypto.randomBytes(32).toString('hex');
                const issuedRegistration = await Registration.findOneAndUpdate(
                    {
                        _id: registration._id,
                        paymentStatus: 'approved',
                        $or: [
                            { passToken: { $exists: false } },
                            { passToken: '' },
                            { passToken: null },
                        ],
                    },
                    {
                        $set: {
                            passToken,
                            checkInStatus: registration.checkInStatus || 'not_checked_in',
                            readyStatus: registration.readyStatus || 'not_ready',
                        },
                    },
                    { new: true },
                );
                if (issuedRegistration) {
                    registrations[index] = issuedRegistration.toObject();
                    await sendPassTelegram(player, issuedRegistration);
                } else {
                    const latestRegistration = await Registration.findById(registration._id).lean();
                    if (latestRegistration) registrations[index] = latestRegistration;
                }
            }
            const weeks = await WeeklyTournament.find({
                weekId: { $in: [...new Set(registrations.map((item) => item.weekId))] },
            }).select('weekId name dateRange status matches').lean();
            const tournamentByWeek = new Map(weeks.map((week) => [Number(week.weekId), week]));
            const activeRegistration = findActiveRegistration(registrations, weeks);
            return res.json({
                authenticated: true,
                player: publicPlayer(player),
                activeRegistration: activeRegistration ? {
                    ...publicRegistration(activeRegistration, false),
                    tournament: tournamentByWeek.get(Number(activeRegistration.weekId)) || null,
                } : null,
                registrations: registrations.map((registration) => ({
                    ...publicRegistration(registration, false),
                    tournament: tournamentByWeek.get(Number(registration.weekId)) || null,
                })),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player profile could not be loaded.');
        }
    });

    router.get('/player/registrations/:id/pass', requirePlayer, async (req, res) => {
        try {
            const registration = await Registration.findById(req.params.id);
            if (!registration || String(registration.playerId) !== String(req.playerId)
                || registration.paymentStatus !== 'approved' || !registration.passToken) {
                return res.status(404).json({ error: 'An approved digital pass was not found.' });
            }
            const image = await QRCode.toBuffer(`PGZ-PASS:${registration.passToken}`, {
                type: 'png',
                width: 420,
                margin: 2,
                errorCorrectionLevel: 'M',
            });
            res.set('Cache-Control', 'no-store, private');
            return res.type('png').send(image);
        } catch (error) {
            return sendDatabaseError(res, error, 'Digital pass could not be loaded.');
        }
    });

    router.get('/player/registrations/:id/pass-code', requirePlayer, async (req, res) => {
        try {
            const registration = await Registration.findById(req.params.id);
            if (!registration || String(registration.playerId) !== String(req.playerId)
                || registration.paymentStatus !== 'approved' || !registration.passToken) {
                return res.status(404).json({ error: 'An approved digital pass was not found.' });
            }
            res.set('Cache-Control', 'no-store, private');
            return res.json({ passCode: `PGZ-PASS:${registration.passToken}` });
        } catch (error) {
            return sendDatabaseError(res, error, 'Digital pass code could not be loaded.');
        }
    });

    router.post('/player/registrations/:id/resubmit', requireTrustedOrigin, requirePlayer, async (req, res) => {
        try {
            return res.json(await resubmitPlayerPayment({
                playerId: req.playerId,
                registrationId: req.params.id,
                receiptData: req.body?.receiptData,
                payment: req.body?.payment,
            }));
        } catch (error) {
            if (error.code === 'RESUBMIT_INPUT_INVALID') return res.status(400).json({ error: error.message });
            if (error.code === 'RESUBMIT_NOT_FOUND') return res.status(404).json({ error: error.message });
            if (error.code === 'RESUBMIT_CONFLICT') return res.status(409).json({ error: error.message });
            if (error.code === 'RECEIPT_ALREADY_USED') return res.status(409).json({ error: error.message });
            if (error.code === 'REGISTRATION_BUSY') return res.status(503).json({ error: error.message });
            return sendDatabaseError(res, error, 'Payment could not be resubmitted.');
        }
    });

    router.get('/player/chat/background', requirePlayer, async (req, res) => {
        try {
            const [rows] = await getPool().execute(
                `SELECT image_data AS imageData, image_mime AS imageMime
                 FROM chat_backgrounds WHERE owner_type = 'player' AND owner_id = ?`,
                [req.playerId],
            );
            res.set('Cache-Control', 'no-store, private');
            return res.json({
                imageData: rows[0]
                    ? `data:${rows[0].imageMime};base64,${Buffer.from(rows[0].imageData).toString('base64')}`
                    : null,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat background could not be loaded.');
        }
    });

    router.put('/player/chat/background', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const background = parseChatBackground(req.body);
        if (background.error) return res.status(400).json({ error: background.error });
        try {
            await getPool().execute(
                `INSERT INTO chat_backgrounds (owner_type, owner_id, image_data, image_mime)
                 VALUES ('player', ?, ?, ?)
                 ON DUPLICATE KEY UPDATE image_data = VALUES(image_data), image_mime = VALUES(image_mime)`,
                [req.playerId, background.data, background.mime],
            );
            return res.json({ saved: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat background could not be saved.');
        }
    });

    router.delete('/player/chat/background', requireTrustedOrigin, requirePlayer, async (req, res) => {
        try {
            await getPool().execute(
                "DELETE FROM chat_backgrounds WHERE owner_type = 'player' AND owner_id = ?",
                [req.playerId],
            );
            return res.json({ removed: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat background could not be removed.');
        }
    });

    router.get('/player/chat', requirePlayer, async (req, res) => {
        try {
            const chatId = await chatIdForPlayer(req.playerId);
            const pool = getPool();
            await pool.execute(
                `INSERT INTO chat_presence (chat_id, player_online_until)
                 VALUES (?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND))
                 ON DUPLICATE KEY UPDATE player_online_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND)`,
                [chatId],
            );
            await pool.execute(
                "UPDATE chat_messages SET read_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND sender = 'admin' AND read_at IS NULL",
                [chatId],
            );
            const allMessages = await loadChatMessages(pool, chatId, { actor: 'player', id: req.playerId, admin: false, playerId: req.playerId });
            const [status] = await pool.execute(
                `SELECT c.blocked_at AS blockedAt, p.admin_typing_until > CURRENT_TIMESTAMP AS adminTyping,
                        p.admin_online_until > CURRENT_TIMESTAMP AS adminOnline
                 FROM player_chats c LEFT JOIN chat_presence p ON p.chat_id = c.id
                 WHERE c.id = ?`,
                [chatId],
            );
            return res.json({
                messages: allMessages,
                unreadCount: 0,
                blocked: Boolean(status[0]?.blockedAt),
                adminTyping: Boolean(status[0]?.adminTyping),
                adminOnline: Boolean(status[0]?.adminOnline),
                pinned: allMessages.find((message) => message.isPinned) || null,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Support messages could not be loaded.');
        }
    });

    router.get('/player/chat/status', requirePlayer, async (req, res) => {
        try {
            const pool = getPool();
            const chatId = await chatIdForPlayer(req.playerId);
            await pool.execute(
                `INSERT INTO chat_presence (chat_id, player_online_until)
                 VALUES (?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND))
                 ON DUPLICATE KEY UPDATE player_online_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND)`,
                [chatId],
            );
            const [rows] = await pool.execute(
                `SELECT c.blocked_at AS blockedAt,
                        p.admin_typing_until > CURRENT_TIMESTAMP AS adminTyping,
                        p.admin_online_until > CURRENT_TIMESTAMP AS adminOnline,
                        (SELECT COUNT(*) FROM chat_messages m
                         WHERE m.chat_id = c.id AND m.sender = 'admin' AND m.read_at IS NULL AND m.deleted_at IS NULL) AS unreadCount,
                        (SELECT id FROM chat_messages m WHERE m.chat_id = c.id AND m.is_pinned = TRUE AND m.deleted_at IS NULL LIMIT 1) AS pinnedMessageId
                 FROM player_chats c LEFT JOIN chat_presence p ON p.chat_id = c.id
                 WHERE c.id = ?`,
                [chatId],
            );
            return res.json({
                unreadCount: Number(rows[0]?.unreadCount || 0),
                blocked: Boolean(rows[0]?.blockedAt),
                adminTyping: Boolean(rows[0]?.adminTyping),
                adminOnline: Boolean(rows[0]?.adminOnline),
                pinnedMessageId: rows[0]?.pinnedMessageId || null,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat status could not be loaded.');
        }
    });

    router.post('/player/chat', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const input = parseChatMessageInput(req.body);
        if (input.error) return res.status(400).json({ error: input.error });
        try {
            const chatId = await chatIdForPlayer(req.playerId);
            const pool = getPool();
            const [chatRows] = await pool.execute(
                'SELECT blocked_at AS blockedAt FROM player_chats WHERE id = ?',
                [chatId],
            );
            if (chatRows[0]?.blockedAt) return res.status(403).json({ error: 'This support conversation is restricted. Contact the organizer through the contact center.' });
            const messageId = await insertChatMessage(pool, { chatId, sender: 'player', ...input });
            return res.status(201).json({
                message: {
                    id: messageId,
                    sender: 'player',
                    body: input.body,
                    messageType: input.attachment?.type || 'text',
                    attachmentMime: input.attachment?.mime || null,
                    attachmentName: input.attachment?.name || null,
                    attachmentUrl: input.attachment
                        ? `/api/player/chat/messages/${messageId}/attachment`
                        : null,
                    isPinned: false,
                    editedAt: null,
                    deletedAt: null,
                    readAt: null,
                    reactions: [],
                    createdAt: new Date().toISOString(),
                },
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Your message could not be sent.');
        }
    });

    router.post('/player/chat/typing', requireTrustedOrigin, requirePlayer, async (req, res) => {
        if (typeof req.body?.typing !== 'boolean') return res.status(400).json({ error: 'Provide a valid typing state.' });
        try {
            const chatId = await chatIdForPlayer(req.playerId);
            await setChatTyping(getPool(), chatId, 'player', req.body.typing);
            return res.json({ updated: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Typing status could not be updated.');
        }
    });

    router.patch('/player/chat/messages/:messageId', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const body = req.body?.body;
        if (!/^\d+$/.test(req.params.messageId) || typeof body !== 'string' || !body.trim() || body.trim().length > 2000) {
            return res.status(400).json({ error: 'Enter a message of 1 to 2,000 characters.' });
        }
        try {
            const pool = getPool();
            const chatId = await chatIdForPlayer(req.playerId);
            const [result] = await pool.execute(
                `UPDATE chat_messages SET body = ?, edited_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND chat_id = ? AND sender = 'player' AND deleted_at IS NULL`,
                [body.trim(), req.params.messageId, chatId],
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Your message could not be found or edited.' });
            return res.json({ updated: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Message could not be edited.');
        }
    });

    router.delete('/player/chat/messages/:messageId', requireTrustedOrigin, requirePlayer, async (req, res) => {
        if (!/^\d+$/.test(req.params.messageId)) return res.status(400).json({ error: 'Choose a valid message.' });
        try {
            const [result] = await getPool().execute(
                `UPDATE chat_messages SET body = NULL, attachment_data = NULL, attachment_mime = NULL,
                        attachment_name = NULL, deleted_at = CURRENT_TIMESTAMP, is_pinned = FALSE
                 WHERE id = ? AND chat_id = ? AND sender = 'player' AND deleted_at IS NULL`,
                [req.params.messageId, await chatIdForPlayer(req.playerId)],
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Your message could not be found or deleted.' });
            return res.json({ deleted: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Message could not be deleted.');
        }
    });

    router.put('/player/chat/messages/:messageId/pin', requireTrustedOrigin, requirePlayer, async (req, res) => {
        if (!/^\d+$/.test(req.params.messageId)) return res.status(400).json({ error: 'Choose a valid message.' });
        try {
            const pool = getPool();
            const chatId = await chatIdForPlayer(req.playerId);
            const pinned = await pinChatMessage(pool, chatId, req.params.messageId);
            if (pinned === null) return res.status(404).json({ error: 'Message could not be pinned.' });
            return res.json({ pinnedMessageId: pinned ? Number(req.params.messageId) : null });
        } catch (error) {
            return sendDatabaseError(res, error, 'Message could not be pinned.');
        }
    });

    router.post('/player/chat/messages/:messageId/reactions', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const { emoji } = req.body || {};
        if (!/^\d+$/.test(req.params.messageId) || !CHAT_REACTIONS.includes(emoji)) {
            return res.status(400).json({ error: 'Choose a supported reaction.' });
        }
        try {
            const pool = getPool();
            const chatId = await chatIdForPlayer(req.playerId);
            const [rows] = await pool.execute(
                'SELECT id FROM chat_messages WHERE id = ? AND chat_id = ? AND deleted_at IS NULL',
                [req.params.messageId, chatId],
            );
            if (!rows.length) return res.status(404).json({ error: 'Message not found.' });
            const reacted = await toggleChatReaction(pool, req.params.messageId, 'player', req.playerId, emoji);
            return res.json({ reacted });
        } catch (error) {
            return sendDatabaseError(res, error, 'Reaction could not be saved.');
        }
    });

    router.get('/player/chat/messages/:messageId/attachment', requirePlayer, async (req, res) => {
        if (!/^\d+$/.test(req.params.messageId)) return res.status(400).json({ error: 'Choose a valid message.' });
        try {
            return await sendChatAttachment(res, getPool(), await chatIdForPlayer(req.playerId), req.params.messageId);
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat attachment could not be loaded.');
        }
    });

    router.post('/player/chat/report', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const reason = req.body?.reason;
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) {
            return res.status(400).json({ error: 'Describe the issue in 1 to 1,000 characters.' });
        }
        try {
            const chatId = await chatIdForPlayer(req.playerId);
            await getPool().execute(
                'UPDATE player_chats SET reported_at = CURRENT_TIMESTAMP, report_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [reason.trim(), chatId],
            );
            return res.json({ reported: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Your report could not be sent.');
        }
    });

    router.get('/player/disputes', requirePlayer, async (req, res) => {
        try {
            const [disputes] = await getPool().execute(
                `SELECT id, week_id AS weekId, match_id AS matchId, details, status,
                        admin_note AS adminNote, created_at AS createdAt, resolved_at AS resolvedAt,
                        proof_mime AS proofMime
                 FROM match_disputes WHERE player_id = ? ORDER BY id DESC LIMIT 50`,
                [req.playerId],
            );
            return res.json({ disputes });
        } catch (error) {
            return sendDatabaseError(res, error, 'Your match disputes could not be loaded.');
        }
    });

    router.post('/player/disputes', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const { weekId, matchId, details, proofData = '' } = req.body || {};
        const parsedWeekId = Number(weekId);
        if (!Number.isInteger(parsedWeekId) || parsedWeekId < 0
            || typeof matchId !== 'string' || !/^r\d+m\d+$/.test(matchId)
            || typeof details !== 'string' || !details.trim() || details.trim().length > 2000
            || (proofData && (typeof proofData !== 'string'
                || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(proofData)
                || proofData.length > 7_000_000))) {
            return res.status(400).json({ error: 'Provide a valid match, details, and optional PNG, JPG, or WebP proof up to 5 MB.' });
        }
        try {
            const registration = await Registration.findOne({
                playerId: req.playerId,
                weekId: parsedWeekId,
                paymentStatus: 'approved',
            });
            const tournament = await WeeklyTournament.findOne({ weekId: parsedWeekId });
            const match = tournament?.matches.find((item) => item.matchId === matchId);
            if (!registration || !match
                || ![match.player1Id, match.player2Id].some((id) => String(id) === String(registration._id))) {
                return res.status(404).json({ error: 'That match is not part of your approved tournament entry.' });
            }
            const proofMime = proofData ? proofData.match(/^data:(image\/(?:png|jpeg|webp));base64,/)[1] : null;
            const proofBuffer = proofData ? Buffer.from(proofData.split(',')[1], 'base64') : null;
            if (proofBuffer?.length > 5 * 1024 * 1024) {
                return res.status(400).json({ error: 'Proof image must be 5 MB or smaller.' });
            }
            const [result] = await getPool().execute(
                `INSERT INTO match_disputes
                    (player_id, week_id, match_id, details, proof_data, proof_mime)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [req.playerId, parsedWeekId, matchId, details.trim(), proofBuffer, proofMime],
            );
            return res.status(201).json({
                dispute: {
                    id: result.insertId,
                    weekId: parsedWeekId,
                    matchId,
                    details: details.trim(),
                    status: 'open',
                    proofMime,
                },
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Your match dispute could not be submitted.');
        }
    });

    router.get('/player/notifications', requirePlayer, async (req, res) => {
        try {
            const pool = getPool();
            const [rows] = await pool.execute(
                `SELECT id, type, title, message, is_read AS isRead, created_at AS createdAt
                 FROM notifications
                 WHERE player_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 30`,
                [req.playerId],
            );
            const unreadCount = await getUnreadNotificationCount(req.playerId);
            return res.json({
                notifications: rows.map((notification) => ({
                    ...notification,
                    isRead: Boolean(notification.isRead),
                })),
                unreadCount,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Notifications could not be loaded.');
        }
    });

    router.patch('/player/notifications/read-all', requireTrustedOrigin, requirePlayer, async (req, res) => {
        try {
            const pool = getPool();
            await pool.execute(
                'UPDATE notifications SET is_read = TRUE WHERE player_id = ? AND is_read = FALSE',
                [req.playerId],
            );
            return res.json({ unreadCount: 0 });
        } catch (error) {
            return sendDatabaseError(res, error, 'Notifications could not be marked as read.');
        }
    });

    router.patch('/player/notifications/:id/read', requireTrustedOrigin, requirePlayer, async (req, res) => {
        if (!/^\d+$/.test(req.params.id)) {
            return res.status(400).json({ error: 'Provide a valid notification.' });
        }
        try {
            const pool = getPool();
            await pool.execute(
                'UPDATE notifications SET is_read = TRUE WHERE id = ? AND player_id = ?',
                [req.params.id, req.playerId],
            );
            const unreadCount = await getUnreadNotificationCount(req.playerId);
            return res.json({ unreadCount });
        } catch (error) {
            return sendDatabaseError(res, error, 'Notification could not be marked as read.');
        }
    });

    router.patch('/player/profile', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const { displayName, psnId = '', avatar = '' } = req.body || {};
        if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 60
            || typeof psnId !== 'string' || psnId.trim().length > 64
            || typeof avatar !== 'string' || (avatar && (
                !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)
                || avatar.length > 700_000
            ))) {
            return res.status(400).json({ error: 'Provide a valid player name, PSN ID, and PNG, JPG, or WebP avatar up to 512 KB.' });
        }
        try {
            const player = await Player.findByIdAndUpdate(
                req.playerId,
                { $set: { displayName: displayName.trim(), psnId: psnId.trim(), avatar } },
                { new: true, runValidators: true },
            );
            if (!player) return res.status(401).json({ error: 'Player account was not found.' });
            await Registration.updateMany(
                { playerId: player._id },
                { $set: { playerName: player.displayName, psnId: player.psnId, avatar: player.avatar } },
            );
            return res.json({ player: publicPlayer(player) });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player profile could not be updated.');
        }
    });

    router.delete('/player/session', requireTrustedOrigin, requirePlayer, (req, res) => {
        const token = parseCookies(req.headers.cookie).prime_player_session;
        playerSessions.delete(token);
        res.set('Set-Cookie', 'prime_player_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0');
        return res.json({ authenticated: false });
    });

    router.delete('/player/account', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const { password } = req.body || {};
        if (typeof password !== 'string' || !password) {
            return res.status(400).json({ error: 'Enter your password to delete this account.' });
        }
        try {
            const player = await Player.findById(req.playerId).select('+passwordHash');
            const [salt, storedHash] = (player?.passwordHash || '').split(':');
            const actualHash = player && salt && storedHash
                ? crypto.scryptSync(password, salt, 64).toString('hex')
                : '';
            if (!player || !storedHash || !safeEqual(actualHash, storedHash)) {
                return res.status(401).json({ error: 'The password is incorrect.' });
            }
            const registrations = await Registration.find({ playerId: player._id }).select('_id weekId paymentStatus');
            const weekIds = [...new Set(registrations.map((item) => item.weekId))];
            const tournaments = await WeeklyTournament.find({ weekId: { $in: weekIds } });
            for (const tournament of tournaments) {
                const tournamentRegistrationIds = registrations
                    .filter((item) => item.weekId === tournament.weekId)
                    .map((item) => String(item._id));
                const affectedMatches = tournament.matches.filter((match) => (
                    tournamentRegistrationIds.includes(String(match.player1Id || ''))
                    || tournamentRegistrationIds.includes(String(match.player2Id || ''))
                ));
                if (affectedMatches.some((match) => (
                    match.status === 'ongoing'
                    || (match.status === 'finished' && match.player1Id && match.player2Id)
                ))) {
                    return res.status(409).json({ error: 'This account has played tournament matches. Contact the organizer to remove it safely.' });
                }
            }
            await Registration.deleteMany({ playerId: player._id });
            for (const tournament of tournaments) {
                const weekRegistrations = registrations.filter((item) => item.weekId === tournament.weekId);
                const reservedCount = weekRegistrations.filter((item) => (
                    item.paymentStatus === 'pending' || item.paymentStatus === 'approved'
                )).length;
                tournament.availableSlots = Math.min(tournament.capacity, tournament.availableSlots + reservedCount);
                if (tournament.status === 'full' && tournament.availableSlots > 0) tournament.status = 'open';
                if (weekRegistrations.length && tournament.matches.length) tournament.matches = [];
                await tournament.save();
            }
            await getPool().execute(
                "DELETE FROM chat_backgrounds WHERE owner_type = 'player' AND owner_id = ?",
                [String(player._id)],
            );
            await player.deleteOne();
            const token = parseCookies(req.headers.cookie).prime_player_session;
            playerSessions.delete(token);
            res.set('Set-Cookie', 'prime_player_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0');
            return res.json({ deleted: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player account could not be deleted.');
        }
    });

    router.get('/tournaments/weeks', async (req, res) => {
        try {
            const weeks = await ensureWeeks();
            return res.json({
                weeks: weeks.map((week) => {
                    const tournament = week.toObject();
                    delete tournament.matches;
                    return tournament;
                }),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament weeks could not be loaded.');
        }
    });

    router.post('/registrations', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const { payment, weekId, receiptData, sessionPreference = 'any' } = req.body || {};
        const parsedWeekId = Number(weekId);
        if (!['any', 'morning', 'afternoon', 'evening'].includes(sessionPreference)
            || !PAYMENT_METHODS.includes(payment)
            || !Number.isInteger(parsedWeekId) || parsedWeekId < 0) {
            return res.status(400).json({ error: 'Enter valid payment, tournament, and session details.' });
        }
        try {
            const result = await registerPlayerForTournament({
                playerId: req.playerId,
                weekId: parsedWeekId,
                payment,
                receiptData,
                sessionPreference,
            });
            return res.status(201).json({
                ...result,
                message: 'Registration request saved. Payment approval is pending.',
            });
        } catch (error) {
            if (error.code === 'REGISTRATION_INPUT_INVALID' || error.code === 'REGISTRATION_RECEIPT_INVALID') {
                return res.status(400).json({ error: error.message });
            }
            if (error.code === 'PLAYER_NOT_FOUND') return res.status(401).json({ error: 'Player account was not found. Please sign in again.' });
            if (error.code === 'REGISTRATION_BUSY') return res.status(503).json({ error: error.message });
            if (error.code === 'REGISTRATION_CLOSED') return res.status(409).json({ error: error.message });
            if (error.code === 'REGISTRATION_DUPLICATE') return res.status(409).json({ error: error.message });
            if (error.code === 'RECEIPT_ALREADY_USED') return res.status(409).json({ error: error.message });
            if (error.code === 'ACTIVE_TOURNAMENT_CONFLICT') {
                return res.status(409).json({ error: error.message, activeWeekId: error.activeWeekId });
            }
            return sendDatabaseError(res, error, 'Registration could not be saved. Please try again.');
        }
    });

    router.get('/payment-accounts', async (req, res) => {
        try {
            res.set('Cache-Control', 'no-store');
            await getPool().execute(
                `INSERT IGNORE INTO payment_accounts (account_type) VALUES ('cbe'), ('telebirr')`,
            );
            const [rows] = await getPool().execute(
                `SELECT account_type AS type, account_name AS name, account_number AS number
                 FROM payment_accounts ORDER BY FIELD(account_type, 'cbe', 'telebirr')`,
            );
            return res.json({
                accounts: ['cbe', 'telebirr'].map((type) => (
                    rows.find((row) => row.type === type) || { type, name: '', number: '' }
                )),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Payment account details could not be loaded.');
        }
    });

    router.post('/registrations/group', requireTrustedOrigin, requirePlayer, async (req, res) => {
        const { payment, weekId, receiptData, participants, registeredForOthers = false } = req.body || {};
        const requestedGroupId = req.get('Idempotency-Key') || '';
        const parsedWeekId = Number(weekId);
        const validParticipant = (participant) => participant
            && typeof participant.playerName === 'string'
            && participant.playerName.trim().length > 0
            && participant.playerName.trim().length <= 60
            && (participant.contact === undefined
                || (typeof participant.contact === 'string' && participant.contact.trim().length <= 64
                    && isValidContact(participant.contact)))
            && ['any', 'morning', 'afternoon', 'evening'].includes(participant.sessionPreference || 'any');
        if (!PAYMENT_METHODS.includes(payment) || !Number.isInteger(parsedWeekId) || parsedWeekId < 0
            || !Array.isArray(participants) || participants.length < 1 || participants.length > CAPACITY
            || typeof registeredForOthers !== 'boolean'
            || !participants.every(validParticipant)
            || (registeredForOthers && participants.some((participant) => (
                typeof participant.contact !== 'string' || !participant.contact.trim()
            )))) {
            return res.status(400).json({ error: 'Provide valid participants, payment method, and tournament.' });
        }
        const invalidParticipant = participants.find((participant) => parseTelegramUsername(participant.telegramUsername).error);
        if (invalidParticipant) {
            return res.status(400).json({ error: parseTelegramUsername(invalidParticipant.telegramUsername).error });
        }
        const receipt = parseRegistrationReceipt(receiptData);
        if (receipt.error) return res.status(400).json({ error: receipt.error });
        if (requestedGroupId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedGroupId)) {
            return res.status(400).json({ error: 'Registration retry key is invalid. Please submit again.' });
        }

        let lockConnection = null;
        let lockName = '';
        let identityLockAcquired = false;
        try {
            await ensureWeeks();
            const player = await Player.findById(req.playerId);
            if (!player) return res.status(401).json({ error: 'Player account was not found.' });
            lockConnection = await getPool().getConnection();
            lockName = `pgz_active_${String(player._id)}`;
            const [lockRows] = await lockConnection.execute('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
            if (Number(lockRows[0]?.acquired) !== 1) {
                return res.status(503).json({ error: 'Registration is busy for this account. Please try again.' });
            }
            identityLockAcquired = await acquireRegistrationIdentityLock(lockConnection);
            if (!identityLockAcquired) {
                return res.status(503).json({ error: 'Registration is busy. Please try again shortly.' });
            }
            const groupId = requestedGroupId || crypto.randomUUID();
            const existingEntries = await Registration.find({ paymentGroupId: groupId }).sort({ createdAt: 1 });
            if (existingEntries.length) {
                if (existingEntries.some((entry) => String(entry.playerId) !== String(player._id))) {
                    return res.status(409).json({ error: 'This registration retry key has already been used.' });
                }
                const week = await WeeklyTournament.findOne({ weekId: parsedWeekId });
                if (existingEntries.some((entry) => Number(entry.weekId) !== parsedWeekId)) {
                    return res.status(409).json({ error: 'This registration retry key belongs to a different tournament.' });
                }
                return res.status(201).json({
                    groupId,
                    registrations: existingEntries.map((entry) => publicRegistration(entry)),
                    totalEntryFee: existingEntries.length * Number(week?.entryFee || 0),
                    message: 'Group registration saved. Payment approval is pending.',
                });
            }
            const checkout = await Registration.withTransaction(async (connection) => {
                const registrations = await Registration.findRows(connection, true);
                const tournaments = await WeeklyTournament.findRows(connection, true);
                const week = tournaments.find((item) => Number(item.weekId) === parsedWeekId);
                if (!week || !['open', 'full'].includes(week.status)
                    || Number(week.availableSlots) < participants.length) {
                    throw Object.assign(new Error('This tournament does not have enough open slots for the full group.'), { code: 'GROUP_REGISTRATION_CLOSED' });
                }

                const playerRegistrations = registrations.filter((registration) => (
                    String(registration.playerId || '') === String(player._id)
                ));
                const activeRegistration = registeredForOthers === true
                    ? null
                    : findActiveRegistration(playerRegistrations, tournaments);
                if (activeRegistration && Number(activeRegistration.weekId) !== parsedWeekId) {
                    throw Object.assign(new Error('You can only be registered in one tournament at a time. Your current tournament must conclude first.'), {
                        code: 'ACTIVE_TOURNAMENT_CONFLICT',
                        activeWeekId: Number(activeRegistration.weekId),
                    });
                }
                const candidates = participants.map((participant, index) => ({
                    playerId: player._id,
                    ownsAccount: registeredForOthers !== true && index === 0,
                    playerName: participant.playerName.trim(),
                    contact: participant.contact?.trim() || player.contact,
                    telegramUsername: parseTelegramUsername(participant.telegramUsername).username,
                }));
                const activeIdentityWeekId = findActiveIdentityConflict(
                    registrations,
                    candidates,
                    parsedWeekId,
                    tournaments,
                );
                if (activeIdentityWeekId !== null) {
                    throw Object.assign(new Error('You can only be registered in one tournament at a time. Your current tournament must conclude first.'), {
                        code: 'ACTIVE_TOURNAMENT_CONFLICT',
                        activeWeekId: activeIdentityWeekId,
                    });
                }
                if (findRegistrationIdentityConflict(registrations, candidates, parsedWeekId, week)) {
                    throw Object.assign(new Error('You are already registered for this active tournament.'), { code: 'REGISTRATION_DUPLICATE' });
                }

                week.availableSlots -= participants.length;
                week.status = week.availableSlots === 0 ? 'full' : 'open';
                await WeeklyTournament.save(week, connection);
                await claimPaymentReceipt(connection, receipt, groupId, player._id);
                await connection.execute(
                    `INSERT INTO payment_submissions (group_id, receipt_data, receipt_mime)
                     VALUES (?, ?, ?)`,
                    [groupId, receipt.buffer, receipt.mime],
                );
                const entries = await Registration.insertMany(participants.map((participant) => ({
                    playerName: participant.playerName.trim(),
                    contact: participant.contact?.trim() || player.contact,
                    telegramUsername: parseTelegramUsername(participant.telegramUsername).username,
                    playerId: player._id,
                    playerCode: player.playerCode,
                    avatar: player.avatar,
                    slotReserved: true,
                    confirmationCode: `PG-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
                    weekId: parsedWeekId,
                    payment,
                    paymentGroupId: groupId,
                    registeredForOthers: registeredForOthers === true,
                    sessionPreference: participant.sessionPreference || 'any',
                    paymentStatus: 'pending',
                    receiptData: '',
                    passToken: '',
                    checkInStatus: 'not_checked_in',
                    readyStatus: 'not_ready',
                })), { connection });
                return { week, entries };
            });
            const registrations = checkout.entries.map((entry) => publicRegistration(entry));
            const notificationWarning = await tryCreatePlayerNotification(player._id, {
                type: 'registration',
                title: 'Registration received',
                message: `${registrations.length} entries for ${checkout.week.name || tournamentName(parsedWeekId)} are pending payment approval.`,
            });
            return res.status(201).json({
                groupId,
                registrations,
                totalEntryFee: registrations.length * Number(checkout.week.entryFee || 0),
                message: 'Group registration saved. Payment approval is pending.',
                ...(notificationWarning ? { notificationWarning } : {}),
            });
        } catch (error) {
            if (error.code === 'GROUP_REGISTRATION_CLOSED') return res.status(409).json({ error: error.message });
            if (error.code === 'REGISTRATION_DUPLICATE') return res.status(409).json({ error: error.message });
            if (error.code === 'RECEIPT_ALREADY_USED') return res.status(409).json({ error: error.message });
            if (error.code === 'ACTIVE_TOURNAMENT_CONFLICT') {
                return res.status(409).json({ error: error.message, activeWeekId: error.activeWeekId });
            }
            return sendDatabaseError(res, error, 'Group registration could not be saved. Please try again.');
        } finally {
            if (lockConnection) {
                try {
                    if (identityLockAcquired) {
                        await lockConnection.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
                    }
                    if (lockName) await lockConnection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
                } catch (error) {
                    console.error('Registration lock release failed:', error?.message || error);
                } finally {
                    lockConnection.release();
                }
            }
        }
    });

    router.get('/tournaments/:weekId/fixtures', async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0) {
            return res.status(400).json({ error: 'Invalid tournament.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId }).lean();
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const players = await Registration.find({ weekId, paymentStatus: 'approved' });
            for (const registration of players) await attachPlayerToRegistration(registration);
            const matches = publicMatches(tournament.matches || [], players).map((match) => ({
                ...match,
                player1: publicBracketPlayer(match.player1),
                player2: publicBracketPlayer(match.player2),
            }));
            return res.json({
                tournament: {
                    weekId: tournament.weekId,
                    name: tournamentName(tournament.weekId),
                    capacity: tournament.capacity,
                    entryFee: tournament.entryFee,
                    prizePool: tournament.prizePool ?? 20000,
                    status: tournament.status,
                },
                matches,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament bracket could not be loaded.');
        }
    });

    router.get('/leaderboard', async (req, res) => {
        try {
            const tournaments = await WeeklyTournament.find({});
            const leaderboard = new Map();
            for (const tournament of tournaments) {
                const registrations = await Registration.find({
                    weekId: tournament.weekId,
                    paymentStatus: 'approved',
                });
                const registrationsById = new Map();
                for (const registration of registrations) {
                    if (!registration.playerId) continue;
                    const key = String(registration.playerId);
                    registrationsById.set(String(registration._id), registration);
                    if (!leaderboard.has(key)) {
                        leaderboard.set(key, {
                            playerId: key,
                            playerName: registration.playerName,
                            playerCode: registration.playerCode || '',
                            matchesPlayed: 0,
                            wins: 0,
                            losses: 0,
                            goalsFor: 0,
                            goalsAgainst: 0,
                            tournamentWins: 0,
                            points: 0,
                        });
                    }
                }
                const matches = tournament.matches || [];
                const finalRound = Math.max(-1, ...matches.map((match) => match.round));
                for (const match of matches) {
                    if (match.status !== 'finished' || !match.player1Id || !match.player2Id
                        || !Number.isInteger(match.score1) || !Number.isInteger(match.score2)) continue;
                    const firstRegistration = registrationsById.get(String(match.player1Id));
                    const secondRegistration = registrationsById.get(String(match.player2Id));
                    if (!firstRegistration?.playerId || !secondRegistration?.playerId) continue;
                    const first = leaderboard.get(String(firstRegistration.playerId));
                    const second = leaderboard.get(String(secondRegistration.playerId));
                    if (!first || !second) continue;
                    const winnerRegistration = String(match.winnerId || '') === String(match.player1Id)
                        ? firstRegistration
                        : String(match.winnerId || '') === String(match.player2Id)
                            ? secondRegistration
                            : null;
                    if (!winnerRegistration?.playerId) continue;
                    first.matchesPlayed += 1;
                    second.matchesPlayed += 1;
                    first.goalsFor += match.score1;
                    first.goalsAgainst += match.score2;
                    second.goalsFor += match.score2;
                    second.goalsAgainst += match.score1;
                    const loser = winnerRegistration === firstRegistration ? second : first;
                    const winner = leaderboard.get(String(winnerRegistration.playerId));
                    winner.wins += 1;
                    winner.points += 3;
                    loser.losses += 1;
                    if (match.round === finalRound && tournament.status === 'completed') {
                        winner.tournamentWins += 1;
                        winner.points += 10;
                    }
                }
            }
            const players = [...leaderboard.values()]
                .sort((left, right) => right.points - left.points
                    || right.tournamentWins - left.tournamentWins
                    || right.wins - left.wins
                    || (right.goalsFor - right.goalsAgainst) - (left.goalsFor - left.goalsAgainst)
                    || left.playerName.localeCompare(right.playerName))
                .slice(0, 100)
                .map((player, index) => ({ rank: index + 1, ...player }));
            return res.json({ leaderboard: players, pointsPolicy: '3 points per match win, plus 10 points per completed tournament title.' });
        } catch (error) {
            return sendDatabaseError(res, error, 'Global leaderboard could not be loaded.');
        }
    });

    router.post('/admin/login', requireTrustedOrigin, (req, res) => {
        const username = process.env.ADMIN_USERNAME;
        const password = process.env.ADMIN_PASSWORD;
        if (!username || !password) {
            return res.status(503).json({ error: 'Admin access is not configured on the server.' });
        }

        const ip = req.ip;
        const attempt = loginAttempts.get(ip);
        if (attempt && attempt.blockedUntil > Date.now()) {
            return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
        }
        const valid = safeEqual(req.body?.username, username) && safeEqual(req.body?.password, password);
        if (!valid) {
            const failures = (attempt?.failures || 0) + 1;
            loginAttempts.set(ip, {
                failures,
                blockedUntil: failures >= 5 ? Date.now() + 10 * 60 * 1000 : 0,
            });
            return res.status(401).json({ error: 'Invalid admin username or password.' });
        }

        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { expiresAt: Date.now() + SESSION_LIFETIME_MS });
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.set('Set-Cookie', `prime_admin_session=${token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`);
        return res.json({ authenticated: true, expiresIn: SESSION_LIFETIME_MS });
    });

    router.get('/admin/session', requireAdmin, (req, res) => res.json({ authenticated: true }));

    router.delete('/admin/session', requireTrustedOrigin, requireAdmin, (req, res) => {
        const token = parseCookies(req.headers.cookie).prime_admin_session;
        sessions.delete(token);
        res.set('Set-Cookie', 'prime_admin_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0');
        return res.json({ authenticated: false });
    });

    router.post('/staff/login', requireTrustedOrigin, (req, res) => {
        const username = process.env.STAFF_USERNAME;
        const password = process.env.STAFF_PASSWORD;
        if (!username || !password) {
            return res.status(503).json({ error: 'Staff portal credentials are not configured.' });
        }
        const ip = req.ip;
        const attempt = loginAttempts.get(`staff:${ip}`);
        if (attempt && attempt.blockedUntil > Date.now()) {
            return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
        }
        if (!safeEqual(req.body?.username, username) || !safeEqual(req.body?.password, password)) {
            const failures = (attempt?.failures || 0) + 1;
            loginAttempts.set(`staff:${ip}`, {
                failures,
                blockedUntil: failures >= 5 ? Date.now() + 10 * 60 * 1000 : 0,
            });
            return res.status(401).json({ error: 'Invalid staff username or password.' });
        }
        loginAttempts.delete(`staff:${ip}`);
        const token = crypto.randomBytes(32).toString('hex');
        staffSessions.set(token, { staffId: username, expiresAt: Date.now() + SESSION_LIFETIME_MS });
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.set('Set-Cookie', `prime_staff_session=${token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`);
        return res.json({ authenticated: true, expiresIn: SESSION_LIFETIME_MS });
    });

    router.get('/staff/session', (req, res) => {
        res.set('Cache-Control', 'no-store, private');
        const token = parseCookies(req.headers.cookie).prime_staff_session;
        const session = token && staffSessions.get(token);
        if (!session || session.expiresAt <= Date.now()) {
            if (token) staffSessions.delete(token);
            return res.json({ authenticated: false });
        }
        session.expiresAt = Date.now() + SESSION_LIFETIME_MS;
        return res.json({ authenticated: true });
    });

    router.delete('/staff/session', requireTrustedOrigin, requireStaff, (req, res) => {
        const token = parseCookies(req.headers.cookie).prime_staff_session;
        staffSessions.delete(token);
        res.set('Set-Cookie', 'prime_staff_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0');
        return res.json({ authenticated: false });
    });

    router.get('/staff/fixtures', requireStaff, async (req, res) => {
        const requestedDate = typeof req.query.date === 'string' ? req.query.date : '';
        const date = requestedDate || new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Africa/Addis_Ababa',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Choose a valid fixture date.' });
        }
        try {
            const tournaments = await WeeklyTournament.find({});
            const fixtures = [];
            for (const tournament of tournaments) {
                const approved = await Registration.find({
                    weekId: tournament.weekId,
                    paymentStatus: 'approved',
                });
                for (const entry of approved) await attachPlayerToRegistration(entry);
                for (const match of publicMatches(tournament.matches || [], approved)) {
                    if (!match.scheduledAt) continue;
                    const matchDate = new Intl.DateTimeFormat('en-CA', {
                        timeZone: 'Africa/Addis_Ababa',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                    }).format(new Date(match.scheduledAt));
                    if (matchDate !== date) continue;
                    fixtures.push({
                        ...match,
                        tournamentName: tournament.name || tournamentName(tournament.weekId),
                        weekId: tournament.weekId,
                    });
                }
            }
            return res.json({ date, fixtures });
        } catch (error) {
            return sendDatabaseError(res, error, 'Daily fixtures could not be loaded.');
        }
    });

    router.get('/staff/approved-passes', requireStaff, async (req, res) => {
        try {
            const tournaments = await WeeklyTournament.find({}).sort({ weekId: -1 });
            const passes = [];
            for (const tournament of tournaments) {
                const registrations = await Registration.find({
                    weekId: tournament.weekId,
                    paymentStatus: 'approved',
                }).sort({ approvedAt: -1 }).limit(1000);
                for (const registration of registrations) {
                    await attachPlayerToRegistration(registration);
                    const match = scheduledMatchForRegistration(tournament, registration._id);
                    const opponentId = match
                        ? String(match.player1Id) === String(registration._id) ? match.player2Id : match.player1Id
                        : null;
                    const opponent = opponentId
                        ? registrations.find((entry) => String(entry._id) === String(opponentId))
                        : null;
                    passes.push({
                        ...publicRegistration(registration, false),
                        tournamentName: tournament.name || tournamentName(tournament.weekId),
                        scheduledAt: match?.scheduledAt || null,
                        location: match?.location || '',
                        matchId: match?.matchId || null,
                        opponentName: opponent?.playerName || '',
                    });
                }
            }
            return res.json({ passes });
        } catch (error) {
            return sendDatabaseError(res, error, 'Approved player passes could not be loaded.');
        }
    });

    router.patch('/staff/tournaments/:weekId/matches/:matchId/schedule', requireTrustedOrigin, requireStaff, async (req, res) => {
        const weekId = Number(req.params.weekId);
        const { scheduledAt, location = '' } = req.body || {};
        if (!Number.isInteger(weekId) || weekId < 0
            || (scheduledAt !== null && (typeof scheduledAt !== 'string'
                || Number.isNaN(new Date(scheduledAt).getTime())))
            || typeof location !== 'string' || location.trim().length > 120) {
            return res.status(400).json({ error: 'Provide a valid match time and venue.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId });
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const match = tournament.matches.find((item) => item.matchId === req.params.matchId);
            if (!match || match.status === 'bye') return res.status(404).json({ error: 'Playable match not found.' });
            const previousTime = match.scheduledAt || null;
            const previousLocation = match.location || '';
            match.scheduledAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
            match.location = location.trim();
            if (String(previousTime || '') !== String(match.scheduledAt || '')
                || previousLocation !== match.location) {
                match.reminderSentFor = null;
            }
            await tournament.save();
            const entries = await Registration.find({ weekId, paymentStatus: 'approved' });
            const entryById = new Map(entries.map((entry) => [String(entry._id), entry]));
            for (const playerId of [match.player1Id, match.player2Id]) {
                const entry = entryById.get(String(playerId));
                if (!entry?.playerId) continue;
                const message = match.scheduledAt
                    ? `Your match schedule has been updated to ${new Date(match.scheduledAt).toLocaleString()}${match.location ? ` at ${match.location}` : ''}.`
                    : 'Your previously announced match time was removed. Watch for an updated schedule.';
                await tryCreatePlayerNotification(entry.playerId, {
                    type: 'match_schedule',
                    title: 'Match schedule updated',
                    message,
                });
                await notifyTelegram(await Player.findById(entry.playerId), message);
            }
            return res.json({ fixture: match });
        } catch (error) {
            return sendDatabaseError(res, error, 'Match schedule could not be updated.');
        }
    });

    router.post('/staff/check-in', requireTrustedOrigin, requireStaff, async (req, res) => {
        const rawToken = typeof req.body?.passToken === 'string' ? req.body.passToken.trim() : '';
        const passToken = rawToken.replace(/^PGZ-PASS:/i, '').toLowerCase();
        if (!/^[a-f0-9]{64}$/i.test(passToken)) {
            return res.status(400).json({ error: 'Scan a valid Prime digital pass QR code.' });
        }
        try {
            const approvedRegistration = await Registration.findOne({
                passToken,
                paymentStatus: 'approved',
            });
            if (!approvedRegistration) {
                return res.status(404).json({ error: 'No approved player entry matches that pass.' });
            }
            if (approvedRegistration.checkInStatus === 'checked_in') {
                return res.status(409).json({
                    code: 'PASS_ALREADY_USED',
                    error: `${approvedRegistration.playerName}'s pass has already been used for check-in.`,
                });
            }
            const tournament = await WeeklyTournament.findOne({ weekId: approvedRegistration.weekId });
            const match = scheduledMatchForRegistration(tournament, approvedRegistration._id);
            const timeError = checkInAvailabilityError(match);
            if (timeError) {
                return res.status(409).json({
                    code: 'NOT_YOUR_TIME',
                    error: timeError,
                });
            }
            const checkedInAt = new Date().toISOString();
            const registration = await Registration.findOneAndUpdate(
                {
                    passToken,
                    paymentStatus: 'approved',
                    checkInStatus: { $ne: 'checked_in' },
                },
                {
                    $set: {
                        checkInStatus: 'checked_in',
                        readyStatus: 'ready',
                        passStage: 'check_in',
                        checkedInAt,
                    },
                },
                { new: true },
            );
            if (!registration) {
                const existing = await Registration.findOne({ passToken });
                if (existing?.paymentStatus === 'approved' && existing.checkInStatus === 'checked_in') {
                    return res.status(409).json({
                        code: 'PASS_ALREADY_USED',
                        error: `${existing.playerName}'s pass has already been used for check-in.`,
                    });
                }
                return res.status(404).json({ error: 'No approved player entry matches that pass.' });
            }
            return res.json({
                checkedIn: true,
                player: publicRegistration(registration, false),
                checkedInAt: registration.checkedInAt,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player check-in could not be completed.');
        }
    });

    router.patch('/staff/registrations/:id/stage', requireTrustedOrigin, requireStaff, async (req, res) => {
        const { stage } = req.body || {};
        if (!['play_off', 'end_of_play'].includes(stage)) {
            return res.status(400).json({ error: 'Choose the next valid pass stage.' });
        }
        try {
            const registration = await Registration.findById(req.params.id);
            if (!registration || registration.paymentStatus !== 'approved') {
                return res.status(404).json({ error: 'Approved registration was not found.' });
            }
            const currentStage = currentPassStage(registration);
            if (nextPassStage(currentStage) !== stage) {
                return res.status(409).json({
                    error: `Pass stage must advance in order. Current stage: ${currentStage}.`,
                    player: publicRegistration(registration, false),
                });
            }
            const stageCondition = currentStage === 'check_in'
                ? {
                    $or: [
                        { passStage: 'check_in' },
                        { passStage: { $exists: false }, checkInStatus: 'checked_in' },
                    ],
                }
                : { passStage: currentStage };
            const updated = await Registration.findOneAndUpdate(
                { _id: req.params.id, paymentStatus: 'approved', ...stageCondition },
                { $set: { passStage: stage } },
                { new: true },
            );
            if (!updated) {
                return res.status(409).json({ error: 'The pass stage changed. Refresh the pass and try again.' });
            }
            return res.json({ player: publicRegistration(updated, false) });
        } catch (error) {
            return sendDatabaseError(res, error, 'Pass stage could not be updated.');
        }
    });

    router.get('/staff/chats', requireStaff, async (req, res) => {
        try {
            const [chats] = await getPool().execute(
                `SELECT c.player_id AS playerId,
                        JSON_UNQUOTE(JSON_EXTRACT(p.document, '$.displayName')) AS displayName,
                        JSON_UNQUOTE(JSON_EXTRACT(p.document, '$.playerCode')) AS playerCode,
                        (SELECT COALESCE(latest.body, CASE latest.message_type
                            WHEN 'image' THEN 'Image'
                            WHEN 'audio' THEN 'Voice message'
                            WHEN 'file' THEN 'Attachment'
                            ELSE ''
                         END) FROM chat_messages latest WHERE latest.chat_id = c.id ORDER BY latest.id DESC LIMIT 1) AS latestMessage,
                        (SELECT COUNT(*) FROM chat_messages unread
                         WHERE unread.chat_id = c.id AND unread.sender = 'player'
                           AND unread.read_at IS NULL AND unread.deleted_at IS NULL) AS unreadCount
                 FROM player_chats c JOIN pgz_players p ON p.id = c.player_id
                 ORDER BY c.updated_at DESC LIMIT 300`,
            );
            return res.json({ chats: chats.map((chat) => ({ ...chat, unreadCount: Number(chat.unreadCount) })) });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player conversations could not be loaded.');
        }
    });

    router.get('/staff/chats/:playerId', requireStaff, async (req, res) => {
        if (!isValidObjectId(req.params.playerId)) return res.status(400).json({ error: 'Choose a valid player.' });
        try {
            const [chats] = await getPool().execute('SELECT id FROM player_chats WHERE player_id = ?', [req.params.playerId]);
            if (!chats.length) return res.json({ messages: [] });
            const chatId = chats[0].id;
            await getPool().execute(
                "UPDATE chat_messages SET read_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND sender = 'player' AND read_at IS NULL",
                [chatId],
            );
            const messages = await loadChatMessages(getPool(), chatId, {
                actor: 'admin', id: 'staff', admin: true, playerId: req.params.playerId,
            });
            return res.json({ messages });
        } catch (error) {
            return sendDatabaseError(res, error, 'Conversation history could not be loaded.');
        }
    });

    router.post('/staff/chats/:playerId', requireTrustedOrigin, requireStaff, async (req, res) => {
        const input = parseChatMessageInput(req.body);
        if (!isValidObjectId(req.params.playerId)) return res.status(400).json({ error: 'Choose a valid player.' });
        if (input.error || input.attachment) {
            return res.status(400).json({ error: input.error || 'Staff replies support text messages only.' });
        }
        try {
            const player = await Player.findById(req.params.playerId);
            if (!player) return res.status(404).json({ error: 'Player account not found.' });
            const chatId = await chatIdForPlayer(req.params.playerId);
            const messageId = await insertChatMessage(getPool(), { chatId, sender: 'admin', ...input });
            await notifyTelegram(player, 'You have a new message on the app, please check it.');
            return res.status(201).json({
                message: {
                    id: messageId,
                    sender: 'admin',
                    body: input.body,
                    messageType: 'text',
                    createdAt: new Date().toISOString(),
                },
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Staff reply could not be sent.');
        }
    });

    router.use('/admin', requireAdmin);

    router.get('/admin/finance', requireAdmin, async (req, res) => {
        try {
            const [registrations, tournaments] = await Promise.all([
                Registration.find({ paymentStatus: 'approved' }),
                WeeklyTournament.find({}),
            ]);
            const tournamentByWeek = new Map(tournaments.map((item) => [item.weekId, item]));
            const collections = registrations.reduce((total, registration) => (
                total + Number(tournamentByWeek.get(registration.weekId)?.entryFee || 0)
            ), 0);
            const completed = tournaments
                .filter((item) => item.status === 'completed')
                .reduce((total, item) => total + Number(item.prizePool || 0), 0);
            const committed = tournaments
                .filter((item) => item.status !== 'completed')
                .reduce((total, item) => total + Number(item.prizePool || 0), 0);
            return res.json({
                currency: 'ETB',
                approvedEntries: registrations.length,
                collectedEntryFees: collections,
                distributedPrizePools: completed,
                committedPrizePools: committed,
                netAfterDistributedPrizes: collections - completed,
                note: 'Prize pool totals use tournament settings; record actual payouts separately for audited accounting.',
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Financial analytics could not be loaded.');
        }
    });

    router.get('/admin/disputes', requireAdmin, async (req, res) => {
        try {
            const [disputes] = await getPool().execute(
                `SELECT d.id, d.player_id AS playerId,
                        JSON_UNQUOTE(JSON_EXTRACT(p.document, '$.displayName')) AS playerName,
                        d.week_id AS weekId, d.match_id AS matchId, d.details, d.status,
                        d.admin_note AS adminNote, d.created_at AS createdAt,
                        d.resolved_at AS resolvedAt, d.proof_mime AS proofMime
                 FROM match_disputes d JOIN pgz_players p ON p.id = d.player_id
                 ORDER BY (d.status = 'open') DESC, d.created_at DESC LIMIT 300`,
            );
            return res.json({ disputes });
        } catch (error) {
            return sendDatabaseError(res, error, 'Match disputes could not be loaded.');
        }
    });

    router.get('/admin/disputes/:id/proof', requireAdmin, async (req, res) => {
        if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Choose a valid dispute.' });
        try {
            const [rows] = await getPool().execute(
                'SELECT proof_data AS proofData, proof_mime AS proofMime FROM match_disputes WHERE id = ?',
                [req.params.id],
            );
            if (!rows.length) return res.status(404).json({ error: 'Dispute not found.' });
            if (!rows[0].proofData) return res.status(404).json({ error: 'This dispute has no image proof.' });
            res.set('Cache-Control', 'no-store, private');
            return res.type(rows[0].proofMime).send(rows[0].proofData);
        } catch (error) {
            return sendDatabaseError(res, error, 'Match proof could not be loaded.');
        }
    });

    router.patch('/admin/disputes/:id', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { status, adminNote = '' } = req.body || {};
        if (!/^\d+$/.test(req.params.id) || !['open', 'resolved'].includes(status)
            || typeof adminNote !== 'string' || adminNote.trim().length > 2000) {
            return res.status(400).json({ error: 'Provide a valid dispute status and organizer note.' });
        }
        try {
            const [result] = await getPool().execute(
                `UPDATE match_disputes
                 SET status = ?, admin_note = ?, resolved_at = ?
                 WHERE id = ?`,
                [status, adminNote.trim() || null, status === 'resolved' ? new Date() : null, req.params.id],
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Dispute not found.' });
            return res.json({ updated: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Dispute could not be updated.');
        }
    });

    router.get('/admin/chat/background', requireAdmin, async (req, res) => {
        try {
            const [rows] = await getPool().execute(
                "SELECT image_data AS imageData, image_mime AS imageMime FROM chat_backgrounds WHERE owner_type = 'admin' AND owner_id = 'organizer'",
            );
            res.set('Cache-Control', 'no-store, private');
            return res.json({
                imageData: rows[0]
                    ? `data:${rows[0].imageMime};base64,${Buffer.from(rows[0].imageData).toString('base64')}`
                    : null,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat background could not be loaded.');
        }
    });

    router.put('/admin/chat/background', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const background = parseChatBackground(req.body);
        if (background.error) return res.status(400).json({ error: background.error });
        try {
            await getPool().execute(
                `INSERT INTO chat_backgrounds (owner_type, owner_id, image_data, image_mime)
                 VALUES ('admin', 'organizer', ?, ?)
                 ON DUPLICATE KEY UPDATE image_data = VALUES(image_data), image_mime = VALUES(image_mime)`,
                [background.data, background.mime],
            );
            return res.json({ saved: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat background could not be saved.');
        }
    });

    router.delete('/admin/chat/background', requireTrustedOrigin, requireAdmin, async (req, res) => {
        try {
            await getPool().execute(
                "DELETE FROM chat_backgrounds WHERE owner_type = 'admin' AND owner_id = 'organizer'",
            );
            return res.json({ removed: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat background could not be removed.');
        }
    });

    router.get('/admin/chats', requireAdmin, async (req, res) => {
        try {
            const pool = getPool();
            await pool.execute(
                `INSERT INTO chat_presence (chat_id, admin_online_until)
                 SELECT id, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND) FROM player_chats
                 ON DUPLICATE KEY UPDATE admin_online_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND)`,
            );
            const [chats] = await getPool().execute(
                `SELECT c.player_id AS playerId,
                        JSON_UNQUOTE(JSON_EXTRACT(p.document, '$.displayName')) AS displayName,
                        JSON_UNQUOTE(JSON_EXTRACT(p.document, '$.playerCode')) AS playerCode,
                        c.blocked_at AS blockedAt, c.reported_at AS reportedAt, c.report_reason AS reportReason,
                        pr.player_online_until > CURRENT_TIMESTAMP AS playerOnline,
                        c.updated_at AS latestMessageAt,
                        (SELECT COALESCE(latest.body, CASE latest.message_type
                            WHEN 'image' THEN '📷 Image'
                            WHEN 'audio' THEN '🎙 Voice message'
                            WHEN 'file' THEN '📎 Attachment'
                            ELSE ''
                         END) FROM chat_messages latest WHERE latest.chat_id = c.id ORDER BY latest.id DESC LIMIT 1) AS latestMessage,
                        (SELECT COUNT(*) FROM chat_messages unread
                         WHERE unread.chat_id = c.id AND unread.sender = 'player' AND unread.read_at IS NULL AND unread.deleted_at IS NULL) AS unreadCount
                 FROM player_chats c
                 JOIN pgz_players p ON p.id = c.player_id
                 LEFT JOIN chat_presence pr ON pr.chat_id = c.id
                 ORDER BY c.updated_at DESC
                 LIMIT 300`,
            );
            return res.json({ chats: chats.map((chat) => ({
                ...chat,
                blocked: Boolean(chat.blockedAt),
                reported: Boolean(chat.reportedAt),
                playerOnline: Boolean(chat.playerOnline),
                unreadCount: Number(chat.unreadCount),
            })) });
        } catch (error) {
            return sendDatabaseError(res, error, 'Support conversations could not be loaded.');
        }
    });

    router.get('/admin/chats/:playerId/profile', requireAdmin, async (req, res) => {
        if (!isValidObjectId(req.params.playerId)) return res.status(400).json({ error: 'Choose a valid player.' });
        try {
            const player = await Player.findById(req.params.playerId);
            if (!player) return res.status(404).json({ error: 'Player account not found.' });
            return res.json({
                player: {
                    id: player._id,
                    displayName: player.displayName,
                    playerCode: player.playerCode,
                    avatar: player.avatar || '',
                },
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player profile could not be loaded.');
        }
    });

    router.get('/admin/chats/:playerId', requireAdmin, async (req, res) => {
        if (!isValidObjectId(req.params.playerId)) return res.status(400).json({ error: 'Choose a valid player.' });
        try {
            const [chatRows] = await getPool().execute(
                'SELECT id FROM player_chats WHERE player_id = ?',
                [req.params.playerId],
            );
            if (!chatRows.length) return res.json({ messages: [] });
            const pool = getPool();
            await pool.execute(
                "UPDATE chat_messages SET read_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND sender = 'player' AND read_at IS NULL",
                [chatRows[0].id],
            );
            await pool.execute(
                `INSERT INTO chat_presence (chat_id, admin_online_until)
                 VALUES (?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND))
                 ON DUPLICATE KEY UPDATE admin_online_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 20 SECOND)`,
                [chatRows[0].id],
            );
            const messages = await loadChatMessages(pool, chatRows[0].id, {
                actor: 'admin',
                id: 'admin',
                admin: true,
                playerId: req.params.playerId,
            });
            const [status] = await pool.execute(
                `SELECT c.blocked_at AS blockedAt, c.reported_at AS reportedAt, c.report_reason AS reportReason,
                        p.player_typing_until > CURRENT_TIMESTAMP AS playerTyping,
                        p.player_online_until > CURRENT_TIMESTAMP AS playerOnline
                 FROM player_chats c LEFT JOIN chat_presence p ON p.chat_id = c.id
                 WHERE c.id = ?`,
                [chatRows[0].id],
            );
            return res.json({
                messages,
                blocked: Boolean(status[0]?.blockedAt),
                reported: Boolean(status[0]?.reportedAt),
                reportReason: status[0]?.reportReason || '',
                playerTyping: Boolean(status[0]?.playerTyping),
                playerOnline: Boolean(status[0]?.playerOnline),
                pinned: messages.find((message) => message.isPinned) || null,
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Conversation history could not be loaded.');
        }
    });

    router.post('/admin/chats/:playerId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const input = parseChatMessageInput(req.body);
        if (!isValidObjectId(req.params.playerId)) return res.status(400).json({ error: 'Choose a valid player.' });
        if (input.error) return res.status(400).json({ error: input.error });
        try {
            const player = await Player.findById(req.params.playerId);
            if (!player) return res.status(404).json({ error: 'Player account not found.' });
            const chatId = await chatIdForPlayer(player._id);
            const [chatRows] = await getPool().execute(
                'SELECT blocked_at AS blockedAt FROM player_chats WHERE id = ?',
                [chatId],
            );
            if (chatRows[0]?.blockedAt) return res.status(403).json({ error: 'Unblock this player before sending a reply.' });
            const messageId = await insertChatMessage(getPool(), { chatId, sender: 'admin', ...input });
            await tryCreatePlayerNotification(player._id, {
                type: 'support_message',
                title: 'New message from Prime Gaming Zone',
                message: 'You have a new message on the app, please check it',
            });
            await notifyTelegram(player, 'You have a new message on the app, please check it');
            return res.status(201).json({
                message: {
                    id: messageId,
                    sender: 'admin',
                    body: input.body,
                    messageType: input.attachment?.type || 'text',
                    attachmentMime: input.attachment?.mime || null,
                    attachmentName: input.attachment?.name || null,
                    attachmentUrl: input.attachment
                        ? `/api/admin/chats/${req.params.playerId}/messages/${messageId}/attachment`
                        : null,
                    isPinned: false,
                    editedAt: null,
                    deletedAt: null,
                    readAt: null,
                    reactions: [],
                    createdAt: new Date().toISOString(),
                },
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Your reply could not be sent.');
        }
    });

    router.post('/admin/chats/:playerId/typing', requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (!isValidObjectId(req.params.playerId) || typeof req.body?.typing !== 'boolean') {
            return res.status(400).json({ error: 'Choose a valid player and typing state.' });
        }
        try {
            const chatId = await chatIdForPlayer(req.params.playerId);
            await setChatTyping(getPool(), chatId, 'admin', req.body.typing);
            return res.json({ updated: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Typing status could not be updated.');
        }
    });

    router.patch('/admin/chats/:playerId/messages/:messageId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const body = req.body?.body;
        if (!isValidObjectId(req.params.playerId) || !/^\d+$/.test(req.params.messageId)
            || typeof body !== 'string' || !body.trim() || body.trim().length > 2000) {
            return res.status(400).json({ error: 'Choose a valid message and enter 1 to 2,000 characters.' });
        }
        try {
            const [result] = await getPool().execute(
                `UPDATE chat_messages SET body = ?, edited_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND chat_id = (SELECT id FROM player_chats WHERE player_id = ?) AND deleted_at IS NULL`,
                [body.trim(), req.params.messageId, req.params.playerId],
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Message could not be found or edited.' });
            return res.json({ updated: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Message could not be edited.');
        }
    });

    router.delete('/admin/chats/:playerId/messages/:messageId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (!isValidObjectId(req.params.playerId) || !/^\d+$/.test(req.params.messageId)) {
            return res.status(400).json({ error: 'Choose a valid message.' });
        }
        try {
            const [result] = await getPool().execute(
                `UPDATE chat_messages SET body = NULL, attachment_data = NULL, attachment_mime = NULL,
                        attachment_name = NULL, deleted_at = CURRENT_TIMESTAMP, is_pinned = FALSE
                 WHERE id = ? AND chat_id = (SELECT id FROM player_chats WHERE player_id = ?) AND deleted_at IS NULL`,
                [req.params.messageId, req.params.playerId],
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Message could not be found or deleted.' });
            return res.json({ deleted: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Message could not be deleted.');
        }
    });

    router.put('/admin/chats/:playerId/messages/:messageId/pin', requireTrustedOrigin, requireAdmin, async (req, res) => {
        if (!isValidObjectId(req.params.playerId) || !/^\d+$/.test(req.params.messageId)) {
            return res.status(400).json({ error: 'Choose a valid message.' });
        }
        try {
            const pool = getPool();
            const [chatRows] = await pool.execute('SELECT id FROM player_chats WHERE player_id = ?', [req.params.playerId]);
            if (!chatRows.length) {
                return res.status(404).json({ error: 'Message could not be pinned.' });
            }
            const pinned = await pinChatMessage(pool, chatRows[0].id, req.params.messageId);
            if (pinned === null) return res.status(404).json({ error: 'Message could not be pinned.' });
            return res.json({ pinnedMessageId: pinned ? Number(req.params.messageId) : null });
        } catch (error) {
            return sendDatabaseError(res, error, 'Message could not be pinned.');
        }
    });

    router.post('/admin/chats/:playerId/messages/:messageId/reactions', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { emoji } = req.body || {};
        if (!isValidObjectId(req.params.playerId) || !/^\d+$/.test(req.params.messageId)
            || !CHAT_REACTIONS.includes(emoji)) {
            return res.status(400).json({ error: 'Choose a valid message and supported reaction.' });
        }
        try {
            const [rows] = await getPool().execute(
                `SELECT id FROM chat_messages
                 WHERE id = ? AND chat_id = (SELECT id FROM player_chats WHERE player_id = ?) AND deleted_at IS NULL`,
                [req.params.messageId, req.params.playerId],
            );
            if (!rows.length) return res.status(404).json({ error: 'Message not found.' });
            const reacted = await toggleChatReaction(getPool(), req.params.messageId, 'admin', 'admin', emoji);
            return res.json({ reacted });
        } catch (error) {
            return sendDatabaseError(res, error, 'Reaction could not be saved.');
        }
    });

    router.get('/admin/chats/:playerId/messages/:messageId/attachment', requireAdmin, async (req, res) => {
        if (!isValidObjectId(req.params.playerId) || !/^\d+$/.test(req.params.messageId)) {
            return res.status(400).json({ error: 'Choose a valid message.' });
        }
        try {
            const [rows] = await getPool().execute(
                'SELECT id FROM player_chats WHERE player_id = ?',
                [req.params.playerId],
            );
            if (!rows.length) return res.status(404).json({ error: 'Conversation not found.' });
            return await sendChatAttachment(res, getPool(), rows[0].id, req.params.messageId);
        } catch (error) {
            return sendDatabaseError(res, error, 'Chat attachment could not be loaded.');
        }
    });

    router.patch('/admin/chats/:playerId/moderation', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { blocked, clearReport = false } = req.body || {};
        if (!isValidObjectId(req.params.playerId) || typeof blocked !== 'boolean'
            || typeof clearReport !== 'boolean') {
            return res.status(400).json({ error: 'Provide a valid player moderation update.' });
        }
        try {
            const updates = [
                blocked ? 'blocked_at = CURRENT_TIMESTAMP' : 'blocked_at = NULL',
            ];
            if (clearReport) updates.push('reported_at = NULL', 'report_reason = NULL');
            const [result] = await getPool().execute(
                `UPDATE player_chats SET ${updates.join(', ')} WHERE player_id = ?`,
                [req.params.playerId],
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Support conversation not found.' });
            return res.json({ blocked, reportCleared: clearReport });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player moderation could not be updated.');
        }
    });

    router.get('/admin/tournaments', requireAdmin, async (req, res) => {
        try {
            const tournaments = await ensureWeeks();
            const registrations = await Registration.aggregate([
                { $group: { _id: '$weekId', count: { $sum: 1 } } },
            ]);
            const registrationCounts = new Map(registrations.map((item) => [item._id, item.count]));
            return res.json({
                tournaments: tournaments.map((tournament) => ({
                    ...adminTournament(tournament),
                    playerCount: registrationCounts.get(tournament.weekId) || 0,
                })),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournaments could not be loaded.');
        }
    });

    router.post('/admin/tournaments', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const {
            dateRange,
            capacity,
            entryFee = 1500,
            prizePool = 20000,
            prizeTiers,
            type = 'weekly',
            format = 'knockout',
            status = 'upcoming',
        } = req.body || {};
        const distribution = parsePrizeDistribution(prizeTiers, prizePool);
        if (typeof dateRange !== 'string' || !dateRange.trim() || dateRange.trim().length > 40
            || !Number.isInteger(capacity) || capacity < 2 || capacity > CAPACITY
            || !Number.isInteger(entryFee) || entryFee < 0 || entryFee > 1_000_000
            || !distribution
            || !TOURNAMENT_TYPES.includes(type) || !TOURNAMENT_FORMATS.includes(format)
            || !ADMIN_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Enter a date, capacity between 2 and ${CAPACITY}, and valid tournament status.` });
        }
        try {
            const tournaments = await ensureWeeks();
            const weekId = await nextTournamentWeekId(tournaments);
            const tournament = await WeeklyTournament.create({
                weekId,
                name: tournamentName(weekId),
                dateRange: dateRange.trim(),
                capacity,
                entryFee,
                prizePool: distribution.prizePool,
                prizeTiers: distribution.prizeTiers,
                type,
                format,
                availableSlots: capacity,
                slotsReconciled: true,
                status: status === 'upcoming' ? 'open' : status,
                matches: [],
            });
            return res.status(201).json({ tournament: adminTournament(tournament) });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament could not be created.');
        }
    });

    router.patch('/admin/tournaments/:weekId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        const {
            dateRange,
            capacity,
            entryFee = 1500,
            prizePool = 20000,
            prizeTiers,
            type = 'weekly',
            format = 'knockout',
            status,
        } = req.body || {};
        const distribution = parsePrizeDistribution(prizeTiers, prizePool);
        if (!Number.isInteger(weekId) || weekId < 0
            || typeof dateRange !== 'string' || !dateRange.trim() || dateRange.trim().length > 40
            || !Number.isInteger(capacity) || capacity < 2 || capacity > CAPACITY
            || !Number.isInteger(entryFee) || entryFee < 0 || entryFee > 1_000_000
            || !distribution
            || !TOURNAMENT_TYPES.includes(type) || !TOURNAMENT_FORMATS.includes(format)
            || !ADMIN_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Provide valid tournament details and status.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId });
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const reservedCount = await Registration.countDocuments({
                weekId,
                paymentStatus: { $in: ['pending', 'approved'] },
            });
            if (capacity < reservedCount) {
                return res.status(409).json({ error: `Capacity cannot be lower than the ${reservedCount} reserved entries.` });
            }
            if (capacity !== tournament.capacity && tournament.matches.length) {
                return res.status(409).json({ error: 'Reset the tournament draw before changing its capacity.' });
            }
            const availableSlots = Math.min(
                capacity - reservedCount,
                Math.max(0, tournament.availableSlots + capacity - tournament.capacity),
            );
            tournament.name = tournamentName(weekId);
            if (Object.prototype.hasOwnProperty.call(tournament, 'theme')) delete tournament.theme;
            tournament.dateRange = dateRange.trim();
            tournament.capacity = capacity;
            tournament.entryFee = entryFee;
            tournament.prizePool = distribution.prizePool;
            tournament.prizeTiers = distribution.prizeTiers;
            tournament.type = type;
            tournament.format = format;
            tournament.availableSlots = availableSlots;
            tournament.slotsReconciled = true;
            tournament.status = status === 'upcoming'
                ? (tournament.availableSlots === 0 ? 'full' : 'open')
                : status;
            await tournament.save();
            const fixturesGenerated = await maybeGenerateClosedTournamentFixtures(tournament);
            return res.json({ tournament: adminTournament(tournament), fixturesGenerated });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament could not be updated.');
        }
    });

    router.delete('/admin/tournaments/:weekId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0) {
            return res.status(400).json({ error: 'Invalid tournament.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId });
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const count = await WeeklyTournament.countDocuments();
            if (count <= 1) {
                return res.status(409).json({ error: 'At least one tournament must remain available.' });
            }
            await Registration.deleteMany({ weekId });
            await tournament.deleteOne();
            return res.json({ deleted: true, weekId });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament could not be deleted.');
        }
    });

    router.post('/admin/tournaments/:weekId/fixtures', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0) {
            return res.status(400).json({ error: 'Invalid tournament.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId });
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            if (tournament.status === 'completed') {
                return res.status(409).json({ error: 'Completed tournaments cannot generate a new draw.' });
            }
            if (tournament.matches.some((match) => match.status === 'ongoing'
                || (match.status === 'finished' && match.player1Id && match.player2Id))) {
                return res.status(409).json({ error: 'The existing draw has played matches and cannot be replaced.' });
            }
            const players = await Registration.find({ weekId, paymentStatus: 'approved' })
                .sort({ approvedAt: 1, createdAt: 1 })
                .limit(tournament.capacity);
            for (const player of players) await attachPlayerToRegistration(player);
            if (players.length < 2) {
                return res.status(409).json({ error: 'At least two approved players are required to generate fixtures.' });
            }
            tournament.matches = generateFixtures(players, Math.random, tournament.format || 'knockout');
            await tournament.save();
            return res.status(201).json({
                matches: publicMatches(tournament.matches, players),
                standings: tournamentStandings(players, tournament.matches, tournament.format || 'knockout'),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Fixtures could not be generated.');
        }
    });

    router.get('/admin/tournaments/:weekId/fixtures', requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0) {
            return res.status(400).json({ error: 'Invalid tournament.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId }).lean();
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const players = await Registration.find({ weekId, paymentStatus: 'approved' });
            for (const player of players) await attachPlayerToRegistration(player);
            return res.json({
                matches: publicMatches(tournament.matches || [], players),
                standings: tournamentStandings(players, tournament.matches || [], tournament.format || 'knockout'),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Fixtures could not be loaded.');
        }
    });

    router.patch('/admin/tournaments/:weekId/matches/:matchId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        const { status, score1, score2, scheduledAt = null, location = '' } = req.body || {};
        const validScore = (score) => score === null || score === undefined
            || (Number.isInteger(score) && score >= 0 && score <= 99);
        if (!Number.isInteger(weekId) || weekId < 0 || !['pending', 'ongoing', 'finished'].includes(status)
            || !validScore(score1) || !validScore(score2)
            || typeof location !== 'string' || location.trim().length > 120
            || (scheduledAt !== null && (typeof scheduledAt !== 'string'
                || Number.isNaN(new Date(scheduledAt).getTime())))) {
            return res.status(400).json({ error: 'Provide a valid tournament, match status, kickoff time, and scores between 0 and 99.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId });
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const match = tournament.matches.find((item) => item.matchId === req.params.matchId);
            if (!match || match.status === 'bye') return res.status(404).json({ error: 'Playable match not found.' });
            const previousStatus = match.status;
            const previousWinnerId = match.winnerId;
            const previousScore1 = match.score1;
            const previousScore2 = match.score2;
            const previousScheduledAt = match.scheduledAt || null;
            const previousLocation = match.location || '';
            const next = tournament.format === 'league' ? null : tournament.matches.find((item) => item.round === match.round + 1
                && item.matchNumber === Math.floor((match.matchNumber - 1) / 2) + 1);
            if (previousStatus === 'finished' && status !== 'finished'
                && next && next.status !== 'pending') {
                return res.status(409).json({ error: 'This result has already affected a later match and cannot be reopened.' });
            }
            const firstScore = score1 === null || score1 === undefined ? null : score1;
            const secondScore = score2 === null || score2 === undefined ? null : score2;
            if (status === 'ongoing' && (!match.player1Id || !match.player2Id)) {
                return res.status(409).json({ error: 'A match cannot start until both players have advanced into it.' });
            }
            if (status === 'finished' && (!match.player1Id || !match.player2Id
                || !Number.isInteger(firstScore) || !Number.isInteger(secondScore) || firstScore === secondScore)) {
                return res.status(400).json({ error: 'A finished match needs two players and a decisive score.' });
            }
            const winnerId = status === 'finished'
                ? (firstScore > secondScore ? match.player1Id : match.player2Id)
                : null;
            const winnerChanged = String(winnerId || '') !== String(previousWinnerId || '');
            if (previousStatus === 'finished' && status === 'finished' && winnerChanged
                && next && next.status !== 'pending') {
                return res.status(409).json({ error: 'This result has already affected a later match and cannot be changed.' });
            }

            match.status = status;
            match.score1 = status === 'pending' ? null : firstScore;
            match.score2 = status === 'pending' ? null : secondScore;
            match.winnerId = winnerId;
            match.scheduledAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
            match.location = location.trim();
            const scheduleChanged = String(previousScheduledAt || '') !== String(match.scheduledAt || '')
                || previousLocation !== match.location;
            if (scheduleChanged) match.reminderSentFor = null;
            if (status === 'ongoing' && ['open', 'full'].includes(tournament.status)) {
                tournament.status = 'live';
            }
            if (tournament.format !== 'league' && status === 'finished' && (previousStatus !== 'finished' || winnerChanged)) {
                advanceMatchWinner(tournament.matches, match, winnerId);
            } else if (previousStatus === 'finished' && status !== 'finished' && next) {
                const isFirstSlot = (match.matchNumber - 1) % 2 === 0;
                const playerKey = isFirstSlot ? 'player1Id' : 'player2Id';
                const readyKey = isFirstSlot ? 'player1Ready' : 'player2Ready';
                next[playerKey] = null;
                next[readyKey] = false;
            }
            const finalRound = Math.max(-1, ...tournament.matches.map((item) => item.round));
            const leagueComplete = tournament.format === 'league'
                && tournament.matches.every((item) => ['finished', 'bye'].includes(item.status));
            if ((tournament.format === 'league' && leagueComplete)
                || (tournament.format !== 'league' && status === 'finished' && match.round === finalRound && !next)) {
                tournament.status = 'completed';
            }
            await tournament.save();
            const players = await Registration.find({ weekId, paymentStatus: 'approved' });
            for (const player of players) await attachPlayerToRegistration(player);
            const matchPlayers = [match.player1Id, match.player2Id]
                .map((playerId) => players.find((player) => String(player._id) === String(playerId)))
                .filter((player) => player?.playerId);
            const notificationPromises = [];
            if (scheduleChanged && (match.scheduledAt || previousScheduledAt)) {
                const scheduledText = match.scheduledAt
                    ? `Your match against {opponent} is scheduled for ${new Date(match.scheduledAt).toLocaleString()}${match.location ? ` at ${match.location}` : ''}.`
                    : 'The previously announced kickoff time was removed. Watch for an updated schedule.';
                matchPlayers.forEach((player, index) => {
                    const opponent = matchPlayers[1 - index];
                    const personalizedMessage = scheduledText.replace('{opponent}', opponent?.playerName || 'your opponent');
                    notificationPromises.push(tryCreatePlayerNotification(player.playerId, {
                        type: 'match_schedule',
                        title: match.scheduledAt ? 'Match scheduled' : 'Match schedule updated',
                        message: personalizedMessage,
                    }));
                    const telegramPlayer = Player.findById(player.playerId)
                        .then((account) => notifyTelegram(account, personalizedMessage));
                    notificationPromises.push(telegramPlayer);
                });
            }
            const resultChanged = status === 'finished'
                && (previousStatus !== 'finished'
                    || previousScore1 !== match.score1
                    || previousScore2 !== match.score2
                    || winnerChanged);
            if (resultChanged) {
                matchPlayers.forEach((player, index) => {
                    const opponent = matchPlayers[1 - index];
                    const won = String(winnerId) === String(player._id);
                    const playerScore = index === 0 ? match.score1 : match.score2;
                    const opponentScore = index === 0 ? match.score2 : match.score1;
                    notificationPromises.push(tryCreatePlayerNotification(player.playerId, {
                        type: 'match_result',
                        title: won ? 'Match victory' : 'Match result posted',
                        message: `Final score ${playerScore}–${opponentScore} against ${opponent?.playerName || 'your opponent'}. ${won ? 'You won and advanced to the next round.' : 'Your opponent advances to the next round.'}`,
                    }));
                });
            }
            const notificationWarnings = (await Promise.all(notificationPromises)).filter(Boolean);
            return res.json({
                matches: publicMatches(tournament.matches, players),
                standings: tournamentStandings(players, tournament.matches, tournament.format || 'knockout'),
                ...(notificationWarnings.length ? { notificationWarning: notificationWarnings[0] } : {}),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Match could not be updated.');
        }
    });

    router.get('/admin/weeks', requireAdmin, async (req, res) => {
        try {
            const weeks = await ensureWeeks();
            return res.json({ weeks });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament weeks could not be loaded.');
        }
    });

    router.patch('/admin/weeks/:weekId', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        const { availableSlots, status } = req.body || {};
        if (!Number.isInteger(weekId) || weekId < 0 || weekId > 3
            || !Number.isInteger(availableSlots) || availableSlots < 0 || availableSlots > CAPACITY
            || !STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Provide a valid week, available slot count, and status.' });
        }
        try {
            await ensureWeeks();
            const week = await WeeklyTournament.findOneAndUpdate(
                { weekId },
                { $set: { availableSlots, status: availableSlots === 0 && status === 'open' ? 'full' : status } },
                { new: true, runValidators: true },
            );
            return res.json({ week });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament week could not be updated.');
        }
    });

    router.get('/admin/registrations', requireAdmin, async (req, res) => {
        const filter = {};
        const summary = req.query.summary === '1';
        if (req.query.week !== undefined) {
            const weekId = Number(req.query.week);
            if (!Number.isInteger(weekId) || weekId < 0) {
                return res.status(400).json({ error: 'Invalid tournament.' });
            }
            filter.weekId = weekId;
        }
        try {
            let query = Registration.find(filter);
            if (!summary) query = query.select('+receiptData');
            const registrations = await query.sort({ createdAt: -1 }).limit(500);
            if (!summary) {
                for (const registration of registrations) await attachPlayerToRegistration(registration);
            }
            return res.json({
                registrations: registrations.map((registration) => ({
                    ...publicRegistration(registration, false),
                    ...(!summary ? { receiptData: registration.receiptData || '' } : {}),
                })),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Registrations could not be loaded.');
        }
    });

    router.put('/admin/payment-accounts', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { accounts } = req.body || {};
        if (!Array.isArray(accounts) || accounts.length !== 2
            || !['cbe', 'telebirr'].every((type) => accounts.some((account) => account && account.type === type
                && typeof account.name === 'string' && account.name.trim().length <= 120
                && typeof account.number === 'string' && account.number.trim().length <= 80))) {
            return res.status(400).json({ error: 'Provide valid CBE and Telebirr account details.' });
        }
        try {
            const pool = getPool();
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                for (const account of accounts) {
                    await connection.execute(
                        `INSERT INTO payment_accounts (account_type, account_name, account_number)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE account_name = VALUES(account_name),
                                                 account_number = VALUES(account_number)`,
                        [account.type, account.name.trim(), account.number.trim()],
                    );
                }
                await connection.commit();
            } catch (error) {
                await connection.rollback();
                throw error;
            } finally {
                connection.release();
            }
            return res.json({ saved: true });
        } catch (error) {
            return sendDatabaseError(res, error, 'Payment account details could not be saved.');
        }
    });

    router.get('/admin/payment-groups', requireAdmin, async (req, res) => {
        try {
            const pending = await Registration.find({ paymentStatus: 'pending' })
                .sort({ createdAt: -1 })
                .limit(500);
            const groups = new Map();
            for (const entry of pending) {
                const groupId = entry.paymentGroupId || String(entry._id);
                if (!groups.has(groupId)) {
                    groups.set(groupId, {
                        id: groupId,
                        paymentGroupId: entry.paymentGroupId || null,
                        weekId: entry.weekId,
                        payment: entry.payment,
                        paymentStatus: 'pending',
                        createdAt: entry.createdAt,
                        members: [],
                        receiptData: '',
                    });
                }
                groups.get(groupId).members.push(publicRegistration(entry, false));
            }
            const groupIds = [...groups.values()].filter((group) => group.paymentGroupId);
            if (groupIds.length) {
                const [submissions] = await getPool().execute(
                    `SELECT group_id AS groupId, receipt_data AS receiptData, receipt_mime AS receiptMime
                     FROM payment_submissions WHERE group_id IN (${groupIds.map(() => '?').join(', ')})`,
                    groupIds.map((group) => group.paymentGroupId),
                );
                const submissionByGroup = new Map(submissions.map((submission) => [
                    submission.groupId,
                    submission,
                ]));
                for (const group of groupIds) {
                    const submission = submissionByGroup.get(group.paymentGroupId);
                    if (submission?.receiptData) {
                        group.receiptData = `data:${submission.receiptMime};base64,${Buffer.from(submission.receiptData).toString('base64')}`;
                    }
                }
            }
            for (const group of groups.values()) {
                if (group.paymentGroupId) continue;
                const registration = await Registration.findById(group.id).select('+receiptData');
                group.receiptData = registration?.receiptData || '';
            }
            return res.json({ groups: [...groups.values()] });
        } catch (error) {
            return sendDatabaseError(res, error, 'Payment groups could not be loaded.');
        }
    });

    router.post('/admin/payment-groups/:groupId/review', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { decision, reason = '' } = req.body || {};
        if (!['approved', 'rejected'].includes(decision)
            || typeof reason !== 'string' || reason.trim().length > 1000
            || (decision === 'rejected' && !reason.trim())) {
            return res.status(400).json({
                error: decision === 'rejected'
                    ? 'Provide a rejection reason before rejecting this payment.'
                    : 'Provide a valid payment decision.',
            });
        }
        try {
            const filter = req.params.groupId.length === 24 && isValidObjectId(req.params.groupId)
                ? { _id: req.params.groupId, paymentStatus: 'pending' }
                : { paymentGroupId: req.params.groupId, paymentStatus: 'pending' };
            const transactionResult = await Registration.withTransaction(async (connection) => {
                const registrations = await Registration.findRows(connection, true);
                const entries = registrations.filter((entry) => (
                    entry.paymentStatus === 'pending'
                    && (filter._id ? String(entry._id) === filter._id : entry.paymentGroupId === filter.paymentGroupId)
                ));
                if (!entries.length) {
                    throw Object.assign(new Error('This payment group has already been reviewed.'), { code: 'PAYMENT_REVIEW_CONFLICT' });
                }
                const weekId = entries[0].weekId;
                if (entries.some((entry) => entry.weekId !== weekId)) {
                    throw Object.assign(new Error('Payment group contains entries from different tournaments.'), { code: 'PAYMENT_REVIEW_CONFLICT' });
                }
                const tournaments = await WeeklyTournament.findRows(connection, true);
                const tournament = tournaments.find((item) => item.weekId === weekId);
                if (!tournament) {
                    throw Object.assign(new Error('Tournament not found.'), { code: 'PAYMENT_REVIEW_NOT_FOUND' });
                }
                const matches = tournament.matches || [];
                if (decision === 'approved' && matches.some((match) => (
                    match.status === 'ongoing'
                    || (match.status === 'finished' && match.player1Id && match.player2Id)
                ))) {
                    throw Object.assign(new Error('Entries cannot be approved after a match has started.'), { code: 'PAYMENT_REVIEW_CONFLICT' });
                }

                if (decision === 'approved' && matches.length) tournament.matches = [];
                const reviewedAt = new Date().toISOString();
                let releasedSlots = 0;
                for (const entry of entries) {
                    entry.paymentStatus = decision;
                    entry.slotReserved = decision === 'approved';
                    if (decision === 'approved') {
                        entry.approvedAt = reviewedAt;
                        entry.passToken = crypto.randomBytes(32).toString('hex');
                        entry.rejectionReason = null;
                    } else {
                        entry.rejectedAt = reviewedAt;
                        entry.rejectionReason = reason.trim();
                        if (entry.slotReserved) releasedSlots += 1;
                    }
                    if (decision === 'rejected') entry.slotReserved = false;
                    await Registration.save(entry, connection);
                }

                if (releasedSlots) {
                    tournament.availableSlots = Math.min(
                        Number(tournament.capacity || DEFAULT_CAPACITY),
                        Number(tournament.availableSlots || 0) + releasedSlots,
                    );
                    if (tournament.status === 'full' && tournament.availableSlots > 0) {
                        tournament.status = 'open';
                    }
                }
                const groupId = entries[0].paymentGroupId;
                if (groupId) {
                    const [submissionUpdate] = await connection.execute(
                        `UPDATE payment_submissions
                         SET decision = ?, rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP
                         WHERE group_id = ? AND decision = 'pending'`,
                        [decision, decision === 'rejected' ? reason.trim() : null, groupId],
                    );
                    if (submissionUpdate.affectedRows !== 1) {
                        throw Object.assign(new Error('This payment group has already been reviewed.'), { code: 'PAYMENT_REVIEW_CONFLICT' });
                    }
                }

                let fixturesGenerated = false;
                if (decision === 'approved') {
                    const approved = registrations
                        .filter((entry) => entry.weekId === weekId && entry.paymentStatus === 'approved')
                        .sort((left, right) => (
                            new Date(left.approvedAt || left.createdAt || 0) - new Date(right.approvedAt || right.createdAt || 0)
                        ));
                    if (approved.length >= tournament.capacity && !tournament.matches.length) {
                        for (const entry of approved) await attachPlayerToRegistration(entry);
                        tournament.matches = generateFixtures(approved.slice(0, tournament.capacity), Math.random, tournament.format || 'knockout');
                        fixturesGenerated = true;
                    }
                }
                if (releasedSlots || (decision === 'approved' && (matches.length || fixturesGenerated))) {
                    await WeeklyTournament.save(tournament, connection);
                }
                return { entries, tournament, fixturesGenerated };
            });

            const { entries, tournament } = transactionResult;
            let fixturesGenerated = transactionResult.fixturesGenerated;
            fixturesGenerated = await maybeGenerateClosedTournamentFixtures(tournament) || fixturesGenerated;
            if (decision === 'approved') {
                for (const entry of entries) {
                    const account = entry.playerId ? await Player.findById(entry.playerId) : null;
                    await sendPassTelegram(account, entry);
                }
            }
            const player = entries[0].playerId ? await Player.findById(entries[0].playerId) : null;
            const tournamentTitle = tournament.name || tournamentName(tournament.weekId);
            const playerNames = entries.map((entry) => entry.psnId || entry.playerName).join(', ');
            const outcome = decision === 'approved'
                ? `${entries.length} entries for ${tournamentTitle} are approved. Digital passes are available in your profile.`
                : `Payment for ${playerNames} (${tournamentTitle}) was rejected. Reason: ${reason.trim()}`;
            const notificationWarning = player
                ? await tryCreatePlayerNotification(player._id, {
                    type: 'registration',
                    title: decision === 'approved' ? 'Payment approved' : 'Payment rejected',
                    message: outcome,
                })
                : null;
            if (decision === 'rejected') {
                for (const entry of entries) {
                    await notifyTelegram(
                        player,
                        `Payment for ${entry.psnId || entry.playerName} (${tournamentTitle}) was rejected. Reason: ${reason.trim()}`,
                    );
                }
            } else {
                await notifyTelegram(player, outcome);
            }
            return res.json({
                registrations: entries.map((entry) => ({
                    id: entry._id,
                    paymentStatus: decision,
                    rejectionReason: decision === 'rejected' ? reason.trim() : null,
                })),
                fixturesGenerated,
                ...(notificationWarning ? { notificationWarning } : {}),
            });
        } catch (error) {
            if (error.code === 'PAYMENT_REVIEW_CONFLICT') {
                return res.status(409).json({ error: error.message });
            }
            if (error.code === 'PAYMENT_REVIEW_NOT_FOUND') {
                return res.status(404).json({ error: error.message });
            }
            return sendDatabaseError(res, error, 'Payment review could not be completed.');
        }
    });

    router.post('/admin/registrations/:id/review', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const { decision, reason = '' } = req.body || {};
        if (!isValidObjectId(req.params.id) || !['approved', 'rejected'].includes(decision)
            || typeof reason !== 'string' || reason.trim().length > 1000
            || (decision === 'rejected' && !reason.trim())) {
            return res.status(400).json({ error: 'Provide a valid registration and review decision.' });
        }
        let reservedWeekId = null;
        try {
            const pending = await Registration.findOne({ _id: req.params.id, paymentStatus: 'pending' });
            if (!pending) return res.status(409).json({ error: 'This registration has already been reviewed.' });
            if (pending.paymentGroupId) {
                return res.status(409).json({ error: 'Review group registrations through the payment group action.' });
            }

            if (decision === 'approved' && !pending.slotReserved) {
                const reservedWeek = await WeeklyTournament.findOneAndUpdate(
                    { weekId: pending.weekId, status: 'open', availableSlots: { $gt: 0 } },
                    { $inc: { availableSlots: -1 } },
                    { new: true },
                );
                if (!reservedWeek) {
                    return res.status(409).json({ error: 'No open slot remains for this tournament week.' });
                }
                reservedWeekId = pending.weekId;
                const hasPlayedMatches = reservedWeek.matches.some((match) => (
                    match.status === 'ongoing'
                    || (match.status === 'finished' && match.player1Id && match.player2Id)
                ));
                if (hasPlayedMatches) {
                    await restoreReservedSlot(pending.weekId);
                    reservedWeekId = null;
                    return res.status(409).json({ error: 'Entries cannot be approved after a match has started.' });
                }
                const resetDraw = reservedWeek.matches.length > 0;
                if (resetDraw) reservedWeek.matches = [];
                if (reservedWeek.availableSlots === 0) reservedWeek.status = 'full';
                if (reservedWeek.availableSlots === 0 || resetDraw) await reservedWeek.save();
            }

            if (decision === 'approved' && pending.slotReserved) {
                const tournament = await WeeklyTournament.findOne({ weekId: pending.weekId });
                if (tournament?.matches.length) {
                    const hasPlayedMatches = tournament.matches.some((match) => (
                        match.status === 'ongoing'
                        || (match.status === 'finished' && match.player1Id && match.player2Id)
                    ));
                    if (hasPlayedMatches) {
                        return res.status(409).json({ error: 'Entries cannot be approved after a match has started.' });
                    }
                    tournament.matches = [];
                    await tournament.save();
                }
            }

            const registration = await Registration.findOneAndUpdate(
                { _id: req.params.id, paymentStatus: 'pending' },
                { $set: {
                    paymentStatus: decision,
                    slotReserved: decision === 'approved',
                    ...(decision === 'approved'
                        ? { approvedAt: new Date(), passToken: crypto.randomBytes(32).toString('hex'), rejectionReason: null }
                        : { rejectedAt: new Date(), rejectionReason: reason.trim() }),
                } },
                { new: true },
            );
            if (!registration) {
                if (reservedWeekId !== null) await restoreReservedSlot(reservedWeekId);
                reservedWeekId = null;
                return res.status(409).json({ error: 'This registration was reviewed by another admin.' });
            }
            if (decision === 'rejected') {
                await restoreReservedSlot(pending.weekId);
            }
            reservedWeekId = null;
            const tournament = await WeeklyTournament.findOne({ weekId: pending.weekId });
            const fixturesGenerated = await maybeGenerateClosedTournamentFixtures(tournament);
            let notificationWarning = null;
            if (pending.playerId) {
                const tournamentName = tournament?.name || `Week ${pending.weekId + 1}`;
                notificationWarning = await tryCreatePlayerNotification(pending.playerId, {
                    type: 'registration',
                    title: decision === 'approved' ? 'Registration approved' : 'Registration update',
                    message: decision === 'approved'
                        ? `Your entry for ${tournamentName} has been approved. Your digital pass is available in your profile.`
                        : `Payment for ${pending.psnId || pending.playerName} (${tournamentName}) was rejected. Reason: ${reason.trim()}`,
                });
                if (decision === 'approved') {
                    const account = await Player.findById(pending.playerId);
                    await sendPassTelegram(account, registration);
                } else {
                    const account = await Player.findById(pending.playerId);
                    await notifyTelegram(account, `Your entry for ${tournamentName} was rejected. Reason: ${reason.trim()}`);
                }
            }
            return res.json({
                registration: publicRegistration(registration),
                fixturesGenerated,
                ...(notificationWarning ? { notificationWarning } : {}),
            });
        } catch (error) {
            if (reservedWeekId !== null) {
                try {
                    await restoreReservedSlot(reservedWeekId);
                } catch (rollbackError) {
                    console.error('Payment slot rollback failed:', rollbackError.message);
                }
            }
            return sendDatabaseError(res, error, 'Payment review could not be completed.');
        }
    });

    router.post('/admin/tournaments/:weekId/players', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        const { playerName, contact, telegramUsername = '', payment = 'cash' } = req.body || {};
        const parsedTelegramUsername = telegramUsername ? parseTelegramUsername(telegramUsername) : { username: '' };
        if (!Number.isInteger(weekId) || weekId < 0
            || typeof playerName !== 'string' || !playerName.trim() || playerName.trim().length > 60
            || typeof contact !== 'string' || !contact.trim() || contact.trim().length > 64 || !isValidContact(contact)
            || parsedTelegramUsername.error
            || !PAYMENT_METHODS.includes(payment)) {
            return res.status(400).json({ error: parsedTelegramUsername.error || 'Provide a player name, contact, and valid payment method.' });
        }
        let reservedWeekId = null;
        let registrationLock = null;
        let registrationLockName = '';
        let identityLockAcquired = false;
        try {
            const player = await ensurePlayer({
                contact: contact.trim(),
                displayName: playerName.trim(),
                telegramUsername: parsedTelegramUsername.username,
            });
            await linkPlayerRegistrations(player);
            registrationLock = await getPool().getConnection();
            registrationLockName = `pgz_active_${String(player._id)}`;
            const [lockRows] = await registrationLock.execute(
                'SELECT GET_LOCK(?, 5) AS acquired',
                [registrationLockName],
            );
            if (Number(lockRows[0]?.acquired) !== 1) {
                return res.status(503).json({ error: 'Registration is busy for this account. Please try again.' });
            }
            identityLockAcquired = await acquireRegistrationIdentityLock(registrationLock);
            if (!identityLockAcquired) {
                return res.status(503).json({ error: 'Registration is busy. Please try again shortly.' });
            }
            if (await activeTournamentWeekId(player._id) !== null) {
                return res.status(409).json({
                    error: 'This player is already active in another tournament.',
                });
            }
            const registrations = await Registration.findRows();
            const tournaments = await WeeklyTournament.findRows();
            const targetTournament = tournaments.find((item) => Number(item.weekId) === weekId);
            if (!targetTournament) return res.status(404).json({ error: 'Tournament not found.' });
            const candidate = {
                playerId: player._id,
                ownsAccount: true,
                playerName: playerName.trim(),
                contact: player.contact,
                telegramUsername: parsedTelegramUsername.username,
            };
            const activeIdentityWeekId = findActiveIdentityConflict(registrations, [candidate], weekId, tournaments);
            if (activeIdentityWeekId !== null) {
                return res.status(409).json({ error: 'This player is already active in another tournament.' });
            }
            if (findRegistrationIdentityConflict(registrations, [candidate], weekId, targetTournament)) {
                return res.status(409).json({ error: 'You are already registered for this active tournament.' });
            }
            const tournament = await WeeklyTournament.findOneAndUpdate(
                { weekId, status: { $in: ['open', 'full'] }, availableSlots: { $gt: 0 } },
                { $inc: { availableSlots: -1 }, $set: { status: 'open' } },
                { new: true },
            );
            if (!tournament) {
                const exists = await WeeklyTournament.exists({ weekId });
                if (!exists) return res.status(404).json({ error: 'Tournament not found.' });
                return res.status(409).json({ error: 'This tournament has no available player slots or is not upcoming.' });
            }
            reservedWeekId = weekId;
            const hasPlayedMatches = tournament.matches.some((match) => (
                match.status === 'ongoing'
                || (match.status === 'finished' && match.player1Id && match.player2Id)
            ));
            if (hasPlayedMatches) {
                await restoreReservedSlot(weekId);
                reservedWeekId = null;
                return res.status(409).json({ error: 'Players cannot be added after a match has started.' });
            }
            if (tournament.matches.length) {
                tournament.matches = [];
                await tournament.save();
            }
            if (tournament.availableSlots === 0) {
                tournament.status = 'full';
                await tournament.save();
            }
            const registration = await Registration.create({
                playerName: playerName.trim(),
                contact: contact.trim(),
                telegramUsername: parsedTelegramUsername.username,
                playerId: player._id,
                playerCode: player.playerCode,
                avatar: player.avatar,
                slotReserved: true,
                confirmationCode: `PG-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
                weekId,
                payment,
                paymentStatus: 'approved',
                approvedAt: new Date(),
                passToken: crypto.randomBytes(32).toString('hex'),
                checkInStatus: 'not_checked_in',
                readyStatus: 'not_ready',
            });
            reservedWeekId = null;
            await sendPassTelegram(player, registration);
            const approved = await Registration.find({ weekId, paymentStatus: 'approved' })
                .sort({ approvedAt: 1, createdAt: 1 });
            let fixturesGenerated = false;
            if (approved.length >= tournament.capacity && !tournament.matches.length) {
                for (const entry of approved) await attachPlayerToRegistration(entry);
                    tournament.matches = generateFixtures(approved.slice(0, tournament.capacity), Math.random, tournament.format || 'knockout');
                await tournament.save();
                fixturesGenerated = true;
            }
            return res.status(201).json({ registration: publicRegistration(registration), fixturesGenerated });
        } catch (error) {
            if (reservedWeekId !== null) {
                try {
                    await restoreReservedSlot(reservedWeekId);
                } catch (rollbackError) {
                    console.error('Manual player slot rollback failed:', rollbackError.message);
                }
            }
            return sendDatabaseError(res, error, 'Player could not be added.');
        } finally {
            if (registrationLock) {
                try {
                    if (identityLockAcquired) {
                        await registrationLock.execute('SELECT RELEASE_LOCK(?)', [REGISTRATION_IDENTITY_LOCK]);
                    }
                    if (registrationLockName) {
                        await registrationLock.execute('SELECT RELEASE_LOCK(?)', [registrationLockName]);
                    }
                } catch (error) {
                    console.error('Manual registration lock release failed:', error?.message || error);
                } finally {
                    registrationLock.release();
                }
            }
        }
    });

    router.delete('/admin/tournaments/:weekId/players/:id', requireTrustedOrigin, requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0 || !isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Provide a valid tournament and player.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId });
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const registration = await Registration.findOne({ _id: req.params.id, weekId });
            if (!registration) return res.status(404).json({ error: 'Player not found in this tournament.' });
            if (registration.paymentStatus === 'approved') {
                const hasPlayedMatches = tournament.matches.some((match) => (
                    match.status === 'ongoing'
                    || (match.status === 'finished' && match.player1Id && match.player2Id)
                ));
                if (hasPlayedMatches) {
                    return res.status(409).json({ error: 'Players cannot be removed after a match has started. Reset the tournament before changing its roster.' });
                }
                if (tournament.matches.length) tournament.matches = [];
            }
            await registration.deleteOne();
            if (registration.paymentStatus === 'approved' || registration.paymentStatus === 'pending') {
                tournament.availableSlots = Math.min(tournament.capacity, tournament.availableSlots + 1);
                if (tournament.status === 'full') tournament.status = 'open';
            }
            await tournament.save();
            return res.json({ removed: true, registrationId: registration.id });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player could not be removed.');
        }
    });

    router.get('/admin/roster/:weekId', requireAdmin, async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0) {
            return res.status(400).json({ error: 'Invalid tournament.' });
        }
        try {
            const tournament = await WeeklyTournament.findOne({ weekId }).lean();
            if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
            const registrations = await Registration.find({ weekId, paymentStatus: 'approved' })
                .sort({ approvedAt: 1 })
                .limit(tournament.capacity);
            for (const registration of registrations) await attachPlayerToRegistration(registration);
            const roster = Array.from({ length: tournament.capacity }, (_, index) => {
                const registration = registrations[index];
                return registration ? publicRegistration(registration, false) : null;
            });
            return res.json({ roster });
        } catch (error) {
            return sendDatabaseError(res, error, 'Player roster could not be loaded.');
        }
    });

    return router;
}

async function restoreReservedSlot(weekId) {
    const reopened = await WeeklyTournament.updateOne(
        { weekId, status: 'full', availableSlots: 0 },
        { $inc: { availableSlots: 1 }, $set: { status: 'open' } },
    );
    if (reopened.matchedCount === 0) {
        await WeeklyTournament.updateOne({ weekId }, { $inc: { availableSlots: 1 } });
    }
}

module.exports = {
    activeTournamentWeekIdFrom,
    advanceMatchWinner,
    checkInAvailabilityError,
    claimPaymentReceipt,
    currentPassStage,
    createAdminRouter,
    defaultPrizeTiers,
    generateFixtures,
    findActiveRegistration,
    findActiveIdentityConflict,
    findTelegramPlayer,
    listTelegramPlayerRegistrations,
    getTelegramPaymentAccounts,
    listTelegramTournaments,
    isValidContact,
    findRegistrationIdentityConflict,
    hasDifferentActiveTournament,
    normalizeContact,
    normalizePlayerName,
    normalizeTelegramUsername,
    registrationIsActive,
    registrationWasEliminated,
    registerPlayerForTournament,
    registerPlayersForTournament,
    registerTelegramPlayer,
    resubmitPlayerPayment,
    telegramUsernameConflict,
    parseRegistrationReceipt,
    parsePrizeDistribution,
    parseTelegramUsername,
    scheduledMatchForRegistration,
    linkTelegramUsername,
    nextPassStage,
    parseChatBackground,
    parseChatMessageInput,
    sendMatchDayReminders,
    shouldSendMatchReminder,
    setTelegramMessenger,
    setTelegramPassMessenger,
    tournamentStandings,
    normalizePrizeTiers,
};
