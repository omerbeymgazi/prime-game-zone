const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const { closeDatabase, initializeDatabase } = require('./db');

async function main() {
    try {
        await initializeDatabase();
        console.log('✅ Database schema is initialized and up to date.');
    } finally {
        await closeDatabase();
    }
}

main().catch((error) => {
    console.error('❌ Database initialization failed:', error.message);
    process.exitCode = 1;
});
