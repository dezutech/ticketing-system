const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { ensureNotificationsTable } = require('../utils/notificationService');

function parseNotificationId(value) {
    const id = parseInt(value, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/', authenticateToken, async (req, res) => {
    try {
        await ensureNotificationsTable();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
        const result = await query(`
            SELECT TOP ${limit}
                notification_id,
                user_id,
                COALESCE(title, message) AS title,
                message,
                COALESCE(type, module) AS type,
                module,
                record_id,
                related_ticket_id,
                related_asset_id,
                link_target,
                is_read,
                created_at
            FROM Notifications
            WHERE user_id = @userId
            ORDER BY created_at DESC, notification_id DESC
        `, {
            userId: { type: sql.Int, value: req.user.user_id }
        });
        const unread = await query(`
            SELECT COUNT(*) AS count
            FROM Notifications
            WHERE user_id = @userId AND is_read = 0
        `, {
            userId: { type: sql.Int, value: req.user.user_id }
        });
        res.json({ success: true, notifications: result.recordset, unread_count: unread.recordset[0].count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.patch('/:id/read', authenticateToken, async (req, res) => {
    try {
        const notificationId = parseNotificationId(req.params.id);
        if (!notificationId) {
            return res.status(400).json({ success: false, message: 'Invalid notification.' });
        }
        await ensureNotificationsTable();
        await query(`
            UPDATE Notifications SET is_read = 1
            WHERE notification_id = @id AND user_id = @userId
        `, {
            id: { type: sql.Int, value: notificationId },
            userId: { type: sql.Int, value: req.user.user_id }
        });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.patch('/read-all', authenticateToken, async (req, res) => {
    try {
        await ensureNotificationsTable();
        await query(`UPDATE Notifications SET is_read = 1 WHERE user_id = @userId`, {
            userId: { type: sql.Int, value: req.user.user_id }
        });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
