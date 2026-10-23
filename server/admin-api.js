const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const CAPACITY = 32;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const PAYMENT_METHODS = ['telebirr', 'cbe', 'abyssinia', 'awash', 'cash'];
const STATUSES = ['open', 'full', 'completed'];
const WEEK_NAMES = [
    'Prime Clash',
    'Mid-Month Showdown',
    'Ethiopia Elite Series',
    'Final Whistle Cup',
];
const WEEK_THEMES = ['gold', 'cyan', 'purple', 'emerald'];
const DEFAULT_REMAINING = [8, 18, 12, 24];
const TRANSIENT_DATABASE_ERRORS = new Set([
    'MongooseServerSelectionError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoNotConnectedError',
]);

const weekSchema = new mongoose.Schema({
    weekId: { type: Number, required: true, unique: true, min: 0, max: 3 },
    name: { type: String, required: true, maxlength: 80 },
    dateRange: { type: String, required: true, maxlength: 40 },
    capacity: { type: Number, default: CAPACITY, min: 1, max: CAPACITY },
    availableSlots: { type: Number, required: true, min: 0, max: CAPACITY },
    status: { type: String, enum: STATUSES, default: 'open' },
    theme: { type: String, enum: WEEK_THEMES, required: true },
}, { timestamps: true });

const registrationSchema = new mongoose.Schema({
    playerName: { type: String, required: true, trim: true, maxlength: 60 },
    contact: { type: String, required: true, trim: true, maxlength: 64 },
    psnId: { type: String, trim: true, maxlength: 64, default: '' },
    confirmationCode: { type: String, required: true, unique: true },
    weekId: { type: Number, required: true, min: 0, max: 3 },
    payment: { type: String, required: true, enum: PAYMENT_METHODS },
    receiptData: { type: String, default: '', select: false },
    paymentStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
}, { timestamps: true });

const WeeklyTournament = mongoose.models.WeeklyTournament
    || mongoose.model('WeeklyTournament', weekSchema);
const Registration = mongoose.models.TournamentRegistration
    || mongoose.model('TournamentRegistration', registrationSchema);

const sessions = new Map();
const loginAttempts = new Map();

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
            decodeURIComponent(cookie.slice(separator + 1).trim()),
        ];
    }).filter(([name]) => name));
}

function clientOrigins() {
    return [
        process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173',
        process.env.RENDER_EXTERNAL_URL,
        process.env.WEB_APP_URL,
    ]
        .flatMap((origin) => (origin || '').split(','))
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

function assertDatabase(req, res, next) {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Tournament database is unavailable.' });
    }
    return next();
}

function isDatabaseUnavailable(error) {
    return mongoose.connection.readyState !== 1
        || TRANSIENT_DATABASE_ERRORS.has(error?.name)
        || /buffering timed out/i.test(error?.message || '');
}

function sendDatabaseError(res, error, message) {
    const unavailable = isDatabaseUnavailable(error);
    console.error(`${message} failed:`, error?.name || 'DatabaseError');
    return res.status(unavailable ? 503 : 500).json({
        error: unavailable
            ? 'Tournament database is temporarily unavailable. Please try again shortly.'
            : message,
    });
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
    return WEEK_NAMES.map((name, weekId) => {
        const start = new Date(monthStart.getFullYear(), monthStart.getMonth(), weekId * 7 + 1);
        const end = new Date(monthStart.getFullYear(), monthStart.getMonth(), weekId * 7 + 7);
        return {
            weekId,
            name,
            dateRange: `${formatter.format(start)} - ${formatter.format(end)}`,
            capacity: CAPACITY,
            availableSlots: DEFAULT_REMAINING[weekId],
            status: 'open',
            theme: WEEK_THEMES[weekId],
        };
    });
}

async function ensureWeeks() {
    const defaults = nextMonthWeeks();
    const weeks = [];
    for (const week of defaults) {
        let saved = await WeeklyTournament.findOne({ weekId: week.weekId });
        if (!saved) {
            try {
                saved = await WeeklyTournament.create(week);
            } catch (error) {
                if (error.code !== 11000) throw error;
                saved = await WeeklyTournament.findOne({ weekId: week.weekId });
            }
        }
        weeks.push(saved);
    }
    return weeks;
}

function publicRegistration(registration) {
    return {
        id: registration._id,
        playerName: registration.playerName,
        contact: registration.contact,
        psnId: registration.psnId,
        confirmationCode: registration.confirmationCode,
        weekId: registration.weekId,
        payment: registration.payment,
        paymentStatus: registration.paymentStatus,
        createdAt: registration.createdAt,
        approvedAt: registration.approvedAt,
    };
}

function createAdminRouter() {
    const router = express.Router();

    router.get('/tournaments/weeks', assertDatabase, async (req, res) => {
        try {
            const weeks = await ensureWeeks();
            return res.json({ weeks });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament weeks could not be loaded.');
        }
    });

    router.post('/registrations', assertDatabase, async (req, res) => {
        const { playerName, contact, payment, weekId, receiptData } = req.body || {};
        const parsedWeekId = Number(weekId);
        if (typeof playerName !== 'string' || !playerName.trim() || playerName.length > 60
            || typeof contact !== 'string' || !contact.trim() || contact.length > 64
            || !PAYMENT_METHODS.includes(payment)
            || !Number.isInteger(parsedWeekId) || parsedWeekId < 0 || parsedWeekId > 3) {
            return res.status(400).json({ error: 'Enter valid player, contact, payment, and week details.' });
        }
        if (receiptData && (typeof receiptData !== 'string'
            || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(receiptData)
            || receiptData.length > 7_000_000)) {
            return res.status(400).json({ error: 'Receipt must be a PNG, JPG, or WebP image up to 5 MB.' });
        }

        try {
            await ensureWeeks();
            const week = await WeeklyTournament.findOne({ weekId: parsedWeekId });
            if (!week || week.status !== 'open' || week.availableSlots < 1) {
                return res.status(409).json({ error: 'This tournament week is not accepting registrations.' });
            }
            const pendingRegistrations = await Registration.countDocuments({
                weekId: parsedWeekId,
                paymentStatus: 'pending',
            });
            if (pendingRegistrations >= week.availableSlots) {
                return res.status(409).json({ error: 'This tournament week has reached its registration limit.' });
            }
            const registration = await Registration.create({
                playerName: playerName.trim(),
                contact: contact.trim(),
                psnId: /^(?:\+?\d[\d\s()-]{6,}|[\w-]{3,})$/.test(contact.trim())
                    && !/^\+?\d[\d\s()-]+$/.test(contact.trim()) ? contact.trim() : '',
                confirmationCode: `PG-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
                weekId: parsedWeekId,
                payment,
                receiptData: receiptData || '',
            });
            return res.status(201).json({
                registration: publicRegistration(registration),
                message: 'Registration request saved. Payment approval is pending.',
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Registration could not be saved. Please try again.');
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
        res.set('Set-Cookie', `prime_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`);
        return res.json({ authenticated: true, expiresIn: SESSION_LIFETIME_MS });
    });

    router.get('/admin/session', requireAdmin, (req, res) => res.json({ authenticated: true }));

    router.delete('/admin/session', requireTrustedOrigin, requireAdmin, (req, res) => {
        const token = parseCookies(req.headers.cookie).prime_admin_session;
        sessions.delete(token);
        res.set('Set-Cookie', 'prime_admin_session=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0');
        return res.json({ authenticated: false });
    });

    router.use('/admin', requireAdmin, assertDatabase);

    router.get('/admin/weeks', async (req, res) => {
        try {
            const weeks = await ensureWeeks();
            return res.json({ weeks });
        } catch (error) {
            return sendDatabaseError(res, error, 'Tournament weeks could not be loaded.');
        }
    });

    router.patch('/admin/weeks/:weekId', requireTrustedOrigin, async (req, res) => {
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

    router.get('/admin/registrations', async (req, res) => {
        const filter = {};
        if (req.query.week !== undefined) {
            const weekId = Number(req.query.week);
            if (!Number.isInteger(weekId) || weekId < 0 || weekId > 3) {
                return res.status(400).json({ error: 'Invalid tournament week.' });
            }
            filter.weekId = weekId;
        }
        try {
            const registrations = await Registration.find(filter)
                .select('+receiptData')
                .sort({ createdAt: -1 })
                .limit(500)
                .lean();
            return res.json({
                registrations: registrations.map((registration) => ({
                    ...publicRegistration(registration),
                    receiptData: registration.receiptData || '',
                })),
            });
        } catch (error) {
            return sendDatabaseError(res, error, 'Registrations could not be loaded.');
        }
    });

    router.post('/admin/registrations/:id/review', requireTrustedOrigin, async (req, res) => {
        const { decision } = req.body || {};
        if (!mongoose.isValidObjectId(req.params.id) || !['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: 'Provide a valid registration and review decision.' });
        }
        let reservedWeekId = null;
        try {
            const pending = await Registration.findOne({ _id: req.params.id, paymentStatus: 'pending' });
            if (!pending) return res.status(409).json({ error: 'This registration has already been reviewed.' });

            if (decision === 'approved') {
                const reservedWeek = await WeeklyTournament.findOneAndUpdate(
                    { weekId: pending.weekId, status: 'open', availableSlots: { $gt: 0 } },
                    { $inc: { availableSlots: -1 } },
                    { new: true },
                );
                if (!reservedWeek) {
                    return res.status(409).json({ error: 'No open slot remains for this tournament week.' });
                }
                reservedWeekId = pending.weekId;
                if (reservedWeek.availableSlots === 0) {
                    reservedWeek.status = 'full';
                    await reservedWeek.save();
                }
            }

            const registration = await Registration.findOneAndUpdate(
                { _id: req.params.id, paymentStatus: 'pending' },
                { $set: {
                    paymentStatus: decision,
                    ...(decision === 'approved' ? { approvedAt: new Date() } : { rejectedAt: new Date() }),
                } },
                { new: true },
            );
            if (!registration) {
                if (reservedWeekId !== null) await restoreReservedSlot(reservedWeekId);
                reservedWeekId = null;
                return res.status(409).json({ error: 'This registration was reviewed by another admin.' });
            }
            reservedWeekId = null;
            return res.json({ registration: publicRegistration(registration) });
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

    router.get('/admin/roster/:weekId', async (req, res) => {
        const weekId = Number(req.params.weekId);
        if (!Number.isInteger(weekId) || weekId < 0 || weekId > 3) {
            return res.status(400).json({ error: 'Invalid tournament week.' });
        }
        try {
            const registrations = await Registration.find({ weekId, paymentStatus: 'approved' })
                .sort({ approvedAt: 1 })
                .limit(CAPACITY)
                .lean();
            const roster = Array.from({ length: CAPACITY }, (_, index) => {
                const registration = registrations[index];
                return registration ? publicRegistration(registration) : null;
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

module.exports = { createAdminRouter };
