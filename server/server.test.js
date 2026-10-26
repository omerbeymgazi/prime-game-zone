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

test('registration rejects missing receipt, invalid Telegram username, and retired bank methods', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const url = `http://127.0.0.1:${server.address().port}/api/registrations`;
        const submit = (body) => fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerName: 'Test Player',
                contact: '0912345678',
                telegramUsername: '@valid_name',
                payment: 'cbe',
                weekId: 0,
                ...body,
            }),
        });

        const missingReceipt = await submit({});
        assert.equal(missingReceipt.status, 400);
        assert.match((await missingReceipt.json()).error, /upload a payment receipt/i);

        const invalidTelegram = await submit({
            telegramUsername: 'invalid-handle',
            receiptData: `data:image/png;base64,${Buffer.from('receipt').toString('base64')}`,
        });
        assert.equal(invalidTelegram.status, 400);
        assert.match((await invalidTelegram.json()).error, /Telegram username/i);

        const retiredBankMethod = await submit({
            payment: 'abyssinia',
            receiptData: `data:image/png;base64,${Buffer.from('receipt').toString('base64')}`,
        });
        assert.equal(retiredBankMethod.status, 400);
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

test('Telegram /start handler replies with the welcome message and configured Mini App button', async () => {
    const miniAppUrl = 'https://emmaline-nasopharyngeal-variously.ngrok-free.dev';
    const bot = createBot('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', miniAppUrl);
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
    assert.match(request.payload.text, /ሰላም Hana!/);
    assert.equal(request.payload.reply_markup.inline_keyboard[0][0].web_app.url, miniAppUrl);
});
