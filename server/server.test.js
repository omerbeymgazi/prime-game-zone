const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.WEB_APP_URL = 'https://emmaline-nasopharyngeal-variously.ngrok-free.dev';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.STAFF_USERNAME = 'test-staff';
process.env.STAFF_PASSWORD = 'test-staff-password';

const { app, createBot } = require('./server');

test('health endpoint and CORS are available while XAMPP MySQL is not connected', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const address = server.address();
        const healthUrl = `http://127.0.0.1:${address.port}/api/health`;
        const healthResponse = await fetch(healthUrl);
        assert.equal(healthResponse.status, 200);
        assert.equal((await healthResponse.json()).databaseStatus, 'disconnected');

        for (const origin of [
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'https://emmaline-nasopharyngeal-variously.ngrok-free.dev',
        ]) {
            const response = await fetch(healthUrl, { headers: { Origin: origin } });
            assert.equal(response.headers.get('access-control-allow-origin'), origin);
        }
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('Telegram webhook rejects updates without its configured secret', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/telegram/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ update_id: 1 }),
        });
        assert.equal(response.status, 401);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('individual registration requires an authenticated player session', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const url = `http://127.0.0.1:${server.address().port}/api/registrations`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerName: 'Test Player',
                contact: '0912345678',
                telegramUsername: '@valid_name',
                payment: 'cbe',
                weekId: 0,
            }),
        });
        assert.equal(response.status, 401);
        assert.match((await response.json()).error, /sign-in is required/i);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('admin login sets an HttpOnly session cookie accepted by session validation and logout', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
        const origin = 'http://localhost:5173';

        const unauthenticated = await fetch(`${baseUrl}/session`);
        assert.equal(unauthenticated.status, 401);

        const loginResponse = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                Origin: origin,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
        });
        assert.equal(loginResponse.status, 200);
        assert.deepEqual(await loginResponse.json(), { authenticated: true, expiresIn: 8 * 60 * 60 * 1000 });

        const cookie = loginResponse.headers.get('set-cookie');
        assert.match(cookie, /prime_admin_session=[a-f0-9]{64}/);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /Path=\/api(?:;|$)/i);
        const cookiePair = cookie.split(';', 1)[0];

        const sessionResponse = await fetch(`${baseUrl}/session`, {
            headers: { Cookie: cookiePair },
        });
        assert.equal(sessionResponse.status, 200);
        assert.deepEqual(await sessionResponse.json(), { authenticated: true });

        const logoutResponse = await fetch(`${baseUrl}/session`, {
            method: 'DELETE',
            headers: { Cookie: cookiePair, Origin: origin },
        });
        assert.equal(logoutResponse.status, 200);
        assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);

        const expiredSession = await fetch(`${baseUrl}/session`, {
            headers: { Cookie: cookiePair },
        });
        assert.equal(expiredSession.status, 401);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('staff session is isolated from admin routes and can access the staff API', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const root = `http://127.0.0.1:${server.address().port}/api`;
        const origin = 'http://localhost:5173';
        const loggedOutSession = await fetch(`${root}/staff/session`);
        assert.equal(loggedOutSession.status, 200);
        assert.deepEqual(await loggedOutSession.json(), { authenticated: false });

        const login = await fetch(`${root}/staff/login`, {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'test-staff', password: 'test-staff-password' }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';', 1)[0];

        const session = await fetch(`${root}/staff/session`, { headers: { Cookie: cookie } });
        assert.equal(session.status, 200);
        assert.deepEqual(await session.json(), { authenticated: true });

        const adminFinance = await fetch(`${root}/admin/finance`, { headers: { Cookie: cookie } });
        assert.equal(adminFinance.status, 401);

        const invalidPass = await fetch(`${root}/staff/check-in`, {
            method: 'POST',
            headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ passToken: 'not-a-pass' }),
        });
        assert.equal(invalidPass.status, 400);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('player session reports logged-out state without requiring MySQL', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const root = `http://127.0.0.1:${server.address().port}/api/player`;
        const response = await fetch(`${root}/session`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { authenticated: false });
        const passCode = await fetch(`${root}/registrations/test-registration/pass-code`);
        assert.equal(passCode.status, 401);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('payment rejection requires a reason before database review', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const root = `http://127.0.0.1:${server.address().port}/api`;
        const origin = 'http://localhost:5173';
        const login = await fetch(`${root}/admin/login`, {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';', 1)[0];
        const response = await fetch(`${root}/admin/payment-groups/test-group/review`, {
            method: 'POST',
            headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'rejected', reason: '  ' }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /rejection reason/i);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('database-backed endpoints explicitly report unavailable MySQL', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tournaments/weeks`);
        assert.equal(response.status, 503);
        assert.match((await response.json()).error, /Start XAMPP MySQL/);
        const leaderboard = await fetch(`http://127.0.0.1:${server.address().port}/api/leaderboard`);
        assert.equal(leaderboard.status, 503);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('player registration validates optional Telegram usernames', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/player/register`, {
            method: 'POST',
            headers: {
                Origin: 'http://localhost:5173',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                displayName: 'Test Player',
                contact: 'test-contact',
                password: 'correct-horse-battery',
                telegramUsername: '@bad-name',
            }),
        });
        assert.equal(response.status, 400);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('notification endpoints require an authenticated player session', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const apiUrl = `http://127.0.0.1:${server.address().port}/api/player/notifications`;
        const getResponse = await fetch(apiUrl);
        assert.equal(getResponse.status, 401);
        assert.match((await getResponse.json()).error, /sign-in is required/i);

        const markResponse = await fetch(`${apiUrl}/1/read`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
        });
        assert.equal(markResponse.status, 401);

        const announcementResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/notifications`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Announcement', message: 'Test' }),
        });
        assert.equal(announcementResponse.status, 401);

        const adminPlayersResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/players`);
        assert.equal(adminPlayersResponse.status, 401);

        const directMessageResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/notifications/direct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerId: '0123456789abcdef01234567', title: 'Match update', message: 'Kickoff is at 18:00.' }),
        });
        assert.equal(directMessageResponse.status, 401);

        const fixtureWriteResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/tournaments/0/fixtures`, {
            method: 'POST',
        });
        assert.equal(fixtureWriteResponse.status, 401);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('chat, dispute, and finance routes enforce player or organizer sessions', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const root = `http://127.0.0.1:${server.address().port}/api`;
        for (const route of ['/player/chat', '/player/disputes']) {
            const response = await fetch(`${root}${route}`);
            assert.equal(response.status, 401, `${route} must require a player session`);
        }
        for (const [route, method] of [
            ['/player/chat/status', 'GET'],
            ['/player/chat/background', 'GET'],
            ['/player/chat/background', 'PUT'],
            ['/player/chat/background', 'DELETE'],
            ['/player/chat/typing', 'POST'],
            ['/player/chat/report', 'POST'],
            ['/player/chat/messages/1', 'PATCH'],
            ['/player/chat/messages/1', 'DELETE'],
            ['/player/chat/messages/1/pin', 'PUT'],
            ['/player/chat/messages/1/reactions', 'POST'],
            ['/player/chat/messages/1/attachment', 'GET'],
        ]) {
            const response = await fetch(`${root}${route}`, { method });
            assert.equal(response.status, 401, `${method} ${route} must require a player session`);
        }

        const playerPost = await fetch(`${root}/player/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'hello' }),
        });
        assert.equal(playerPost.status, 401);

        for (const route of ['/admin/chats', '/admin/disputes', '/admin/finance']) {
            const response = await fetch(`${root}${route}`);
            assert.equal(response.status, 401, `${route} must require an admin session`);
        }

        const adminReply = await fetch(`${root}/admin/chats/0123456789abcdef01234567`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'reply' }),
        });
        assert.equal(adminReply.status, 401);

        for (const [route, method] of [
            ['/admin/chat/background', 'GET'],
            ['/admin/chat/background', 'PUT'],
            ['/admin/chat/background', 'DELETE'],
            ['/admin/chats/0123456789abcdef01234567/typing', 'POST'],
            ['/admin/chats/0123456789abcdef01234567/messages/1', 'PATCH'],
            ['/admin/chats/0123456789abcdef01234567/messages/1', 'DELETE'],
            ['/admin/chats/0123456789abcdef01234567/messages/1/pin', 'PUT'],
            ['/admin/chats/0123456789abcdef01234567/messages/1/reactions', 'POST'],
            ['/admin/chats/0123456789abcdef01234567/messages/1/attachment', 'GET'],
            ['/admin/chats/0123456789abcdef01234567/moderation', 'PATCH'],
        ]) {
            const response = await fetch(`${root}${route}`, { method });
            assert.equal(response.status, 401, `${method} ${route} must require an admin session`);
        }
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

test('Telegram /start handler replies with inline chat actions and no Web App button', async () => {
    const bot = createBot('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi');
    bot.botInfo = { id: 123456789, is_bot: true, first_name: 'Test', username: 'testbot' };
    let request;
    const telegramPrototype = Object.getPrototypeOf(bot.telegram);
    const originalCallApi = telegramPrototype.callApi;
    telegramPrototype.callApi = async function (method, payload) {
        request = { method, payload };
        return { message_id: 1, date: 0, chat: { id: 42 } };
    };
    try {
        await bot.handleUpdate({
            update_id: 1,
            message: {
                message_id: 1,
                from: { id: 42, is_bot: false, first_name: 'Hana' },
                chat: { id: 42, type: 'private' },
                date: 0,
                text: '/start',
                entities: [{ type: 'bot_command', offset: 0, length: 6 }],
            },
        });
    } finally {
        telegramPrototype.callApi = originalCallApi;
    }

    assert.equal(request.method, 'sendMessage');
    assert.match(request.payload.text, /🎮 እንኳን ወደ Prime Game Zone በደህና መጡ! 🏆/);
    assert.match(request.payload.text, /\/tournaments.*\/register.*\/myregistrations.*\/help/s);
    assert.equal(request.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prime:register');
    assert.equal(JSON.stringify(request.payload.reply_markup).includes('web_app'), false);
});

test('Telegram chat completes profile linking, tournament/payment selection, and screenshot registration', async () => {
    let linked = false;
    let submittedGroup = null;
    let resubmittedPayment = null;
    const sentMessages = [];
    const rejectedRegistrationId = '0123456789abcdef01234567';
    const bot = createBot('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', {
        findTelegramPlayer: async () => linked ? {
            id: 'player-1',
            playerCode: 'PGZ001',
            displayName: 'Hana Player',
            contact: '0912345678',
            telegramUsername: 'hana_player',
        } : null,
        registerTelegramPlayer: async () => {
            linked = true;
            return { id: 'player-1', playerCode: 'PGZ001' };
        },
        listTelegramTournaments: async () => [{
            weekId: 2,
            name: 'Prime Ethiopia Cup 3',
            availableSlots: 8,
            entryFee: 1500,
        }],
        getTelegramPaymentAccounts: async () => [
            { type: 'cbe', number: '1000123456789' },
            { type: 'telebirr', number: '0912345678' },
        ],
        listTelegramPlayerRegistrations: async () => [{
            id: rejectedRegistrationId,
            weekId: 2,
            playerName: 'Hana Player',
            paymentStatus: 'rejected',
            rejectionReason: 'Receipt was unreadable.',
            payment: 'telebirr',
        }],
        registerPlayersForTournament: async (checkout) => {
            submittedGroup = checkout;
            return {
                registrations: checkout.participants.map((participant, index) => ({
                    playerName: participant.playerName,
                    confirmationCode: `PG-TEST${index + 1}`,
                })),
                tournament: { name: 'Prime Ethiopia Cup 3' },
            };
        },
        resubmitPlayerPayment: async (checkout) => {
            resubmittedPayment = checkout;
            return { registrations: [] };
        },
        fetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('receipt-image') }),
    });
    bot.botInfo = { id: 123456789, is_bot: true, first_name: 'Test', username: 'testbot' };
    const telegramPrototype = Object.getPrototypeOf(bot.telegram);
    const originalCallApi = telegramPrototype.callApi;
    telegramPrototype.callApi = async function (method, payload) {
        sentMessages.push({ method, payload });
        return method === 'getFile'
            ? { file_path: 'photos/receipt.jpg' }
            : { message_id: sentMessages.length, date: 0, chat: { id: 42 } };
    };

    const from = { id: 42, is_bot: false, first_name: 'Hana', username: 'hana_player' };
    let updateId = 10;
    const message = (content) => ({
        update_id: updateId++,
        message: { message_id: updateId, from, chat: { id: 42, type: 'private' }, date: 0, ...content },
    });
    const callback = (data) => ({
        update_id: updateId++,
        callback_query: {
            id: `callback-${updateId}`,
            from,
            message: { message_id: updateId, chat: { id: 42, type: 'private' } },
            data,
        },
    });

    try {
        await bot.handleUpdate(message({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }));
        await bot.handleUpdate(callback('prime:register'));
        await bot.handleUpdate(message({
            contact: { phone_number: '0912345678', user_id: 42 },
        }));
        await bot.handleUpdate(message({ text: 'Hana Player' }));
        await bot.handleUpdate(callback('prime:register'));
        await bot.handleUpdate(callback('prime:tournament:2'));
        await bot.handleUpdate(callback('prime:payment:2:telebirr'));
        await bot.handleUpdate(callback('prime:participant:self'));
        await bot.handleUpdate(callback('prime:participant:add'));
        await bot.handleUpdate(message({ text: 'Other Player' }));
        await bot.handleUpdate(message({ text: '0923456789' }));
        await bot.handleUpdate(message({ text: '@other_player' }));
        await bot.handleUpdate(callback('prime:participants:continue'));
        await bot.handleUpdate(message({
            photo: [{ file_id: 'photo-small' }, { file_id: 'photo-large' }],
        }));
        await bot.handleUpdate(callback('prime:registrations'));
        await bot.handleUpdate(callback(`prime:appeal:${rejectedRegistrationId}`));
        await bot.handleUpdate(callback(`prime:appeal-payment:${rejectedRegistrationId}:cbe`));
        await bot.handleUpdate(message({
            photo: [{ file_id: 'appeal-small' }, { file_id: 'appeal-large' }],
        }));
    } finally {
        telegramPrototype.callApi = originalCallApi;
    }

    assert.ok(sentMessages.some(({ payload }) => payload.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === 'prime:register')));
    assert.ok(sentMessages.some(({ payload }) => payload.reply_markup?.inline_keyboard?.flat().some((button) => /Add Another Player/.test(button.text || ''))));
    assert.equal(sentMessages.some(({ payload }) => JSON.stringify(payload.reply_markup || {}).includes('web_app')), false);
    assert.equal(submittedGroup.playerId, 'player-1');
    assert.equal(submittedGroup.weekId, 2);
    assert.equal(submittedGroup.payment, 'telebirr');
    assert.equal(submittedGroup.participants.length, 2);
    assert.equal(submittedGroup.participants[0].isAccountOwner, true);
    assert.equal(submittedGroup.participants[1].playerName, 'Other Player');
    assert.equal(submittedGroup.participants[1].contact, '0923456789');
    assert.match(submittedGroup.receiptData, /^data:image\/jpeg;base64,/);
    assert.equal(resubmittedPayment.playerId, 'player-1');
    assert.equal(resubmittedPayment.registrationId, rejectedRegistrationId);
    assert.equal(resubmittedPayment.payment, 'cbe');
    assert.match(resubmittedPayment.receiptData, /^data:image\/jpeg;base64,/);
});
