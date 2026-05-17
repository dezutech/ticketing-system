const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const DASHBOARD_ROLES = ['Super Admin', 'Admin'];

function canViewDashboardAnalytics(user) {
    return DASHBOARD_ROLES.includes(user?.role_name);
}

function isOptionalSchemaError(err) {
    return err?.number === 208 || /invalid object name/i.test(err?.message || '');
}

async function optionalQuery(queryString, fallback = []) {
    try {
        const result = await query(queryString);
        return result.recordset;
    } catch (err) {
        if (!isOptionalSchemaError(err)) throw err;
        return fallback;
    }
}

function mapMonthlyRows(rows) {
    return (rows || []).map(item => ({
        month: item.month,
        year: item.year,
        count: item.count
    }));
}

router.get('/stats', authenticateToken, async (req, res) => {
    if (!canViewDashboardAnalytics(req.user)) {
        return res.status(403).json({ success: false, message: 'Dashboard analytics are restricted to Admin users.' });
    }

    try {
        const [
            ticketSummary,
            ticketsByStatus,
            ticketsByPriority,
            ticketsPerMonth,
            assetSummary,
            assetsByStatus,
            assetsByCategory,
            assetAssignmentsPerMonth,
            assetReturnsPerMonth,
            recentlyAssignedAssets,
            recentlyReturnedAssets
        ] = await Promise.all([
            query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS [open],
                    SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
                    SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
                    SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) AS closed,
                    SUM(CASE WHEN priority IN ('Urgent', 'Critical') AND status NOT IN ('Resolved', 'Closed') THEN 1 ELSE 0 END) AS urgent_open
                FROM Tickets
            `),
            query(`
                SELECT status, COUNT(*) AS count
                FROM Tickets
                GROUP BY status
                ORDER BY CASE status
                    WHEN 'Open' THEN 1
                    WHEN 'In Progress' THEN 2
                    WHEN 'Pending' THEN 3
                    WHEN 'Resolved' THEN 4
                    WHEN 'Closed' THEN 5
                    ELSE 6
                END
            `),
            query(`
                SELECT priority, COUNT(*) AS count
                FROM Tickets
                GROUP BY priority
                ORDER BY CASE priority
                    WHEN 'Low' THEN 1
                    WHEN 'Normal' THEN 2
                    WHEN 'Medium' THEN 3
                    WHEN 'High' THEN 4
                    WHEN 'Urgent' THEN 5
                    WHEN 'Critical' THEN 6
                    ELSE 7
                END
            `),
            query(`
                SELECT
                    LEFT(DATENAME(MONTH, created_at), 3) AS month,
                    YEAR(created_at) AS year,
                    MONTH(created_at) AS month_number,
                    COUNT(*) AS count
                FROM Tickets
                WHERE created_at >= DATEADD(MONTH, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
                GROUP BY YEAR(created_at), MONTH(created_at), DATENAME(MONTH, created_at)
                ORDER BY YEAR(created_at), MONTH(created_at)
            `),
            optionalQuery(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'Available' THEN 1 ELSE 0 END) AS available,
                    SUM(CASE WHEN status = 'Assigned' THEN 1 ELSE 0 END) AS assigned,
                    SUM(CASE WHEN status = 'For Inspection' THEN 1 ELSE 0 END) AS for_inspection,
                    SUM(CASE WHEN status = 'Returned' THEN 1 ELSE 0 END) AS returned,
                    SUM(CASE WHEN status = 'Pulled Out' THEN 1 ELSE 0 END) AS pulled_out,
                    SUM(CASE WHEN status = 'Under Repair' THEN 1 ELSE 0 END) AS under_repair,
                    SUM(CASE WHEN status = 'Retired' THEN 1 ELSE 0 END) AS retired,
                    SUM(CASE WHEN status = 'Lost' THEN 1 ELSE 0 END) AS lost
                FROM assets
            `, [{}]),
            optionalQuery(`
                SELECT status, COUNT(*) AS count
                FROM assets
                GROUP BY status
                ORDER BY CASE status
                    WHEN 'Available' THEN 1
                    WHEN 'Assigned' THEN 2
                    WHEN 'For Inspection' THEN 3
                    WHEN 'Returned' THEN 4
                    WHEN 'Pulled Out' THEN 5
                    WHEN 'Under Repair' THEN 6
                    WHEN 'Retired' THEN 7
                    WHEN 'Lost' THEN 8
                    ELSE 9
                END
            `),
            optionalQuery(`
                SELECT COALESCE(ac.category_name, 'Uncategorized') AS category, COUNT(*) AS count
                FROM assets a
                LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
                GROUP BY COALESCE(ac.category_name, 'Uncategorized')
                ORDER BY COUNT(*) DESC, COALESCE(ac.category_name, 'Uncategorized')
            `),
            optionalQuery(`
                SELECT
                    LEFT(DATENAME(MONTH, assigned_at), 3) AS month,
                    YEAR(assigned_at) AS year,
                    MONTH(assigned_at) AS month_number,
                    COUNT(*) AS count
                FROM asset_assignments
                WHERE assigned_at >= DATEADD(MONTH, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
                GROUP BY YEAR(assigned_at), MONTH(assigned_at), DATENAME(MONTH, assigned_at)
                ORDER BY YEAR(assigned_at), MONTH(assigned_at)
            `),
            optionalQuery(`
                SELECT
                    LEFT(DATENAME(MONTH, returned_at), 3) AS month,
                    YEAR(returned_at) AS year,
                    MONTH(returned_at) AS month_number,
                    COUNT(*) AS count
                FROM asset_assignments
                WHERE returned_at IS NOT NULL
                    AND returned_at >= DATEADD(MONTH, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
                GROUP BY YEAR(returned_at), MONTH(returned_at), DATENAME(MONTH, returned_at)
                ORDER BY YEAR(returned_at), MONTH(returned_at)
            `),
            optionalQuery(`
                SELECT TOP 5
                    a.asset_tag,
                    a.asset_name,
                    assigned.full_name AS assigned_to_name,
                    aa.assigned_at
                FROM asset_assignments aa
                JOIN assets a ON aa.asset_id = a.asset_id
                LEFT JOIN Users assigned ON aa.assigned_to = assigned.user_id
                ORDER BY aa.assigned_at DESC
            `),
            optionalQuery(`
                SELECT TOP 5
                    a.asset_tag,
                    a.asset_name,
                    assigned.full_name AS assigned_to_name,
                    aa.returned_at,
                    aa.return_status
                FROM asset_assignments aa
                JOIN assets a ON aa.asset_id = a.asset_id
                LEFT JOIN Users assigned ON aa.assigned_to = assigned.user_id
                WHERE aa.returned_at IS NOT NULL
                ORDER BY aa.returned_at DESC
            `)
        ]);

        const tickets = ticketSummary.recordset[0] || {};
        const assets = assetSummary[0] || {};
        res.json({
            success: true,
            tickets: {
                total: tickets.total || 0,
                open: tickets.open || 0,
                inProgress: tickets.in_progress || 0,
                pending: tickets.pending || 0,
                resolved: tickets.resolved || 0,
                closed: tickets.closed || 0,
                urgentOpen: tickets.urgent_open || 0
            },
            ticketsByStatus: ticketsByStatus.recordset || [],
            ticketsByPriority: ticketsByPriority.recordset || [],
            ticketsPerMonth: mapMonthlyRows(ticketsPerMonth.recordset),
            assets: {
                total: assets.total || 0,
                available: assets.available || 0,
                assigned: assets.assigned || 0,
                forInspection: assets.for_inspection || 0,
                returned: assets.returned || 0,
                pulledOut: assets.pulled_out || 0,
                underRepair: assets.under_repair || 0,
                retired: assets.retired || 0,
                lost: assets.lost || 0
            },
            assetsByStatus,
            assetsByCategory,
            assetAssignmentsPerMonth: mapMonthlyRows(assetAssignmentsPerMonth),
            assetReturnsPerMonth: mapMonthlyRows(assetReturnsPerMonth),
            recentlyAssignedAssets,
            recentlyReturnedAssets
        });
    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
