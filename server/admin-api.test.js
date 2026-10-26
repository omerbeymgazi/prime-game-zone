const test = require('node:test');
const assert = require('node:assert/strict');
const { advanceMatchWinner, checkInAvailabilityError, currentPassStage, generateFixtures, nextPassStage, parseChatBackground, parseChatMessageInput, parseRegistrationReceipt, parseTelegramUsername, scheduledMatchForRegistration, tournamentStandings } = require('./admin-api');

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
