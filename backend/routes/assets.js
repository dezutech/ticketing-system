const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');
const { notifyUsers } = require('../utils/notificationService');

const ASSET_STATUSES = ['Available', 'Assigned', 'For Inspection', 'Under Repair', 'Returned', 'Pulled Out', 'Retired', 'Lost'];
const MAINTENANCE_STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'];
const ASSET_MANAGER_ROLES = ['Super Admin', 'Admin', 'Staff'];

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.env.UPLOAD_PATH || './uploads', 'assets');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt|zip/;
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
        if (allowed.test(ext)) cb(null, true);
        else cb(new Error('File type not allowed'));
    }
});

function canManageAssets(user) {
    return ASSET_MANAGER_ROLES.includes(user?.role_name);
}

function requireAssetManager(req, res, next) {
    if (!canManageAssets(req.user)) {
        return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
    }
    next();
}

function isIntegerValue(value) {
    return value !== null && value !== '' && Number.isInteger(Number(value));
}

function isMissingObjectError(err) {
    return err?.number === 208 || /invalid object name/i.test(err?.message || '');
}

function isOptionalSchemaError(err) {
    return isMissingObjectError(err) || err?.number === 207 || /invalid column name/i.test(err?.message || '');
}

async function optionalQuery(queryString, inputs = {}, fallback = []) {
    try {
        const result = await query(queryString, inputs);
        return result.recordset;
    } catch (err) {
        if (!isOptionalSchemaError(err)) throw err;
        console.warn('Optional asset table not found; returning empty related data.');
        return fallback;
    }
}

async function optionalExecute(queryString, inputs = {}) {
    try {
        return await query(queryString, inputs);
    } catch (err) {
        if (!isOptionalSchemaError(err)) throw err;
        console.warn('Optional asset table not found; skipped related write.');
        return null;
    }
}

function validateAssetPayload(body, isUpdate = false) {
    if (!isUpdate && (!body.asset_tag || !body.asset_name)) {
        return 'Asset tag and asset name required.';
    }
    if (body.asset_tag !== undefined && !String(body.asset_tag).trim()) {
        return 'Asset tag required.';
    }
    if (body.asset_name !== undefined && !String(body.asset_name).trim()) {
        return 'Asset name required.';
    }
    if (body.status !== undefined && !ASSET_STATUSES.includes(body.status)) {
        return 'Invalid asset status.';
    }
    if (body.category_id && !isIntegerValue(body.category_id)) {
        return 'Invalid asset category.';
    }
    if (body.assigned_to && !isIntegerValue(body.assigned_to)) {
        return 'Invalid assigned user.';
    }
    if (body.status && ['Available', 'For Inspection', 'Returned', 'Pulled Out', 'Retired', 'Lost'].includes(body.status)) {
        body.assigned_to = null;
        body.department = '';
    }
    return null;
}

function assetInputs(body) {
    return {
        tag: { type: sql.NVarChar, value: body.asset_tag },
        name: { type: sql.NVarChar, value: body.asset_name },
        category: { type: sql.Int, value: body.category_id || null },
        brand: { type: sql.NVarChar, value: body.brand || null },
        model: { type: sql.NVarChar, value: body.model || null },
        serial: { type: sql.NVarChar, value: body.serial_number || null },
        status: { type: sql.NVarChar, value: body.status || 'Available' },
        assignedTo: { type: sql.Int, value: body.assigned_to || null },
        department: { type: sql.NVarChar, value: body.department || null },
        location: { type: sql.NVarChar, value: body.location || null },
        purchaseDate: { type: sql.Date, value: body.purchase_date || null },
        warrantyExpiry: { type: sql.Date, value: body.warranty_expiry || null },
        supplier: { type: sql.NVarChar, value: body.supplier || null },
        notes: { type: sql.NVarChar, value: body.notes || null }
    };
}

function valueForLog(value) {
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

async function getLatestAssetTicket(assetId) {
    const tickets = await optionalQuery(`
        SELECT TOP 1 t.ticket_id
        FROM ticket_assets ta
        JOIN Tickets t ON ta.ticket_id = t.ticket_id
        WHERE ta.asset_id = @assetId
        ORDER BY t.created_at DESC
    `, {
        assetId: { type: sql.Int, value: assetId }
    });
    return tickets[0]?.ticket_id || null;
}

async function logAssetActivity(assetId, action, oldValue, newValue, userId, ticketId = null) {
    const inputs = {
        assetId: { type: sql.Int, value: assetId },
        action: { type: sql.NVarChar, value: action },
        oldValue: { type: sql.NVarChar, value: valueForLog(oldValue) },
        newValue: { type: sql.NVarChar, value: valueForLog(newValue) },
        userId: { type: sql.Int, value: userId || null },
        ticketId: { type: sql.Int, value: ticketId || null }
    };

    const result = await optionalExecute(`
        INSERT INTO asset_activity_logs (asset_id, action, old_value, new_value, changed_by, ticket_id)
        VALUES (@assetId, @action, @oldValue, @newValue, @userId, @ticketId)
    `, inputs);

    if (!result) {
        await optionalExecute(`
            INSERT INTO asset_activity_logs (asset_id, action, old_value, new_value, changed_by)
            VALUES (@assetId, @action, @oldValue, @newValue, @userId)
        `, inputs);
    }
}

async function markAssignmentReturned(assetId, assignedTo, returnStatus, returnCondition, ticketId, notes) {
    const inputs = {
        assetId: { type: sql.Int, value: assetId },
        assignedTo: { type: sql.Int, value: assignedTo },
        returnStatus: { type: sql.NVarChar, value: returnStatus || 'Returned' },
        condition: { type: sql.NVarChar, value: returnCondition || null },
        ticketId: { type: sql.Int, value: ticketId || null },
        notes: { type: sql.NVarChar, value: notes || null }
    };

    const result = await optionalExecute(`
        UPDATE asset_assignments
        SET returned_at = GETDATE(),
            return_status = @returnStatus,
            return_condition = @condition,
            return_ticket_id = @ticketId,
            return_notes = @notes,
            updated_at = GETDATE()
        WHERE asset_id = @assetId AND assigned_to = @assignedTo AND returned_at IS NULL
    `, inputs);

    if (!result) {
        await optionalExecute(`
            UPDATE asset_assignments
            SET returned_at = GETDATE(), return_condition = @condition, updated_at = GETDATE()
            WHERE asset_id = @assetId AND assigned_to = @assignedTo AND returned_at IS NULL
        `, inputs);
    }
}

function returnedInspectionWarningSql(alias = 'latestReturn') {
    return `
        CASE
            WHEN a.status = 'Returned'
                AND ${alias}.returned_at IS NOT NULL
                AND DATEDIFF(day, ${alias}.returned_at, GETDATE()) > 7
            THEN 1 ELSE 0
        END AS returned_inspection_warning,
        ${alias}.returned_at AS latest_returned_at
    `;
}

async function saveAssetAttachments(assetId, files, userId) {
    if (!files?.length) return;
    for (const file of files) {
        await optionalExecute(`
            INSERT INTO asset_attachments (asset_id, file_name, original_name, file_type, file_size, file_path, uploaded_by)
            VALUES (@assetId, @fileName, @originalName, @fileType, @fileSize, @filePath, @userId)
        `, {
            assetId: { type: sql.Int, value: assetId },
            fileName: { type: sql.NVarChar, value: file.filename },
            originalName: { type: sql.NVarChar, value: file.originalname },
            fileType: { type: sql.NVarChar, value: file.mimetype },
            fileSize: { type: sql.BigInt, value: file.size },
            filePath: { type: sql.NVarChar, value: file.path },
            userId: { type: sql.Int, value: userId || null }
        });
    }
}

// GET /api/assets/categories
router.get('/categories', authenticateToken, async (req, res) => {
    try {
        const result = await query(`
            SELECT category_id, category_name, description, is_active, created_at, updated_at
            FROM asset_categories
            ORDER BY is_active DESC, category_name
        `);
        res.json({ success: true, categories: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/assets/assignable-users
router.get('/assignable-users', authenticateToken, requireAssetManager, async (req, res) => {
    try {
        const result = await query(`
            SELECT u.user_id, u.full_name, u.email, u.department, u.position, u.branch,
                   r.role_id, r.role_name
            FROM Users u
            JOIN Roles r ON u.role_id = r.role_id
            WHERE u.is_active = 1
            ORDER BY full_name
        `);
        res.json({ success: true, users: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/assets/attachments/:id/download
router.get('/attachments/:id/download', authenticateToken, async (req, res) => {
    try {
        const result = await optionalQuery(`
            SELECT aa.*, a.assigned_to,
                CASE WHEN EXISTS (
                    SELECT 1 FROM asset_assignments hist
                    WHERE hist.asset_id = aa.asset_id AND hist.assigned_to = @currentUserId
                ) THEN 1 ELSE 0 END AS was_assigned_to_user
            FROM asset_attachments aa
            JOIN assets a ON aa.asset_id = a.asset_id
            WHERE aa.attachment_id = @id
        `, {
            id: { type: sql.Int, value: req.params.id },
            currentUserId: { type: sql.Int, value: req.user.user_id }
        });
        if (!result.length) return res.status(404).json({ success: false, message: 'File not found.' });

        const file = result[0];
        if (!canManageAssets(req.user) && file.assigned_to !== req.user.user_id && !file.was_assigned_to_user) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }
        res.download(file.file_path, file.original_name);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/assets/activity-logs
router.get('/activity-logs', authenticateToken, requireAssetManager, async (req, res) => {
    try {
        const activityLogs = await optionalQuery(`
            SELECT TOP 200 aal.*, a.asset_tag, a.asset_name, u.full_name AS changed_by_name,
                   t.ticket_number AS related_ticket_number
            FROM asset_activity_logs aal
            JOIN assets a ON aal.asset_id = a.asset_id
            LEFT JOIN Users u ON aal.changed_by = u.user_id
            LEFT JOIN Tickets t ON aal.ticket_id = t.ticket_id
            ORDER BY aal.created_at DESC
        `);
        res.json({ success: true, activity_logs: activityLogs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/assets
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { search, status, category_id, department, assigned_to } = req.query;
        const conditions = [];
        const inputs = {};
        const isManager = canManageAssets(req.user);

        if (status && !ASSET_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid asset status.' });
        }
        if (category_id && !isIntegerValue(category_id)) {
            return res.status(400).json({ success: false, message: 'Invalid asset category.' });
        }
        if (assigned_to && assigned_to !== 'unassigned' && !isIntegerValue(assigned_to)) {
            return res.status(400).json({ success: false, message: 'Invalid assigned user.' });
        }

        if (search) {
            conditions.push(`(
                a.asset_tag LIKE @search OR a.asset_name LIKE @search OR
                a.brand LIKE @search OR a.model LIKE @search OR a.serial_number LIKE @search
            )`);
            inputs.search = { type: sql.NVarChar, value: `%${search}%` };
        }
        if (status) {
            conditions.push('a.status = @status');
            inputs.status = { type: sql.NVarChar, value: status };
        }
        if (category_id) {
            conditions.push('a.category_id = @categoryId');
            inputs.categoryId = { type: sql.Int, value: category_id };
        }
        if (department) {
            conditions.push('a.department = @department');
            inputs.department = { type: sql.NVarChar, value: department };
        }
        if (!isManager) {
            conditions.push('a.assigned_to = @currentUserId');
            conditions.push(`a.status = 'Assigned'`);
            inputs.currentUserId = { type: sql.Int, value: req.user.user_id };
        } else if (assigned_to === 'unassigned') {
            conditions.push('a.assigned_to IS NULL');
        } else if (assigned_to) {
            conditions.push('a.assigned_to = @assignedTo');
            inputs.assignedTo = { type: sql.Int, value: assigned_to };
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await query(`
            SELECT a.*, ac.category_name, u.full_name AS assigned_to_name,
                   ${returnedInspectionWarningSql('latestReturn')}
            FROM assets a
            LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
            LEFT JOIN Users u ON a.assigned_to = u.user_id
            OUTER APPLY (
                SELECT TOP 1 aa.returned_at
                FROM asset_assignments aa
                WHERE aa.asset_id = a.asset_id AND aa.returned_at IS NOT NULL
                ORDER BY aa.returned_at DESC
            ) latestReturn
            ${where}
            ORDER BY a.created_at DESC
        `, inputs);

        let returnedAssets = [];
        if (!isManager) {
            returnedAssets = await optionalQuery(`
                SELECT a.*, ac.category_name, u.full_name AS assigned_to_name,
                    aa.assigned_at, aa.returned_at, aa.return_condition,
                    CAST('Returned' AS NVARCHAR(30)) AS return_status, aa.return_notes,
                    COALESCE(rt.ticket_id, lt.ticket_id) AS related_ticket_id,
                    COALESCE(rt.ticket_number, lt.ticket_number) AS related_ticket_number,
                    COALESCE(rt.title, lt.title) AS related_ticket_title,
                    COALESCE(rt.status, lt.status) AS related_ticket_status,
                    COALESCE(rt.created_at, lt.created_at) AS related_ticket_created_at,
                    COALESCE(rt.resolved_at, lt.resolved_at) AS related_ticket_resolved_at,
                    COALESCE(rc.category_name, lc.category_name) AS related_ticket_category,
                    COALESCE(rt.resolution_notes, lt.resolution_notes) AS related_ticket_notes,
                    CAST(0 AS BIT) AS returned_inspection_warning,
                    aa.returned_at AS latest_returned_at
                FROM asset_assignments aa
                JOIN assets a ON aa.asset_id = a.asset_id
                LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
                LEFT JOIN Users u ON a.assigned_to = u.user_id
                LEFT JOIN Tickets rt ON aa.return_ticket_id = rt.ticket_id
                LEFT JOIN Categories rc ON rt.category_id = rc.category_id
                OUTER APPLY (
                    SELECT TOP 1 t.*
                    FROM ticket_assets ta
                    JOIN Tickets t ON ta.ticket_id = t.ticket_id
                    WHERE ta.asset_id = a.asset_id
                    ORDER BY t.created_at DESC
                ) lt
                LEFT JOIN Categories lc ON lt.category_id = lc.category_id
                WHERE aa.assigned_to = @currentUserId
                    AND aa.returned_at IS NOT NULL
                    AND (a.assigned_to IS NULL OR a.assigned_to <> @currentUserId OR a.status IN ('Returned', 'For Inspection', 'Pulled Out', 'Retired', 'Lost'))
                ORDER BY aa.returned_at DESC
            `, {
                currentUserId: { type: sql.Int, value: req.user.user_id }
            });
        }

        res.json({ success: true, assets: result.recordset, returned_assets: returnedAssets });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/assets/:id
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        if (!isIntegerValue(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid asset.' });
        }

        const inputs = { id: { type: sql.Int, value: req.params.id } };
        const result = await query(`
            SELECT a.*, ac.category_name, u.full_name AS assigned_to_name, u.email AS assigned_to_email,
                   ${returnedInspectionWarningSql('latestReturn')}
            FROM assets a
            LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
            LEFT JOIN Users u ON a.assigned_to = u.user_id
            OUTER APPLY (
                SELECT TOP 1 aa.returned_at
                FROM asset_assignments aa
                WHERE aa.asset_id = a.asset_id AND aa.returned_at IS NOT NULL
                ORDER BY aa.returned_at DESC
            ) latestReturn
            WHERE a.asset_id = @id
        `, inputs);

        if (!result.recordset.length) {
            return res.status(404).json({ success: false, message: 'Asset not found.' });
        }

        const asset = result.recordset[0];
        const isManager = canManageAssets(req.user);
        const isCurrentUserAsset = asset.assigned_to === req.user.user_id && asset.status === 'Assigned';
        let userAssetHistory = [];
        if (!isManager) {
            userAssetHistory = await optionalQuery(`
                SELECT TOP 1 assignment_id, returned_at, return_status, return_condition, return_notes, return_ticket_id
                FROM asset_assignments
                WHERE asset_id = @id AND assigned_to = @currentUserId
                ORDER BY ISNULL(returned_at, assigned_at) DESC
            `, {
                id: { type: sql.Int, value: req.params.id },
                currentUserId: { type: sql.Int, value: req.user.user_id }
            });

            if (!isCurrentUserAsset && !userAssetHistory.length) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }
        }

        let assignments = await optionalQuery(`
            SELECT aa.*, assigned.full_name AS assigned_to_name, assigner.full_name AS assigned_by_name,
                   t.ticket_id AS related_ticket_id, t.ticket_number AS related_ticket_number,
                   t.title AS related_ticket_title, t.status AS related_ticket_status,
                   t.created_at AS related_ticket_created_at, t.resolved_at AS related_ticket_resolved_at,
                   c.category_name AS related_ticket_category, t.resolution_notes AS related_ticket_notes
            FROM asset_assignments aa
            LEFT JOIN Users assigned ON aa.assigned_to = assigned.user_id
            LEFT JOIN Users assigner ON aa.assigned_by = assigner.user_id
            LEFT JOIN Tickets t ON aa.return_ticket_id = t.ticket_id
            LEFT JOIN Categories c ON t.category_id = c.category_id
            WHERE aa.asset_id = @id
            ${isManager ? '' : 'AND aa.assigned_to = @currentUserId'}
            ORDER BY aa.assigned_at DESC
        `, {
            ...inputs,
            currentUserId: { type: sql.Int, value: req.user.user_id }
        });

        const maintenance = await optionalQuery(`
            SELECT aml.*, u.full_name AS performed_by_name
            FROM asset_maintenance_logs aml
            LEFT JOIN Users u ON aml.performed_by = u.user_id
            WHERE aml.asset_id = @id
            ORDER BY aml.maintenance_date DESC
        `, inputs);

        const ticketScope = isManager ? '' : 'AND (t.created_by = @currentUserId OR t.assigned_to = @currentUserId)';
        const ticketInputs = {
            id: { type: sql.Int, value: req.params.id },
            currentUserId: { type: sql.Int, value: req.user.user_id }
        };
        const tickets = await optionalQuery(`
            SELECT t.ticket_id, t.ticket_number, t.title, t.status, t.priority, t.created_at,
                   t.resolved_at, t.resolution_notes, c.category_name,
                   creator.full_name AS created_by_name, assignee.full_name AS assigned_to_name
            FROM ticket_assets ta
            JOIN Tickets t ON ta.ticket_id = t.ticket_id
            LEFT JOIN Categories c ON t.category_id = c.category_id
            LEFT JOIN Users creator ON t.created_by = creator.user_id
            LEFT JOIN Users assignee ON t.assigned_to = assignee.user_id
            WHERE ta.asset_id = @id
            ${ticketScope}
            ORDER BY t.created_at DESC
        `, ticketInputs);

        let activity = await optionalQuery(`
            SELECT aal.*, u.full_name AS changed_by_name, u.role_id AS changed_by_role_id,
                   r.role_name AS changed_by_role_name,
                   t.ticket_id AS related_ticket_id, t.ticket_number AS related_ticket_number,
                   COALESCE(newAssigned.full_name, oldAssigned.full_name) AS assigned_employee_name,
                   COALESCE(newAssigned.user_id, oldAssigned.user_id) AS assigned_employee_id
            FROM asset_activity_logs aal
            LEFT JOIN Users u ON aal.changed_by = u.user_id
            LEFT JOIN Roles r ON u.role_id = r.role_id
            LEFT JOIN Tickets t ON aal.ticket_id = t.ticket_id
            LEFT JOIN Users newAssigned ON TRY_CONVERT(INT, aal.new_value) = newAssigned.user_id
            LEFT JOIN Users oldAssigned ON TRY_CONVERT(INT, aal.old_value) = oldAssigned.user_id
            WHERE aal.asset_id = @id
            ORDER BY aal.created_at DESC
        `, inputs);

        if (!isManager && !isCurrentUserAsset) {
            assignments = assignments.map(item => ({ ...item, return_status: item.returned_at ? 'Returned' : item.return_status }));
            asset.status = 'Returned';
            asset.assigned_to = null;
            asset.assigned_to_name = null;
            activity = activity
                .filter(item => String(item.action || '').toLowerCase().includes('returned'))
                .map(item => ({ ...item, action: 'Asset returned', old_value: null, new_value: 'Returned' }));
        }
        const attachments = await optionalQuery(`
            SELECT aa.*, u.full_name AS uploaded_by_name
            FROM asset_attachments aa
            LEFT JOIN Users u ON aa.uploaded_by = u.user_id
            WHERE aa.asset_id = @id
            ORDER BY aa.uploaded_at DESC
        `, inputs);

        res.json({
            success: true,
            asset,
            is_currently_assigned_to_user: isCurrentUserAsset,
            user_asset_history: userAssetHistory,
            assignments,
            maintenance_logs: maintenance,
            tickets,
            activity_logs: activity,
            asset_history: activity,
            attachments
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/assets
router.post('/', authenticateToken, requireAssetManager, upload.array('attachments', 5), async (req, res) => {
    try {
        const validationError = validateAssetPayload(req.body);
        if (validationError) return res.status(400).json({ success: false, message: validationError });

        const result = await query(`
            INSERT INTO assets (
                asset_tag, asset_name, category_id, brand, model, serial_number, status,
                assigned_to, department, location, purchase_date, warranty_expiry, supplier, notes
            )
            OUTPUT INSERTED.asset_id
            VALUES (
                @tag, @name, @category, @brand, @model, @serial, @status,
                @assignedTo, @department, @location, @purchaseDate, @warrantyExpiry, @supplier, @notes
            )
        `, assetInputs(req.body));

        const assetId = result.recordset[0].asset_id;
        await saveAssetAttachments(assetId, req.files, req.user.user_id);
        await logAssetActivity(assetId, 'Asset created', null, {
            asset_tag: req.body.asset_tag,
            asset_name: req.body.asset_name,
            status: req.body.status || 'Available'
        }, req.user.user_id);
        await logActivity(req.user, 'Asset created', 'Assets', assetId, {
            asset_tag: req.body.asset_tag,
            asset_name: req.body.asset_name,
            status: req.body.status || 'Available'
        });

        if (req.body.assigned_to) {
            await optionalExecute(`
                INSERT INTO asset_assignments (asset_id, assigned_to, assigned_by, department, location, notes)
                VALUES (@assetId, @assignedTo, @assignedBy, @department, @location, @notes)
            `, {
                assetId: { type: sql.Int, value: assetId },
                assignedTo: { type: sql.Int, value: req.body.assigned_to },
                assignedBy: { type: sql.Int, value: req.user.user_id },
                department: { type: sql.NVarChar, value: req.body.department || null },
                location: { type: sql.NVarChar, value: req.body.location || null },
                notes: { type: sql.NVarChar, value: 'Assigned during asset creation.' }
            });
            await logAssetActivity(assetId, 'Asset assigned', null, req.body.assigned_to, req.user.user_id);
            await logActivity(req.user, 'Asset assigned', 'Assets', assetId, {
                assigned_to: req.body.assigned_to,
                source: 'creation'
            });
            await notifyUsers(
                [req.body.assigned_to],
                `Asset ${req.body.asset_tag} was assigned to you.`,
                'Assets',
                assetId,
                `asset:${assetId}`
            );
        }

        res.json({ success: true, message: 'Asset created.', asset_id: assetId });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(400).json({ success: false, message: 'Asset tag already exists.' });
        }
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PATCH /api/assets/:id
router.patch('/:id', authenticateToken, requireAssetManager, upload.array('attachments', 5), async (req, res) => {
    try {
        if (!isIntegerValue(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid asset.' });
        }

        const body = req.body;
        const validationError = validateAssetPayload(body, true);
        if (validationError) return res.status(400).json({ success: false, message: validationError });

        const existing = await query(`SELECT * FROM assets WHERE asset_id = @id`, {
            id: { type: sql.Int, value: req.params.id }
        });
        if (!existing.recordset.length) return res.status(404).json({ success: false, message: 'Asset not found.' });
        const oldAsset = existing.recordset[0];
        const finalStatus = body.status || oldAsset.status;
        const returnLikeStatuses = ['Returned', 'For Inspection', 'Pulled Out'];
        const unassignedStatuses = ['Available', 'For Inspection', 'Returned', 'Pulled Out', 'Retired', 'Lost'];
        const relatedTicketId = body.ticket_id || body.return_ticket_id || await getLatestAssetTicket(req.params.id);

        if (unassignedStatuses.includes(finalStatus)) {
            body.assigned_to = null;
        }
        if (returnLikeStatuses.includes(finalStatus) && !body.return_status) {
            body.return_status = finalStatus;
        }

        const updates = [];
        const inputs = { id: { type: sql.Int, value: req.params.id } };

        const fields = {
            asset_tag: ['asset_tag = @tag', 'tag', sql.NVarChar],
            asset_name: ['asset_name = @name', 'name', sql.NVarChar],
            category_id: ['category_id = @category', 'category', sql.Int],
            brand: ['brand = @brand', 'brand', sql.NVarChar],
            model: ['model = @model', 'model', sql.NVarChar],
            serial_number: ['serial_number = @serial', 'serial', sql.NVarChar],
            status: ['status = @status', 'status', sql.NVarChar],
            assigned_to: ['assigned_to = @assignedTo', 'assignedTo', sql.Int],
            department: ['department = @department', 'department', sql.NVarChar],
            location: ['location = @location', 'location', sql.NVarChar],
            purchase_date: ['purchase_date = @purchaseDate', 'purchaseDate', sql.Date],
            warranty_expiry: ['warranty_expiry = @warrantyExpiry', 'warrantyExpiry', sql.Date],
            supplier: ['supplier = @supplier', 'supplier', sql.NVarChar],
            notes: ['notes = @notes', 'notes', sql.NVarChar]
        };

        for (const [field, [sqlUpdate, inputName, type]] of Object.entries(fields)) {
            if (body[field] !== undefined) {
                updates.push(sqlUpdate);
                inputs[inputName] = { type, value: body[field] || null };
            }
        }

        if (!updates.length) return res.status(400).json({ success: false, message: 'No updates provided.' });
        updates.push('updated_at = GETDATE()');

        await query(`UPDATE assets SET ${updates.join(', ')} WHERE asset_id = @id`, inputs);
        await saveAssetAttachments(req.params.id, req.files, req.user.user_id);
        await logAssetActivity(req.params.id, 'Asset updated', oldAsset, body, req.user.user_id, relatedTicketId);
        await logActivity(req.user, 'Asset edited', 'Assets', req.params.id, {
            fields: updates.filter(field => field !== 'updated_at = GETDATE()').map(field => field.split('=')[0].trim()),
            related_ticket_id: relatedTicketId
        });

        if (body.status !== undefined && body.status !== oldAsset.status) {
            const action = returnLikeStatuses.includes(body.status) ? (body.status === 'For Inspection' ? 'Asset returned for inspection' : `Asset ${body.status}`) : (body.status === 'Under Repair' ? 'Asset sent for repair' : 'Status changed');
            await logAssetActivity(req.params.id, action, oldAsset.status, body.status, req.user.user_id, relatedTicketId);
            await logActivity(req.user, body.status === 'Pulled Out' ? 'Asset pull-out' : (['Returned', 'For Inspection'].includes(body.status) ? 'Asset returned' : (body.status === 'Under Repair' ? 'Asset sent for repair' : 'Asset status changed')), 'Assets', req.params.id, {
                from: oldAsset.status,
                to: body.status,
                related_ticket_id: relatedTicketId
            });
        }

        if (body.assigned_to !== undefined && String(body.assigned_to || '') !== String(oldAsset.assigned_to || '')) {
            if (oldAsset.assigned_to && !body.assigned_to) {
                await markAssignmentReturned(
                    req.params.id,
                    oldAsset.assigned_to,
                    body.return_status || (body.status === 'Pulled Out' ? 'Pulled Out' : (body.status === 'For Inspection' ? 'For Inspection' : 'Returned')),
                    body.return_condition,
                    relatedTicketId,
                    body.return_notes || body.notes
                );
                await logAssetActivity(
                    req.params.id,
                    body.status === 'Pulled Out' ? 'Asset pulled out' : 'Asset returned',
                    oldAsset.assigned_to,
                    null,
                    req.user.user_id,
                    relatedTicketId
                );
                await logActivity(req.user, body.status === 'Pulled Out' ? 'Asset pull-out' : 'Asset returned', 'Assets', req.params.id, {
                    previous_assigned_to: oldAsset.assigned_to,
                    related_ticket_id: relatedTicketId
                });
                await notifyUsers(
                    [oldAsset.assigned_to],
                    `Asset ${oldAsset.asset_tag} was ${body.status === 'Pulled Out' ? 'pulled out' : 'returned'}.`,
                    'Assets',
                    req.params.id,
                    `asset:${req.params.id}`
                );
            } else if (body.assigned_to) {
                if (oldAsset.assigned_to) {
                    await optionalExecute(`
                        UPDATE asset_assignments
                        SET returned_at = GETDATE(), updated_at = GETDATE()
                        WHERE asset_id = @assetId AND returned_at IS NULL
                    `, {
                        assetId: { type: sql.Int, value: req.params.id }
                    });
                }
                await optionalExecute(`
                    INSERT INTO asset_assignments (asset_id, assigned_to, assigned_by, department, location)
                    VALUES (@assetId, @assignedTo, @assignedBy, @department, @location)
                `, {
                    assetId: { type: sql.Int, value: req.params.id },
                    assignedTo: { type: sql.Int, value: body.assigned_to },
                    assignedBy: { type: sql.Int, value: req.user.user_id },
                    department: { type: sql.NVarChar, value: body.department || oldAsset.department || null },
                    location: { type: sql.NVarChar, value: body.location || oldAsset.location || null }
                });
                await logAssetActivity(req.params.id, 'Asset assigned', oldAsset.assigned_to, body.assigned_to, req.user.user_id);
                await logActivity(req.user, 'Asset assigned', 'Assets', req.params.id, {
                    from: oldAsset.assigned_to,
                    to: body.assigned_to
                });
                await notifyUsers(
                    [body.assigned_to],
                    `Asset ${oldAsset.asset_tag} was assigned to you.`,
                    'Assets',
                    req.params.id,
                    `asset:${req.params.id}`
                );
            }
        }

        res.json({ success: true, message: 'Asset updated.' });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) {
            return res.status(400).json({ success: false, message: 'Asset tag already exists.' });
        }
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PATCH /api/assets/:id/mark-available
router.patch('/:id/mark-available', authenticateToken, requireAssetManager, async (req, res) => {
    try {
        if (!isIntegerValue(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid asset.' });
        }

        const existing = await query(`SELECT * FROM assets WHERE asset_id = @id`, {
            id: { type: sql.Int, value: req.params.id }
        });
        if (!existing.recordset.length) return res.status(404).json({ success: false, message: 'Asset not found.' });

        const asset = existing.recordset[0];
        if (!['Returned', 'For Inspection', 'Under Repair'].includes(asset.status)) {
            return res.status(400).json({ success: false, message: 'Only returned, inspected, or repaired assets can be marked as available.' });
        }

        await query(`
            UPDATE assets
            SET status = 'Available',
                assigned_to = NULL,
                department = NULL,
                updated_at = GETDATE()
            WHERE asset_id = @id
        `, {
            id: { type: sql.Int, value: req.params.id }
        });

        await logAssetActivity(req.params.id, 'Asset marked as available', asset.status, 'Available', req.user.user_id);
        await logActivity(req.user, 'Asset marked as available', 'Assets', req.params.id, {
            from: asset.status,
            to: 'Available'
        });

        res.json({ success: true, message: 'Asset marked as available.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/assets/:id/maintenance
router.post('/:id/maintenance', authenticateToken, requireAssetManager, async (req, res) => {
    try {
        if (!isIntegerValue(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid asset.' });
        }
        if (!req.body.description) {
            return res.status(400).json({ success: false, message: 'Maintenance description required.' });
        }
        if (req.body.status && !MAINTENANCE_STATUSES.includes(req.body.status)) {
            return res.status(400).json({ success: false, message: 'Invalid maintenance status.' });
        }

        const asset = await query(`SELECT asset_id FROM assets WHERE asset_id = @id`, {
            id: { type: sql.Int, value: req.params.id }
        });
        if (!asset.recordset.length) return res.status(404).json({ success: false, message: 'Asset not found.' });

        await query(`
            INSERT INTO asset_maintenance_logs (
                asset_id, maintenance_type, description, performed_by, vendor, cost,
                maintenance_date, next_maintenance_date, status, notes
            )
            VALUES (
                @assetId, @type, @description, @performedBy, @vendor, @cost,
                @maintenanceDate, @nextMaintenanceDate, @status, @notes
            )
        `, {
            assetId: { type: sql.Int, value: req.params.id },
            type: { type: sql.NVarChar, value: req.body.maintenance_type || null },
            description: { type: sql.NVarChar, value: req.body.description },
            performedBy: { type: sql.Int, value: req.user.user_id },
            vendor: { type: sql.NVarChar, value: req.body.vendor || null },
            cost: { type: sql.Decimal(18, 2), value: req.body.cost || null },
            maintenanceDate: { type: sql.DateTime, value: req.body.maintenance_date || null },
            nextMaintenanceDate: { type: sql.DateTime, value: req.body.next_maintenance_date || null },
            status: { type: sql.NVarChar, value: req.body.status || 'Completed' },
            notes: { type: sql.NVarChar, value: req.body.notes || null }
        });

        await logAssetActivity(req.params.id, 'Maintenance log added', null, req.body.description, req.user.user_id);
        res.json({ success: true, message: 'Maintenance log added.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE /api/assets/:id
router.delete('/:id', authenticateToken, requireAssetManager, async (req, res) => {
    try {
        if (!isIntegerValue(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid asset.' });
        }

        const existing = await query(`SELECT * FROM assets WHERE asset_id = @id`, {
            id: { type: sql.Int, value: req.params.id }
        });
        if (!existing.recordset.length) return res.status(404).json({ success: false, message: 'Asset not found.' });

        await query(`
            UPDATE assets
            SET status = 'Retired', assigned_to = NULL, updated_at = GETDATE()
            WHERE asset_id = @id
        `, {
            id: { type: sql.Int, value: req.params.id }
        });

        await optionalExecute(`
            UPDATE asset_assignments
            SET returned_at = GETDATE(), return_condition = @condition, updated_at = GETDATE()
            WHERE asset_id = @id AND returned_at IS NULL
        `, {
            id: { type: sql.Int, value: req.params.id },
            condition: { type: sql.NVarChar, value: 'Asset retired/deleted.' }
        });

        await logAssetActivity(req.params.id, 'Asset deleted', existing.recordset[0], 'Retired', req.user.user_id);
        await logActivity(req.user, 'Asset retired', 'Assets', req.params.id, {
            previous_status: existing.recordset[0].status
        });
        res.json({ success: true, message: 'Asset retired.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
