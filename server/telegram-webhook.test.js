const assert = require('node:assert/strict');
const { test } = require('node:test');
const { discoverNgrokPublicUrl, findNgrokPublicUrl, initializeTelegramWebhook } = require('./telegram-webhook');

test('selects only the HTTPS Ngrok tunnel targeting Vite port 5173', () => {
    const tunnels = [
        { proto: 'https', public_url: 'https://api.example.ngrok-free.app', config: { addr: 'http://localhost:5000' } },
        { proto: 'http', public_url: 'http://client.example.ngrok-free.app', config: { addr: 'localhost:5173' } },
        { proto: 'https', public_url: 'https://client.example.ngrok-free.app/', config: { addr: 'localhost:5173' } },
    ];

    assert.equal(findNgrokPublicUrl(tunnels), 'https://client.example.ngrok-free.app');
    assert.equal(findNgrokPublicUrl(tunnels, 5000), 'https://api.example.ngrok-free.app');
    assert.equal(findNgrokPublicUrl(tunnels, 3000), null);
});

test('discovers the live client tunnel from Ngrok local API', async () => {
    const publicUrl = await discoverNgrokPublicUrl({
        apiUrl: 'http://ngrok.test/api/tunnels',
        fetchImpl: async (url) => {
            assert.equal(url, 'http://ngrok.test/api/tunnels');
            return {
                ok: true,
                json: async () => ({ tunnels: [{
                    proto: 'https',
                    public_url: 'https://prime.example.ngrok-free.app',
                    config: { addr: 'http://127.0.0.1:5173' },
                }] }),
            };
        },
    });

    assert.equal(publicUrl, 'https://prime.example.ngrok-free.app');
});

test('registers Telegram webhook with the guarded endpoint and secret', async () => {
    const calls = [];
    let commands = [];
    const bot = {
        telegram: {
            getMe: async () => ({ id: 123, username: 'prime_test_bot' }),
            setWebhook: async (...args) => calls.push(args),
            setMyCommands: async (items) => { commands = items; },
        },
    };

    const result = await initializeTelegramWebhook({
        bot,
        publicUrl: 'https://prime.example.ngrok-free.app/',
        secretToken: 'test-secret_123',
    });

    assert.equal(result.webhookUrl, 'https://prime.example.ngrok-free.app/api/telegram/webhook');
    assert.deepEqual(calls, [[
        'https://prime.example.ngrok-free.app/api/telegram/webhook',
        {
            secret_token: 'test-secret_123',
            drop_pending_updates: false,
            allowed_updates: ['message', 'callback_query'],
        },
    ]]);
    assert.deepEqual(commands.map(({ command }) => command), [
        'start', 'register', 'tournaments', 'myregistrations', 'help', 'cancel',
    ]);
    assert.equal(bot.botInfo.username, 'prime_test_bot');
});

test('rejects invalid URLs and webhook secrets before calling Telegram', async () => {
    const bot = { telegram: { getMe: async () => assert.fail('should not call Telegram') } };

    await assert.rejects(initializeTelegramWebhook({ bot, publicUrl: 'http://localhost:5173', secretToken: 'secret' }), /HTTPS URL/);
    await assert.rejects(initializeTelegramWebhook({ bot, publicUrl: 'https://public.example', secretToken: 'not valid' }), /WEBHOOK_SECRET/);
});