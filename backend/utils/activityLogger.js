const { query, sql } = require('../config/database');

let ensured = false;

async function ensureActivityLogsTable() {
    if (ensured) return;
    await query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ActivityLogs')
        BEGIN
            CREATE TABLE ActivityLogs (
                log_id INT PRIMARY KEY IDENTITY(1,1),
                user_id INT NULL,
                user_name NVARCHAR(150) NOT NULL,
                user_role NVARCHAR(80) NOT NULL,
                action NVARCHAR(120) NOT NULL,
                module NVARCHAR(80) NOT NULL,
                record_id NVARCHAR(80) NULL,
                details NVARCHAR(MAX) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                FOREIGN KEY (user_id) REFERENCES Users(user_id)
            );
            CREATE INDEX IX_ActivityLogs_created_at ON ActivityLogs(created_at DESC);
            CREATE INDEX IX_ActivityLogs_module ON ActivityLogs(module);
            CREATE INDEX IX_ActivityLogs_action ON ActivityLogs(action);
        END
    `);
    ensured = true;
}

function detailsToString(details) {
    if (details === undefined || details === null || details === '') return null;
    if (typeof details === 'string') return details;
    try {
        return JSON.stringify(details);
    } catch (err) {
        return String(details);
    }
}

async function logActivity(user, action, moduleName, recordId = null, details = null) {
    try {
        await ensureActivityLogsTable();
        await query(`
            INSERT INTO ActivityLogs (user_id, user_name, user_role, action, module, record_id, details)
            VALUES (@userId, @userName, @userRole, @action, @module, @recordId, @details)
        `, {
            userId: { type: sql.Int, value: user?.user_id || null },
            userName: { type: sql.NVarChar, value: user?.full_name || user?.username || 'System' },
            userRole: { type: sql.NVarChar, value: user?.role_name || 'System' },
            action: { type: sql.NVarChar, value: action },
            module: { type: sql.NVarChar, value: moduleName },
            recordId: { type: sql.NVarChar, value: recordId === undefined || recordId === null ? null : String(recordId) },
            details: { type: sql.NVarChar, value: detailsToString(details) }
        });
    } catch (err) {
        console.warn('Activity log skipped:', err.message);
    }
}

module.exports = { ensureActivityLogsTable, logActivity };
