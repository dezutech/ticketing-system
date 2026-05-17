const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { ensureActivityLogsTable } = require('../utils/activityLogger');

const ACTIVITY_LOG_ROLES = ['Super Admin', 'Admin'];

function canViewActivityLogs(user) {
    return ACTIVITY_LOG_ROLES.includes(user?.role_name);
}

function parsePositiveInt(value, fallback, max = null) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return max ? Math.min(parsed, max) : parsed;
}

router.get('/', authenticateToken, async (req, res) => {
    if (!canViewActivityLogs(req.user)) {
        return res.status(403).json({ success: false, message: 'Activity logs are restricted to Admin users.' });
    }

    try {
        await ensureActivityLogsTable();
        const { search, module, date } = req.query;
        const page = parsePositiveInt(req.query.page, 1);
        const limit = parsePositiveInt(req.query.limit, 20, 100);
        const offset = (page - 1) * limit;
        const conditions = [];
        const inputs = {};

        if (search) {
            conditions.push('(user_name LIKE @search OR user_role LIKE @search OR action LIKE @search OR details LIKE @search)');
            inputs.search = { type: sql.NVarChar, value: `%${search}%` };
        }
        if (module) {
            conditions.push('module = @module');
            inputs.module = { type: sql.NVarChar, value: module };
        }
        if (date) {
            conditions.push('CONVERT(date, created_at) = CONVERT(date, @date)');
            inputs.date = { type: sql.Date, value: date };
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const count = await query(`SELECT COUNT(*) AS total FROM ActivityLogs ${where}`, inputs);
        const logs = await query(`
            SELECT TOP ${limit} *
            FROM (
                SELECT ROW_NUMBER() OVER (ORDER BY created_at DESC, log_id DESC) AS rn,
                    log_id, user_id, user_name, user_role, action, module, record_id, details, created_at
                FROM ActivityLogs
                ${where}
            ) x
            WHERE rn > ${offset}
            ORDER BY rn
        `, inputs);

        const modules = await query(`
            SELECT DISTINCT module
            FROM ActivityLogs
            ORDER BY module
        `);

        res.json({
            success: true,
            logs: logs.recordset,
            modules: modules.recordset.map(row => row.module),
            total: count.recordset[0].total,
            page,
            limit
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
