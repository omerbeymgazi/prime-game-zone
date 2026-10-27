const test = require('node:test');
const assert = require('node:assert/strict');
const { activeTournamentWeekIdFrom, advanceMatchWinner, checkInAvailabilityError, claimPaymentReceipt, currentPassStage, defaultPrizeTiers, findActiveIdentityConflict, findRegistrationIdentityConflict, generateFixtures, hasDifferentActiveTournament, isValidContact, nextPassStage, normalizeContact, normalizePrizeTiers, normalizeTelegramUsername, parseChatBackground, parseChatMessageInput, parsePrizeDistribution, parseRegistrationReceipt, parseTelegramUsername, registrationWasEliminated, scheduledMatchForRegistration, shouldSendMatchReminder, telegramUsernameConflict, tournamentStandings } = require('./admin-api');
const { MySqlModel } = require('./mysql-store');

function player(id) {
    return {
        _id: id,
        playerName: `Player ${id}`,
        contact: `contact-${id}`,
        psnId: '',
        confirmationCode: `PG-${id}`,
        weekId: 0,
        payment: 'cash',
        paymentStatus: 'approved',
    };
}

test('digital pass stages advance only through check-in, play-off, and end of play', () => {
    assert.equal(currentPassStage({ checkInStatus: 'not_checked_in' }), 'not_started');
    assert.equal(currentPassStage({ checkInStatus: 'checked_in' }), 'check_in');
    assert.equal(nextPassStage('not_started'), 'check_in');
    assert.equal(nextPassStage('check_in'), 'play_off');
    assert.equal(nextPassStage('play_off'), 'end_of_play');
    assert.equal(nextPassStage('end_of_play'), null);
});

test('digital pass check-in is limited to the assigned match time and finds the player fixture', () => {
    const scheduledAt = '2030-06-15T10:00:00.000Z';
    const match = {
        matchId: 'r1m1',
        player1Id: 'registration-1',
        player2Id: 'registration-2',
        scheduledAt,
        location: 'Court A',
    };
    const tournament = { matches: [match] };

    assert.equal(scheduledMatchForRegistration(tournament, 'registration-1'), match);
    assert.equal(scheduledMatchForRegistration(tournament, 'registration-3'), null);
    assert.match(checkInAvailabilityError(match, Date.parse('2030-06-15T09:59:59.999Z')), /come back at their match time/i);
    assert.match(checkInAvailabilityError(match, Date.parse('2030-06-15T09:59:59.999Z')), /Court A/);
    assert.equal(checkInAvailabilityError(match, Date.parse(scheduledAt)), null);
    assert.equal(checkInAvailabilityError(match, Date.parse('2030-06-15T10:01:00.000Z')), null);
    assert.equal(checkInAvailabilityError(null, Date.parse('2030-06-15T09:00:00.000Z')), null);
});

test('registration requires a supported receipt image and a valid Telegram username', () => {
    const receiptData = `data:image/png;base64,${Buffer.from('receipt').toString('base64')}`;
    const receipt = parseRegistrationReceipt(receiptData);
    assert.equal(receipt.mime, 'image/png');
    assert.equal(receipt.buffer.toString(), 'receipt');
    assert.match(parseRegistrationReceipt('').error, /upload a payment receipt/i);
    assert.match(parseRegistrationReceipt('data:image/svg+xml;base64,PHN2Zz4=').error, /PNG, JPG, or WebP/i);
    assert.equal(parseTelegramUsername('@Player_1').username, 'player_1');
    assert.match(parseTelegramUsername('bad-name').error, /Telegram username/i);
    assert.match(parseTelegramUsername('').error, /Telegram username/i);
});

test('prize tiers preserve a legacy split and validate expandable rank distributions', () => {
    assert.deepEqual(defaultPrizeTiers(20000).map((tier) => tier.amount), [10000, 5000, 3000, 2000]);
    const distribution = parsePrizeDistribution([
        { rank: 1, amount: 12000, reward: 'Trophy' },
        { rank: 2, amount: 6000, reward: '' },
        { rank: 3, amount: 3000, reward: 'Controller' },
        { rank: 4, amount: 1000, reward: '' },
        { rank: 5, amount: 500, reward: '' },
    ]);
    assert.equal(distribution.prizePool, 22500);
    assert.equal(distribution.prizeTiers.length, 5);
    assert.equal(normalizePrizeTiers([{ rank: 2, amount: 100, reward: '' }]), null);
    assert.equal(parsePrizeDistribution([{ rank: 1, amount: 10_000_001, reward: '' }]), null);
});

test('match reminders are eligible only in the 15-minute window and once per schedule', () => {
    const now = Date.parse('2030-06-15T10:00:00.000Z');
    const match = {
        scheduledAt: '2030-06-15T10:15:00.000Z',
        status: 'pending',
        player1Id: 'player-1',
        player2Id: 'player-2',
    };
    assert.equal(shouldSendMatchReminder(match, now - 1), false);
    assert.equal(shouldSendMatchReminder(match, now), true);
    assert.equal(shouldSendMatchReminder({ ...match, reminderSentFor: match.scheduledAt }, now), false);
    assert.equal(shouldSendMatchReminder({ ...match, status: 'ongoing' }, now), false);
    assert.equal(shouldSendMatchReminder(match, Date.parse(match.scheduledAt)), false);
});

test('bulk registration insert writes a 128-player group in one query', async () => {
    const calls = [];
    const connection = {
        execute: async (...args) => {
            calls.push(args);
            return [{ affectedRows: 128 }, []];
        },
    };
    const registrations = new MySqlModel('registrations', {
        unique: ['confirmationCode'],
    });
    const participants = Array.from({ length: 128 }, (_, index) => ({
        playerName: `Player ${index + 1}`,
        confirmationCode: `PG-${index + 1}`,
    }));

    const inserted = await registrations.insertMany(participants, { ordered: false, connection });

    assert.equal(calls.length, 1);
    assert.equal((calls[0][0].match(/\(\?, \?, \?, \?, \?\)/g) || []).length, 128);
    assert.equal(calls[0][1].length, 128 * 5);
    assert.equal(inserted.length, 128);
    assert.equal(inserted[127].playerName, 'Player 128');
    assert.equal(JSON.parse(calls[0][1][127 * 5 + 1]).confirmationCode, 'PG-128');
});

test('active tournament lookup normalizes week IDs and ignores concluded or unknown statuses', () => {
    const registrations = [
        { weekId: '4', paymentStatus: 'pending' },
        { weekId: 5, paymentStatus: 'approved' },
        { weekId: 'invalid', paymentStatus: 'pending' },
    ];
    const tournaments = [
        { weekId: 4, status: 'completed' },
        { weekId: '5', status: 'live' },
    ];

    assert.equal(activeTournamentWeekIdFrom(registrations, tournaments), 5);
    assert.equal(activeTournamentWeekIdFrom([{ weekId: '4' }], [
        { weekId: 4, status: 'completed' },
        { weekId: 6, status: 'unexpected' },
    ]), null);
});

test('same-week registration is not mislabeled as a cross-tournament conflict', () => {
    assert.equal(hasDifferentActiveTournament('5', 5), false);
    assert.equal(hasDifferentActiveTournament(5, 6), true);
    assert.equal(hasDifferentActiveTournament(null, 6), false);
});

test('active tournament duplicate checks bind phone, name, Telegram, and account identity', () => {
    const tournament = { weekId: 3, status: 'live', matches: [] };
    const existing = [{
        _id: 'registration-1',
        playerId: 'player-1',
        weekId: 3,
        paymentStatus: 'approved',
        playerName: 'Player One',
        contact: '+251 91 234 5678',
        telegramUsername: 'player_one',
    }];

    assert.equal(normalizeContact('091-234-5678'), normalizeContact('+251 91 234 5678'));
    assert.equal(isValidContact('091-234-5678'), true);
    assert.equal(isValidContact('+251 91 234 5678'), true);
    assert.equal(isValidContact('player-phone'), false);
    assert.ok(findRegistrationIdentityConflict(existing, [{ contact: '0912345678' }], 3, tournament));
    assert.ok(findRegistrationIdentityConflict(existing, [{ playerName: '  PLAYER   ONE ' }], 3, tournament));
    assert.ok(findRegistrationIdentityConflict(existing, [{ telegramUsername: '@PLAYER_ONE' }], 3, tournament));
    assert.ok(findRegistrationIdentityConflict(existing, [{ playerId: 'player-1', ownsAccount: true }], 3, tournament));
    assert.equal(findRegistrationIdentityConflict(existing, [{ contact: '0912345678' }], 3, { ...tournament, status: 'completed' }), null);
});

test('Telegram usernames are normalized and unique across player profiles', () => {
    const players = [
        { _id: 'player-1', telegramUsername: 'Player_One' },
        { _id: 'player-2', telegramUsername: '' },
    ];

    assert.equal(normalizeTelegramUsername('@PLAYER_ONE'), 'player_one');
    assert.equal(telegramUsernameConflict(players, '@player_one'), true);
    assert.equal(telegramUsernameConflict(players, '@player_one', 'player-1'), false);
    assert.equal(telegramUsernameConflict(players, ''), false);
});

test('eliminated approved players no longer have an active tournament registration', () => {
    const registration = { _id: 'entry-1', paymentStatus: 'approved', weekId: 1 };
    const tournament = { status: 'live', matches: [{
        status: 'finished',
        player1Id: 'entry-1',
        player2Id: 'entry-2',
        winnerId: 'entry-2',
    }] };

    assert.equal(registrationWasEliminated(registration, tournament), true);
    assert.equal(activeTournamentWeekIdFrom([registration], [{ ...tournament, weekId: 1 }]), null);
});

test('group participant identities remain unique without marking the payer active', () => {
    const registration = {
        _id: 'entry-1',
        playerId: 'payer-1',
        weekId: 2,
        paymentStatus: 'pending',
        registeredForOthers: true,
        playerName: 'Participant One',
        contact: '0912345678',
        telegramUsername: 'participant_one',
    };
    const tournament = { weekId: 2, status: 'open', matches: [] };

    assert.equal(activeTournamentWeekIdFrom([registration], [tournament]), null);
    assert.ok(findRegistrationIdentityConflict([registration], [{ contact: '+251912345678' }], 2, tournament));
    assert.equal(findActiveIdentityConflict([registration], [{ contact: '0912345678' }], 3, [tournament]), 2);
});

test('payment receipt hashes cannot be claimed by separate registrations', async () => {
    const claims = new Map();
    const connection = {
        execute: async (sql, values) => {
            if (sql.startsWith('SELECT claim_key')) {
                const claimKey = claims.get(values[0]);
                return [claimKey ? [{ claimKey }] : [], []];
            }
            if (sql.startsWith('INSERT INTO payment_receipt_claims')) {
                if (claims.has(values[0])) {
                    throw Object.assign(new Error('Duplicate claim'), { code: 'ER_DUP_ENTRY' });
                }
                claims.set(values[0], values[1]);
                return [{ affectedRows: 1 }, []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
    const receipt = parseRegistrationReceipt(`data:image/png;base64,${Buffer.from('same receipt').toString('base64')}`);

    await claimPaymentReceipt(connection, receipt, 'registration-1', 'player-1');
    await claimPaymentReceipt(connection, receipt, 'registration-1', 'player-1');
    await assert.rejects(
        claimPaymentReceipt(connection, receipt, 'registration-2', 'player-2'),
        /already been used/i,
    );
    assert.equal(claims.size, 1);
});

test('validates chat messages and supported attachment formats and limits', () => {
    const textMessage = parseChatMessageInput({ body: '  hello  ' });
    assert.equal(textMessage.body, 'hello');
    assert.equal(textMessage.attachment, null);

    const image = parseChatMessageInput({
        attachmentData: `data:image/png;base64,${Buffer.from('image').toString('base64')}`,
        attachmentName: 'screen.png',
        messageType: 'image',
    });
    assert.equal(image.attachment.mime, 'image/png');
    assert.equal(image.attachment.type, 'image');
    assert.equal(image.attachment.name, 'screen.png');
    assert.equal(image.attachment.data.toString(), 'image');

    assert.match(parseChatMessageInput({
        attachmentData: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
        messageType: 'image',
    }).error, /supported image/i);
    assert.match(parseChatMessageInput({
        attachmentData: `data:image/png;base64,${Buffer.from('image').toString('base64')}`,
        messageType: 'audio',
    }).error, /does not match/i);
    assert.match(parseChatMessageInput({ body: 'x'.repeat(2001) }).error, /2,000/);
    assert.match(parseChatMessageInput({ body: '' }).error, /attach a file/i);
});

test('validates account chat backgrounds before persistence', () => {
    const imageData = `data:image/jpeg;base64,${Buffer.from('background').toString('base64')}`;
    const parsed = parseChatBackground({ imageData });
    assert.equal(parsed.mime, 'image/jpeg');
    assert.equal(parsed.data.toString(), 'background');
    assert.match(parseChatBackground({ imageData: 'data:image/svg+xml;base64,PHN2Zz4=' }).error, /PNG, JPG, or WebP/);
    assert.match(parseChatBackground({ imageData: 'invalid' }).error, /PNG, JPG, or WebP/);
});

test('generates a complete single-elimination bracket and automatically advances byes', () => {
    const players = Array.from({ length: 5 }, (_, index) => player(`player-${index + 1}`));
    const matches = generateFixtures(players, () => 0);

    assert.equal(matches.length, 7);
    assert.deepEqual(matches.map((match) => match.round), [0, 0, 0, 0, 1, 1, 2]);
    assert.equal(matches.filter((match) => match.status === 'bye').length, 1);
    assert.equal(matches.filter((match) => match.status === 'finished').length, 2);
    assert.equal(matches.find((match) => match.matchId === 'r2m2').player1Ready, true);
    assert.equal(matches.find((match) => match.matchId === 'r2m2').player2Ready, true);
    assert.equal(matches.find((match) => match.matchId === 'r3m1').player2Ready, true);
    assert.equal(players[0]._id, 'player-1');
});

test('advances completed match winners into the correct next-round slots', () => {
    const players = Array.from({ length: 4 }, (_, index) => player(`player-${index + 1}`));
    const matches = generateFixtures(players, () => 0);
    const firstRound = matches.filter((match) => match.round === 0);

    for (const [index, match] of firstRound.entries()) {
        match.status = 'finished';
        match.score1 = 2;
        match.score2 = 1;
        match.winnerId = match.player1Id;
        advanceMatchWinner(matches, match, match.winnerId);
        assert.equal(matches.find((item) => item.matchId === 'r2m1')[index === 0 ? 'player1Ready' : 'player2Ready'], true);
    }

    const final = matches.find((match) => match.round === 1);
    assert.equal(final.status, 'pending');
    assert.ok(final.player1Id);
    assert.ok(final.player2Id);
    final.status = 'finished';
    final.score1 = 3;
    final.score2 = 0;
    final.winnerId = final.player1Id;

    const standings = tournamentStandings(players, matches);
    assert.equal(standings[0].player.id, final.player1Id);
    assert.equal(standings[0].champion, true);
    assert.equal(standings[0].wins, 2);
});

test('brackets from two through 128 players finish with one champion', () => {
    for (let count = 2; count <= 128; count += 1) {
        const players = Array.from({ length: count }, (_, index) => player(`${count}-${index}`));
        const matches = generateFixtures(players, () => 0.37);
        const rounds = Math.ceil(Math.log2(count));
        assert.equal(matches.length, (2 ** rounds) - 1, `match count for ${count} players`);

        for (let round = 0; round < rounds; round += 1) {
            for (const match of matches.filter((item) => item.round === round && item.status === 'pending')) {
                assert.ok(match.player1Id && match.player2Id, `ready match at round ${round + 1}`);
                match.status = 'finished';
                match.score1 = 1;
                match.score2 = 0;
                match.winnerId = match.player1Id;
                advanceMatchWinner(matches, match, match.winnerId);
            }
        }

        const final = matches.find((match) => match.round === rounds - 1);
        assert.equal(final.status, 'finished', `completed final for ${count} players`);
        assert.ok(final.player1Id && final.player2Id, `two finalists for ${count} players`);
        assert.equal(tournamentStandings(players, matches)[0].champion, true);
    }
});

test('league fixtures schedule every pair once and standings rank by points', () => {
    const players = Array.from({ length: 5 }, (_, index) => player(`league-${index + 1}`));
    const matches = generateFixtures(players, Math.random, 'league');
    const playedMatches = matches.filter((match) => match.status !== 'bye');
    const pairs = playedMatches.map((match) => [match.player1Id, match.player2Id].sort().join(':'));
    assert.equal(playedMatches.length, 10);
    assert.equal(new Set(pairs).size, 10);
    for (const entry of players) {
        assert.equal(playedMatches.filter((match) => (
            match.player1Id === entry._id || match.player2Id === entry._id
        )).length, 4);
    }

    const completed = playedMatches.map((match, index) => ({
        ...match,
        status: 'finished',
        score1: index === 0 ? 2 : 1,
        score2: 0,
        winnerId: match.player1Id,
    }));
    const standings = tournamentStandings(players, completed, 'league');
    assert.equal(standings[0].points, 12);
    assert.equal(standings[0].champion, true);
    assert.equal(standings[0].wins, 4);
});
