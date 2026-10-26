const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const COLLECTIONS = {
    tournaments: { unique: ['weekId'] },
    registrations: { unique: ['confirmationCode'] },
    players: { unique: ['contact', 'contactKey', 'playerCode'] },
    counters: { unique: [] },
};
const DATA_FILE = path.join(__dirname, 'data', 'local-data.json');
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;

let pool = null;

function databaseName() {
    const name = process.env.MYSQL_DATABASE || 'prime_gaming_db';
    if (!IDENTIFIER_PATTERN.test(name)) {
        throw new Error('MYSQL_DATABASE must contain only letters, numbers, and underscores.');
    }
    return name;
}

function tableName(collection) {
    if (!Object.prototype.hasOwnProperty.call(COLLECTIONS, collection)) {
        throw new Error(`Unknown MySQL collection: ${collection}`);
    }
    return `pgz_${collection}`;
}

function uniqueValues(collection, document) {
    const values = COLLECTIONS[collection].unique.map((field) => document[field] ?? null);
    while (values.length < 3) values.push(null);
    return values;
}

async function createCollectionTables(connection) {
    for (const collection of Object.keys(COLLECTIONS)) {
        const uniqueColumns = COLLECTIONS[collection].unique
            .map((_, index) => `UNIQUE KEY unique_${index + 1} (unique_${index + 1})`)
            .join(',\n            ');
        const constraints = uniqueColumns ? `,\n            ${uniqueColumns}` : '';
        await connection.query(`
            CREATE TABLE IF NOT EXISTS \`${tableName(collection)}\` (
                id VARCHAR(64) NOT NULL PRIMARY KEY,
                document JSON NOT NULL,
                unique_1 VARCHAR(255) NULL,
                unique_2 VARCHAR(255) NULL,
                unique_3 VARCHAR(255) NULL${constraints}
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }
}

async function createApplicationTables(connection) {
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    const statements = schema
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
    for (const statement of statements) {
        await connection.query(statement);
    }
}

async function migrateChatSchema(connection) {
    const migrations = {
        player_chats: {
            blocked_at: 'TIMESTAMP NULL',
            reported_at: 'TIMESTAMP NULL',
            report_reason: 'VARCHAR(1000) NULL',
        },
        chat_messages: {
            message_type: "ENUM('text', 'image', 'file', 'audio') NOT NULL DEFAULT 'text'",
            attachment_data: 'MEDIUMBLOB NULL',
            attachment_mime: 'VARCHAR(120) NULL',
            attachment_name: 'VARCHAR(255) NULL',
            is_pinned: 'BOOLEAN NOT NULL DEFAULT FALSE',
            edited_at: 'TIMESTAMP NULL',
            deleted_at: 'TIMESTAMP NULL',
        },
        chat_presence: {
            player_typing_until: 'TIMESTAMP NULL',
            admin_typing_until: 'TIMESTAMP NULL',
            player_online_until: 'TIMESTAMP NULL',
            admin_online_until: 'TIMESTAMP NULL',
        },
    };

    for (const [table, columns] of Object.entries(migrations)) {
        const [existingColumns] = await connection.query(`SHOW COLUMNS FROM \`${table}\``);
        const existingNames = new Set(existingColumns.map((column) => column.Field));
        for (const [column, definition] of Object.entries(columns)) {
            if (!existingNames.has(column)) {
                await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
            }
        }
    }
    await connection.query('ALTER TABLE `chat_messages` MODIFY COLUMN `body` VARCHAR(2000) NULL');
}

async function migrateLocalJsonData(connection) {
    if (!fs.existsSync(DATA_FILE)) return;
    const contents = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!contents || typeof contents !== 'object'
        || Object.keys(COLLECTIONS).some((name) => !Array.isArray(contents[name]))) {
        throw new Error(`Existing local data file has an invalid format: ${DATA_FILE}`);
    }

    const counts = await Promise.all(Object.keys(COLLECTIONS).map(async (collection) => {
        const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM \`${tableName(collection)}\``);
        return Number(rows[0].count);
    }));
    if (counts.some((count) => count > 0)) return;

    const connectionForImport = await connection.getConnection();
    try {
        await connectionForImport.beginTransaction();
        for (const [collection, documents] of Object.entries(contents)) {
            for (const document of documents) {
                const [first, second, third] = uniqueValues(collection, document);
                await connectionForImport.execute(
                    `INSERT INTO \`${tableName(collection)}\` (id, document, unique_1, unique_2, unique_3)
                     VALUES (?, ?, ?, ?, ?)`,
                    [String(document._id), JSON.stringify(document), first, second, third]
                );
            }
        }
        await connectionForImport.commit();
        console.log('📦 Imported existing local JSON data into MySQL.');
    } catch (error) {
        await connectionForImport.rollback();
        throw error;
    } finally {
        connectionForImport.release();
    }
}

async function initializeDatabase() {
    const name = databaseName();
    const config = {
        host: process.env.MYSQL_HOST || 'localhost',
        port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3307),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'utf8mb4',
    };
    const bootstrap = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        charset: config.charset,
    });
    try {
        await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
        await bootstrap.end();
    }

    const databasePool = mysql.createPool({ ...config, database: name });
    try {
        await databasePool.query('SELECT 1');
        await createCollectionTables(databasePool);
        await createApplicationTables(databasePool);
        await migrateChatSchema(databasePool);
        await migrateLocalJsonData(databasePool);
    } catch (error) {
        await databasePool.end();
        throw error;
    }

    pool = databasePool;
    console.log(`✅ Connected to local MySQL database "${name}" at ${config.host}:${config.port}.`);
    return pool;
}

function getPool() {
    if (!pool) {
        const error = new Error('MySQL database is not connected. Start XAMPP MySQL and check the server logs.');
        error.code = 'DB_NOT_CONNECTED';
        throw error;
    }
    return pool;
}

async function closeDatabase() {
    if (!pool) return;
    const activePool = pool;
    pool = null;
    await activePool.end();
}

function isDuplicateKeyError(error) {
    return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || error?.code === 11000;
}

module.exports = { closeDatabase, getPool, initializeDatabase, isDuplicateKeyError };
