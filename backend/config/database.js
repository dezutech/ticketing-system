// backend/config/database.js
const sql = require('mssql');
require('dotenv').config();

const config = {
    server: process.env.DB_SERVER || 'localhost',
    port: parseInt(process.env.DB_PORT) || 1433,
    database: process.env.DB_NAME || 'TicketingDB',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',
        enableArithAbort: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

let pool = null;

async function getPool() {
    if (!pool) {
        pool = await sql.connect(config);
        console.log('✅ Connected to SQL Server');
    }
    return pool;
}

async function query(queryString, inputs = {}) {
    const db = await getPool();
    const request = db.request();
    
    for (const [key, value] of Object.entries(inputs)) {
        request.input(key, value.type, value.value);
    }
    
    return await request.query(queryString);
}

module.exports = { getPool, query, sql };
