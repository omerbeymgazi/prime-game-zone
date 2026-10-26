CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    telegram_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(255) NULL,
    first_name VARCHAR(255) NOT NULL,
    coins BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_telegram_id (telegram_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tournaments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    game_type VARCHAR(100) NOT NULL,
    entry_fee DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    prize_pool DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'upcoming',
    start_time DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_tournaments_status_start_time (status, start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS registrations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    tournament_id BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'registered',
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_registrations_user_tournament (user_id, tournament_id),
    KEY idx_registrations_tournament_status (tournament_id, status),
    CONSTRAINT fk_registrations_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_registrations_tournament
        FOREIGN KEY (tournament_id) REFERENCES tournaments (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tournament_id BIGINT UNSIGNED NOT NULL,
    player1_id BIGINT UNSIGNED NULL,
    player2_id BIGINT UNSIGNED NULL,
    winner_id BIGINT UNSIGNED NULL,
    `round` INT UNSIGNED NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
    PRIMARY KEY (id),
    KEY idx_matches_tournament_round (tournament_id, `round`),
    KEY idx_matches_player1 (player1_id),
    KEY idx_matches_player2 (player2_id),
    KEY idx_matches_winner (winner_id),
    CONSTRAINT fk_matches_tournament
        FOREIGN KEY (tournament_id) REFERENCES tournaments (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_matches_player1
        FOREIGN KEY (player1_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_matches_player2
        FOREIGN KEY (player2_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_matches_winner
        FOREIGN KEY (winner_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id VARCHAR(64) NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'announcement',
    title VARCHAR(160) NOT NULL,
    message VARCHAR(500) NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_notifications_player_read_created (player_id, is_read, created_at),
    CONSTRAINT fk_notifications_player
        FOREIGN KEY (player_id) REFERENCES pgz_players (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS player_chats (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id VARCHAR(64) NOT NULL,
    blocked_at TIMESTAMP NULL,
    reported_at TIMESTAMP NULL,
    report_reason VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_player_chats_player (player_id),
    KEY idx_player_chats_updated (updated_at),
    CONSTRAINT fk_player_chats_player
        FOREIGN KEY (player_id) REFERENCES pgz_players (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    chat_id BIGINT UNSIGNED NOT NULL,
    sender ENUM('player', 'admin') NOT NULL,
    body VARCHAR(2000) NULL,
    message_type ENUM('text', 'image', 'file', 'audio') NOT NULL DEFAULT 'text',
    attachment_data MEDIUMBLOB NULL,
    attachment_mime VARCHAR(120) NULL,
    attachment_name VARCHAR(255) NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    edited_at TIMESTAMP NULL,
    deleted_at TIMESTAMP NULL,
    read_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_chat_messages_chat_created (chat_id, created_at, id),
    KEY idx_chat_messages_unread (chat_id, sender, read_at),
    CONSTRAINT fk_chat_messages_chat
        FOREIGN KEY (chat_id) REFERENCES player_chats (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_message_reactions (
    message_id BIGINT UNSIGNED NOT NULL,
    actor ENUM('player', 'admin') NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, actor, actor_id, emoji),
    KEY idx_chat_reactions_message (message_id),
    CONSTRAINT fk_chat_reactions_message
        FOREIGN KEY (message_id) REFERENCES chat_messages (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_presence (
    chat_id BIGINT UNSIGNED NOT NULL,
    player_typing_until TIMESTAMP NULL,
    admin_typing_until TIMESTAMP NULL,
    player_online_until TIMESTAMP NULL,
    admin_online_until TIMESTAMP NULL,
    PRIMARY KEY (chat_id),
    CONSTRAINT fk_chat_presence_chat
        FOREIGN KEY (chat_id) REFERENCES player_chats (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_backgrounds (
    owner_type ENUM('player', 'admin') NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    image_data MEDIUMBLOB NOT NULL,
    image_mime VARCHAR(32) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_type, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_disputes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    player_id VARCHAR(64) NOT NULL,
    week_id INT UNSIGNED NOT NULL,
    match_id VARCHAR(40) NOT NULL,
    details VARCHAR(2000) NOT NULL,
    proof_data MEDIUMBLOB NULL,
    proof_mime VARCHAR(40) NULL,
    status ENUM('open', 'resolved') NOT NULL DEFAULT 'open',
    admin_note VARCHAR(2000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP NULL,
    PRIMARY KEY (id),
    KEY idx_disputes_status_created (status, created_at),
    KEY idx_disputes_player_created (player_id, created_at),
    KEY idx_disputes_match (week_id, match_id),
    CONSTRAINT fk_disputes_player
        FOREIGN KEY (player_id) REFERENCES pgz_players (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_accounts (
    account_type ENUM('cbe', 'telebirr') NOT NULL,
    account_name VARCHAR(120) NOT NULL DEFAULT '',
    account_number VARCHAR(80) NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (account_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_submissions (
    group_id VARCHAR(64) NOT NULL,
    receipt_data MEDIUMBLOB NULL,
    receipt_mime VARCHAR(40) NULL,
    decision ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    rejection_reason VARCHAR(1000) NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id),
    KEY idx_payment_submissions_decision (decision, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
