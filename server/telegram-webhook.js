const NGROK_API_URL = process.env.NGROK_API_URL || 'http://127.0.0.1:4040/api/tunnels';

function tunnelPort(tunnel) {
    const address = String(tunnel.config?.addr || '');
    const normalized = /^https?:\/\//i.test(address) ? address : `http://${address}`;
    try {
        const parsed = new URL(normalized);
        if (parsed.port) return Number(parsed.port);
    } catch {}
    const match = address.match(/(?:^|:)(\d{2,5})$/);
    return match ? Number(match[1]) : null;
}

function findNgrokPublicUrl(tunnels, port = 5173) {
    const tunnel = (tunnels || []).find((candidate) => (
        candidate.proto === 'https'
        && tunnelPort(candidate) === Number(port)
        && /^https:\/\//i.test(candidate.public_url || '')
    ));
    return tunnel ? tunnel.public_url.replace(/\/+$/, '') : null;
}

async function discoverNgrokPublicUrl({ fetchImpl = fetch, apiUrl = NGROK_API_URL, port = 5173 } = {}) {
    const response = await fetchImpl(apiUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Ngrok local API returned ${response.status}.`);
    const data = await response.json();
    return findNgrokPublicUrl(data.tunnels, port);
}

async function initializeTelegramWebhook({ bot, publicUrl, secretToken }) {
    const baseUrl = String(publicUrl || '').replace(/\/+$/, '');
    if (!/^https:\/\//i.test(baseUrl)) throw new Error('Telegram webhook requires a public HTTPS URL.');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secretToken || '')) {
        throw new Error('TELEGRAM_WEBHOOK_SECRET must be 1–256 URL-safe characters.');
    }
    const botInfo = await bot.telegram.getMe();
    bot.botInfo = botInfo;
    const webhookUrl = `${baseUrl}/api/telegram/webhook`;
    await bot.telegram.setWebhook(webhookUrl, {
        secret_token: secretToken,
        drop_pending_updates: false,
        allowed_updates: ['message', 'callback_query'],
    });
    await bot.telegram.setMyCommands([
        { command: 'start', description: 'Open the Prime Gaming chat menu' },
        { command: 'register', description: 'Register for an open tournament' },
        { command: 'tournaments', description: 'List open tournaments' },
        { command: 'myregistrations', description: 'Check payment and registration status' },
        { command: 'help', description: 'Show chat registration help' },
        { command: 'cancel', description: 'Cancel the current checkout' },
    ]);
    return { botInfo, webhookUrl };
}

module.exports = { discoverNgrokPublicUrl, findNgrokPublicUrl, initializeTelegramWebhook };