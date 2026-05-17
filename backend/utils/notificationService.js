const { query, sql } = require('../config/database');

let ensured = false;

async function ensureNotificationsTable() {
    if (ensured) return;
    await query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Notifications')
        BEGIN
            CREATE TABLE Notifications (
                notification_id INT PRIMARY KEY IDENTITY(1,1),
                user_id INT NOT NULL,
                message NVARCHAR(255) NOT NULL,
                module NVARCHAR(50) NOT NULL,
                record_id INT NULL,
                link_target NVARCHAR(120) NULL,
                is_read BIT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                FOREIGN KEY (user_id) REFERENCES Users(user_id)
            );
            CREATE INDEX IX_Notifications_user_read ON Notifications(user_id, is_read, created_at DESC);
        END

        IF COL_LENGTH('Notifications', 'title') IS NULL
            ALTER TABLE Notifications ADD title NVARCHAR(150) NULL;
        IF COL_LENGTH('Notifications', 'type') IS NULL
            ALTER TABLE Notifications ADD type NVARCHAR(50) NULL;
        IF COL_LENGTH('Notifications', 'related_ticket_id') IS NULL
            ALTER TABLE Notifications ADD related_ticket_id INT NULL;
        IF COL_LENGTH('Notifications', 'related_asset_id') IS NULL
            ALTER TABLE Notifications ADD related_asset_id INT NULL;
    `);
    ensured = true;
}

async function createNotification(userId, message, moduleName, recordId = null, linkTarget = null, options = {}) {
    if (!userId || !message) return;
    try {
        await ensureNotificationsTable();
        const title = options.title || message;
        const type = options.type || moduleName;
        const relatedTicketId = options.relatedTicketId || (moduleName === 'Tickets' ? recordId : null);
        const relatedAssetId = options.relatedAssetId || (moduleName === 'Assets' ? recordId : null);

        const duplicate = await query(`
            SELECT TOP 1 notification_id
            FROM Notifications
            WHERE user_id = @userId
              AND message = @message
              AND ISNULL(type, '') = ISNULL(@type, '')
              AND ISNULL(related_ticket_id, 0) = ISNULL(@relatedTicketId, 0)
              AND ISNULL(related_asset_id, 0) = ISNULL(@relatedAssetId, 0)
              AND created_at >= DATEADD(second, -10, GETDATE())
        `, {
            userId: { type: sql.Int, value: userId },
            message: { type: sql.NVarChar, value: message },
            type: { type: sql.NVarChar, value: type },
            relatedTicketId: { type: sql.Int, value: relatedTicketId || null },
            relatedAssetId: { type: sql.Int, value: relatedAssetId || null }
        });
        if (duplicate.recordset.length) return;

        await query(`
            INSERT INTO Notifications (user_id, title, message, type, module, record_id, related_ticket_id, related_asset_id, link_target)
            VALUES (@userId, @title, @message, @type, @module, @recordId, @relatedTicketId, @relatedAssetId, @linkTarget)
        `, {
            userId: { type: sql.Int, value: userId },
            title: { type: sql.NVarChar, value: title },
            message: { type: sql.NVarChar, value: message },
            type: { type: sql.NVarChar, value: type },
            module: { type: sql.NVarChar, value: moduleName },
            recordId: { type: sql.Int, value: recordId || null },
            relatedTicketId: { type: sql.Int, value: relatedTicketId || null },
            relatedAssetId: { type: sql.Int, value: relatedAssetId || null },
            linkTarget: { type: sql.NVarChar, value: linkTarget || null }
        });
    } catch (err) {
        console.warn('Notification skipped:', err.message);
    }
}

async function notifyUsers(userIds, message, moduleName, recordId = null, linkTarget = null, options = {}) {
    const uniqueIds = [...new Set((userIds || []).filter(Boolean).map(Number))];
    for (const userId of uniqueIds) {
        await createNotification(userId, message, moduleName, recordId, linkTarget, options);
    }
}

async function getUsersByRoles(roleNames = []) {
    if (!roleNames.length) return [];
    const inputs = Object.fromEntries(roleNames.map((role, index) => [`role${index}`, { type: sql.NVarChar, value: role }]));
    const result = await query(`
        SELECT u.user_id, u.full_name, r.role_name
        FROM Users u
        JOIN Roles r ON u.role_id = r.role_id
        WHERE u.is_active = 1 AND r.role_name IN (${roleNames.map((_, index) => `@role${index}`).join(',')})
    `, inputs);
    return result.recordset;
}

async function getAdminNotificationRecipients(excludeUserIds = []) {
    const excluded = new Set((excludeUserIds || []).filter(Boolean).map(Number));
    const users = await getUsersByRoles(['Super Admin', 'Admin']);
    return users.filter(user => !excluded.has(Number(user.user_id))).map(user => user.user_id);
}

module.exports = {
    ensureNotificationsTable,
    createNotification,
    notifyUsers,
    getUsersByRoles,
    getAdminNotificationRecipients
};
