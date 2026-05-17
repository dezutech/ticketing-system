const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { makePdf, makeXlsx } = require('../utils/reportExporters');

const REPORT_ROLES = ['Super Admin', 'Admin'];
const TICKET_STATUSES = ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed'];
const TICKET_PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];
const ASSET_STATUSES = ['Available', 'Assigned', 'For Inspection', 'Under Repair', 'Returned', 'Pulled Out', 'Retired', 'Lost'];

function canExport(user) {
    return REPORT_ROLES.includes(user?.role_name);
}

function isIntegerValue(value) {
    return value !== undefined && value !== null && value !== '' && Number.isInteger(Number(value));
}

function addCommonFilters(conditions, inputs, queryParams, alias, type) {
    if (queryParams.date_from) {
        conditions.push(`${alias}.created_at >= @dateFrom`);
        inputs.dateFrom = { type: sql.DateTime, value: queryParams.date_from };
    }
    if (queryParams.date_to) {
        conditions.push(`${alias}.created_at < DATEADD(day, 1, @dateTo)`);
        inputs.dateTo = { type: sql.DateTime, value: queryParams.date_to };
    }
    if (queryParams.status) {
        const allowed = type === 'tickets' ? TICKET_STATUSES : ASSET_STATUSES;
        if (!allowed.includes(queryParams.status)) return 'Invalid status filter.';
        conditions.push(`${alias}.status = @status`);
        inputs.status = { type: sql.NVarChar, value: queryParams.status };
    }
    if (queryParams.priority) {
        if (type !== 'tickets') return null;
        if (!TICKET_PRIORITIES.includes(queryParams.priority)) return 'Invalid priority filter.';
        conditions.push(`${alias}.priority = @priority`);
        inputs.priority = { type: sql.NVarChar, value: queryParams.priority };
    }
    if (queryParams.category_id) {
        if (!isIntegerValue(queryParams.category_id)) return 'Invalid category filter.';
        conditions.push(`${alias}.category_id = @categoryId`);
        inputs.categoryId = { type: sql.Int, value: queryParams.category_id };
    }
    return null;
}

function filtersText(q) {
    return [
        q.date_from ? `From ${q.date_from}` : '',
        q.date_to ? `To ${q.date_to}` : '',
        q.status ? `Status ${q.status}` : '',
        q.priority ? `Priority ${q.priority}` : '',
        q.category_id ? `Category ID ${q.category_id}` : ''
    ].filter(Boolean).join(', ');
}

async function buildTicketReport(q) {
    const conditions = [];
    const inputs = {};
    const error = addCommonFilters(conditions, inputs, q, 't', 'tickets');
    if (error) throw new Error(error);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`
        SELECT TOP 10000 t.ticket_number, t.title, c.category_name, t.priority, t.status,
            creator.full_name AS created_by_name, assignee.full_name AS assigned_to_name,
            t.department, t.created_at, t.updated_at
        FROM Tickets t
        LEFT JOIN Categories c ON t.category_id = c.category_id
        LEFT JOIN Users creator ON t.created_by = creator.user_id
        LEFT JOIN Users assignee ON t.assigned_to = assignee.user_id
        ${where}
        ORDER BY t.created_at DESC
    `, inputs);
    return {
        title: 'Tickets Report',
        headers: ['Ticket #', 'Title', 'Category', 'Priority', 'Status', 'Created By', 'Assigned To', 'Department', 'Created'],
        rows: result.recordset.map(r => [r.ticket_number, r.title, r.category_name, r.priority, r.status, r.created_by_name, r.assigned_to_name || 'Unassigned', r.department, r.created_at?.toISOString?.() || r.created_at]),
        summary: { 'Total Tickets': result.recordset.length }
    };
}

async function buildAssetReport(q, reportType) {
    const conditions = [];
    const inputs = {};
    const error = addCommonFilters(conditions, inputs, q, 'a', 'assets');
    if (error) throw new Error(error);
    if (reportType === 'assigned-assets') conditions.push(`a.status = 'Assigned'`);
    if (reportType === 'returned-assets') conditions.push(`a.status IN ('Returned', 'For Inspection', 'Pulled Out')`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`
        SELECT TOP 10000 a.asset_tag, a.asset_name, ac.category_name, a.status,
            u.full_name AS assigned_to_name, a.department, a.location, a.created_at, a.updated_at
        FROM assets a
        LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
        LEFT JOIN Users u ON a.assigned_to = u.user_id
        ${where}
        ORDER BY a.created_at DESC
    `, inputs);
    const title = reportType === 'assigned-assets' ? 'Assigned Assets Report' : reportType === 'returned-assets' ? 'Returned Assets Report' : 'Assets Report';
    return {
        title,
        headers: ['Asset Tag', 'Asset Name', 'Category', 'Status', 'Assigned To', 'Department', 'Location', 'Created'],
        rows: result.recordset.map(r => [r.asset_tag, r.asset_name, r.category_name, r.status, r.assigned_to_name || '-', r.department, r.location, r.created_at?.toISOString?.() || r.created_at]),
        summary: { 'Total Assets': result.recordset.length }
    };
}

router.get('/export', authenticateToken, async (req, res) => {
    if (!canExport(req.user)) {
        return res.status(403).json({ success: false, message: 'Report export is restricted to Admin users.' });
    }
    try {
        const { type, format } = req.query;
        if (!['tickets', 'assets', 'assigned-assets', 'returned-assets'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Invalid report type.' });
        }
        if (!['pdf', 'xlsx'].includes(format)) {
            return res.status(400).json({ success: false, message: 'Invalid export format.' });
        }
        const report = type === 'tickets' ? await buildTicketReport(req.query) : await buildAssetReport(req.query, type);
        report.generatedAt = new Date().toLocaleString('en-PH');
        report.filtersText = filtersText(req.query);
        report.headers = Array.isArray(report.headers) ? report.headers : [];
        report.rows = Array.isArray(report.rows) ? report.rows : [];
        report.summary = report.summary || {};
        report.summary['Rows Exported'] = report.rows.length;
        const buffer = format === 'pdf' ? makePdf(report) : makeXlsx(report);
        const safeName = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`);
        res.send(buffer);
    } catch (err) {
        if (/invalid/i.test(err.message)) return res.status(400).json({ success: false, message: err.message });
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
