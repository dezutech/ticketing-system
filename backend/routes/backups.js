const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');
const {
    createDatabaseBackup,
    listBackups,
    restoreDatabaseBackup
} = require('../utils/backupService');

function requireSuperAdmin(req, res, next) {
    if (req.user?.role_name !== 'Super Admin') {
        return res.status(403).json({ success: false, message: 'Only Super Admin can access Backup & Restore.' });
    }
    next();
}

router.get('/', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const backups = await listBackups();
        res.json({ success: true, backups });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Unable to load backup history.' });
    }
});

router.post('/', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const backup = await createDatabaseBackup(req.user);
        await logActivity(req.user, 'Database backup created', 'System', backup.file_name, {
            table_count: backup.table_count,
            row_count: backup.row_count
        });
        res.json({ success: true, message: 'Backup created successfully.', backup });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Backup failed. Please check server logs.' });
    }
});

router.post('/restore', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { file_name, confirmation } = req.body;
        if (!file_name || confirmation !== file_name) {
            return res.status(400).json({
                success: false,
                message: 'Restore confirmation did not match the selected backup file.'
            });
        }

        const result = await restoreDatabaseBackup(file_name);
        await logActivity(req.user, 'Database restored', 'System', file_name, {
            table_count: result.table_count,
            row_count: result.row_count
        });
        res.json({ success: true, message: 'Database restored successfully.', restore: result });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message || 'Restore failed. No changes were committed.' });
    }
});

module.exports = router;
