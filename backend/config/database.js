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
let schemaReady = false;

async function ensureSlaColumns(db) {
    if (schemaReady) return;

    await db.request().query(`
        IF OBJECT_ID('dbo.Tickets', 'U') IS NOT NULL
            AND COL_LENGTH('dbo.Tickets', 'acknowledged_at') IS NULL
        BEGIN
            ALTER TABLE Tickets ADD acknowledged_at DATETIME NULL;
        END
    `);

    await db.request().query(`
        IF OBJECT_ID('dbo.SubCategories', 'U') IS NULL
        BEGIN
            CREATE TABLE SubCategories (
                id INT PRIMARY KEY IDENTITY(1,1),
                category_id INT NOT NULL,
                name NVARCHAR(100) NOT NULL,
                description NVARCHAR(255) NULL,
                is_active BIT NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NOT NULL DEFAULT GETDATE(),
                CONSTRAINT FK_SubCategories_Categories FOREIGN KEY (category_id) REFERENCES Categories(category_id)
            );
            CREATE INDEX IX_SubCategories_category_active ON SubCategories(category_id, is_active, name);
        END
    `);

    await db.request().query(`
        IF OBJECT_ID('dbo.Tickets', 'U') IS NOT NULL
            AND COL_LENGTH('dbo.Tickets', 'sub_category_id') IS NULL
        BEGIN
            ALTER TABLE Tickets ADD sub_category_id INT NULL;
            ALTER TABLE Tickets ADD CONSTRAINT FK_Tickets_SubCategories FOREIGN KEY (sub_category_id) REFERENCES SubCategories(id);
        END
    `);

    schemaReady = true;
}

async function getPool() {
    if (!pool) {
        pool = await sql.connect(config);
        console.log('✅ Connected to SQL Server');
    }
    await ensureSlaColumns(pool);
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
