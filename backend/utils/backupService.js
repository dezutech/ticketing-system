const fs = require('fs/promises');
const path = require('path');
const { getPool, query, sql } = require('../config/database');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'server_backups');

const BACKUP_TABLES = [
    'Roles',
    'Users',
    'Categories',
    'Departments',
    'asset_categories',
    'Tickets',
    'assets',
    'ticket_assets',
    'TicketAttachments',
    'TicketComments',
    'TicketHistory',
    'TicketTransferHistory',
    'asset_assignments',
    'asset_maintenance_logs',
    'asset_activity_logs',
    'asset_attachments',
    'ActivityLogs',
    'Notifications'
];

function bracket(name) {
    return `[${String(name).replace(/]/g, ']]')}]`;
}

function backupFileName(date = new Date()) {
    const stamp = date.toISOString().replace(/[:.]/g, '-');
    return `ticketing-backup-${stamp}.json`;
}

async function ensureBackupDir() {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
}

async function existingBackupTables() {
    const result = await query(`
        SELECT name
        FROM sys.tables
        WHERE name IN (${BACKUP_TABLES.map((_, index) => `@t${index}`).join(',')})
    `, Object.fromEntries(BACKUP_TABLES.map((table, index) => [`t${index}`, { type: sql.NVarChar, value: table }])));
    const existing = new Set(result.recordset.map(row => row.name));
    return BACKUP_TABLES.filter(table => existing.has(table));
}

async function getTableSchema(table) {
    const result = await query(`
        SELECT
            c.name AS column_name,
            ty.name AS data_type,
            c.max_length,
            c.precision,
            c.scale,
            c.is_identity,
            c.is_computed
        FROM sys.columns c
        JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        WHERE c.object_id = OBJECT_ID(@tableName)
        ORDER BY c.column_id
    `, {
        tableName: { type: sql.NVarChar, value: table }
    });
    return result.recordset;
}

function sqlType(column) {
    const type = String(column.data_type).toLowerCase();
    if (['int'].includes(type)) return sql.Int;
    if (['bigint'].includes(type)) return sql.BigInt;
    if (['smallint'].includes(type)) return sql.SmallInt;
    if (['tinyint'].includes(type)) return sql.TinyInt;
    if (['bit'].includes(type)) return sql.Bit;
    if (['date'].includes(type)) return sql.Date;
    if (['datetime', 'datetime2', 'smalldatetime'].includes(type)) return sql.DateTime;
    if (['decimal', 'numeric', 'money', 'smallmoney'].includes(type)) return sql.Decimal(column.precision || 18, column.scale || 2);
    if (['float'].includes(type)) return sql.Float;
    if (['real'].includes(type)) return sql.Real;
    if (['uniqueidentifier'].includes(type)) return sql.UniqueIdentifier;
    return sql.NVarChar(sql.MAX);
}

function normalizeValue(value, column) {
    if (value === undefined || value === null) return null;
    const type = String(column.data_type).toLowerCase();
    if (['datetime', 'datetime2', 'smalldatetime', 'date'].includes(type)) return new Date(value);
    if (['bit'].includes(type)) return value === true || value === 1;
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real'].includes(type)) return Number(value);
    return value;
}

async function createDatabaseBackup(user) {
    await ensureBackupDir();
    const tables = await existingBackupTables();
    const snapshot = {
        format: 'ticketing-system-json-backup',
        version: 1,
        generated_at: new Date().toISOString(),
        generated_by: {
            user_id: user.user_id,
            user_name: user.full_name || user.username,
            role: user.role_name
        },
        tables: {}
    };

    for (const table of tables) {
        const schema = await getTableSchema(table);
        const identityColumn = schema.find(column => column.is_identity)?.column_name || null;
        const orderBy = identityColumn ? ` ORDER BY ${bracket(identityColumn)}` : '';
        const rows = await query(`SELECT * FROM ${bracket(table)}${orderBy}`);
        snapshot.tables[table] = {
            schema,
            rows: rows.recordset
        };
    }

    const fileName = backupFileName();
    const filePath = path.join(BACKUP_DIR, fileName);
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    const stat = await fs.stat(filePath);
    return {
        file_name: fileName,
        size: stat.size,
        generated_at: snapshot.generated_at,
        table_count: Object.keys(snapshot.tables).length,
        row_count: Object.values(snapshot.tables).reduce((sum, table) => sum + table.rows.length, 0)
    };
}

async function listBackups() {
    await ensureBackupDir();
    const files = await fs.readdir(BACKUP_DIR);
    const backups = [];
    for (const file of files.filter(name => name.endsWith('.json'))) {
        const filePath = path.join(BACKUP_DIR, file);
        const stat = await fs.stat(filePath);
        let metadata = {};
        try {
            const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
            metadata = {
                generated_at: parsed.generated_at,
                table_count: Object.keys(parsed.tables || {}).length,
                row_count: Object.values(parsed.tables || {}).reduce((sum, table) => sum + (table.rows?.length || 0), 0),
                generated_by: parsed.generated_by
            };
        } catch (err) {
            metadata = { invalid: true };
        }
        backups.push({
            file_name: file,
            size: stat.size,
            created_at: stat.birthtime,
            modified_at: stat.mtime,
            ...metadata
        });
    }
    return backups.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
}

function resolveBackupPath(fileName) {
    const safeName = path.basename(fileName || '');
    if (!safeName.endsWith('.json') || safeName !== fileName) {
        throw new Error('Invalid backup file.');
    }
    return path.join(BACKUP_DIR, safeName);
}

async function runRequest(transaction, sqlText, inputs = {}) {
    const request = transaction.request();
    for (const [key, value] of Object.entries(inputs)) {
        request.input(key, value.type, value.value);
    }
    return request.query(sqlText);
}

async function restoreTable(transaction, table, tableData) {
    const schema = (tableData.schema || []).filter(column => !column.is_computed);
    const rows = tableData.rows || [];
    if (!schema.length) return;

    await runRequest(transaction, `DELETE FROM ${bracket(table)}`);
    if (!rows.length) return;

    const hasIdentityColumn = schema.some(column => column.is_identity === true || column.is_identity === 1);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const inputs = {};
        const columns = schema.map(column => column.column_name);
        const parameters = columns.map((columnName, columnIndex) => {
            const key = `p${rowIndex}_${columnIndex}`;
            const column = schema[columnIndex];
            inputs[key] = { type: sqlType(column), value: normalizeValue(row[columnName], column) };
            return `@${key}`;
        });
        const insertSql = `
            INSERT INTO ${bracket(table)} (${columns.map(bracket).join(', ')})
            VALUES (${parameters.join(', ')})
        `;
        await runRequest(transaction, hasIdentityColumn
            ? `SET IDENTITY_INSERT ${bracket(table)} ON; ${insertSql}; SET IDENTITY_INSERT ${bracket(table)} OFF;`
            : insertSql, inputs);
    }
}

async function restoreDatabaseBackup(fileName) {
    await ensureBackupDir();
    const filePath = resolveBackupPath(fileName);
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (payload.format !== 'ticketing-system-json-backup' || !payload.tables) {
        throw new Error('Backup file is not compatible with this system.');
    }

    const restoreTables = BACKUP_TABLES.filter(table => payload.tables[table]);
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        for (const table of restoreTables) {
            await runRequest(transaction, `ALTER TABLE ${bracket(table)} NOCHECK CONSTRAINT ALL`);
        }
        for (const table of [...restoreTables].reverse()) {
            await restoreTable(transaction, table, payload.tables[table]);
        }
        for (const table of restoreTables) {
            await runRequest(transaction, `ALTER TABLE ${bracket(table)} WITH CHECK CHECK CONSTRAINT ALL`);
        }
        await transaction.commit();
    } catch (err) {
        await transaction.rollback();
        throw err;
    }

    return {
        file_name: fileName,
        restored_at: new Date().toISOString(),
        table_count: restoreTables.length,
        row_count: restoreTables.reduce((sum, table) => sum + (payload.tables[table].rows?.length || 0), 0)
    };
}

module.exports = {
    BACKUP_DIR,
    createDatabaseBackup,
    listBackups,
    restoreDatabaseBackup
};
