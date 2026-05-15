const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const ASSET_STATUSES = ['Available', 'Assigned', 'Under Repair', 'Retired', 'Lost'];
const MAINTENANCE_STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'];
const ASSET_MANAGER_ROLES = ['Super Admin', 'Admin', 'Staff'];

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

async function logAssetActivity(assetId, action, oldValue, newValue, userId) {
    await query(`
        INSERT INTO asset_activity_logs (asset_id, action, old_value, new_value, changed_by)
        VALUES (@assetId, @action, @oldValue, @newValue, @userId)
    `, {
        assetId: { type: sql.Int, value: assetId },
        action: { type: sql.NVarChar, value: action },
        oldValue: { type: sql.NVarChar, value: valueForLog(oldValue) },
        newValue: { type: sql.NVarChar, value: valueForLog(newValue) },
        userId: { type: sql.Int, value: userId || null }
    });
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
            SELECT user_id, full_name, email, department
            FROM Users
            WHERE is_active = 1
            ORDER BY full_name
        `);
        res.json({ success: true, users: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/assets/activity-logs
router.get('/activity-logs', authenticateToken, requireAssetManager, async (req, res) => {
    try {
        const result = await query(`
            SELECT TOP 200 aal.*, a.asset_tag, a.asset_name, u.full_name AS changed_by_name
            FROM asset_activity_logs aal
            JOIN assets a ON aal.asset_id = a.asset_id
            LEFT JOIN Users u ON aal.changed_by = u.user_id
            ORDER BY aal.created_at DESC
        `);
        res.json({ success: true, activity_logs: result.recordset });
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
            inputs.currentUserId = { type: sql.Int, value: req.user.user_id };
        } else if (assigned_to === 'unassigned') {
            conditions.push('a.assigned_to IS NULL');
        } else if (assigned_to) {
            conditions.push('a.assigned_to = @assignedTo');
            inputs.assignedTo = { type: sql.Int, value: assigned_to };
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await query(`
            SELECT a.*, ac.category_name, u.full_name AS assigned_to_name
            FROM assets a
            LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
            LEFT JOIN Users u ON a.assigned_to = u.user_id
            ${where}
            ORDER BY a.created_at DESC
        `, inputs);

        res.json({ success: true, assets: result.recordset });
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
            SELECT a.*, ac.category_name, u.full_name AS assigned_to_name, u.email AS assigned_to_email
            FROM assets a
            LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
            LEFT JOIN Users u ON a.assigned_to = u.user_id
            WHERE a.asset_id = @id
        `, inputs);

        if (!result.recordset.length) {
            return res.status(404).json({ success: false, message: 'Asset not found.' });
        }

        const asset = result.recordset[0];
        if (!canManageAssets(req.user) && asset.assigned_to !== req.user.user_id) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const assignments = await query(`
            SELECT aa.*, assigned.full_name AS assigned_to_name, assigner.full_name AS assigned_by_name
            FROM asset_assignments aa
            LEFT JOIN Users assigned ON aa.assigned_to = assigned.user_id
            LEFT JOIN Users assigner ON aa.assigned_by = assigner.user_id
            WHERE aa.asset_id = @id
            ORDER BY aa.assigned_at DESC
        `, inputs);

        const maintenance = await query(`
            SELECT aml.*, u.full_name AS performed_by_name
            FROM asset_maintenance_logs aml
            LEFT JOIN Users u ON aml.performed_by = u.user_id
            WHERE aml.asset_id = @id
            ORDER BY aml.maintenance_date DESC
        `, inputs);

        const ticketScope = canManageAssets(req.user) ? '' : 'AND (t.created_by = @currentUserId OR t.assigned_to = @currentUserId)';
        const ticketInputs = {
            id: { type: sql.Int, value: req.params.id },
            currentUserId: { type: sql.Int, value: req.user.user_id }
        };
        const tickets = await query(`
            SELECT t.ticket_id, t.ticket_number, t.title, t.status, t.priority, t.created_at,
                   creator.full_name AS created_by_name, assignee.full_name AS assigned_to_name
            FROM ticket_assets ta
            JOIN Tickets t ON ta.ticket_id = t.ticket_id
            LEFT JOIN Users creator ON t.created_by = creator.user_id
            LEFT JOIN Users assignee ON t.assigned_to = assignee.user_id
            WHERE ta.asset_id = @id
            ${ticketScope}
            ORDER BY t.created_at DESC
        `, ticketInputs);

        const activity = canManageAssets(req.user)
            ? await query(`
                SELECT aal.*, u.full_name AS changed_by_name
                FROM asset_activity_logs aal
                LEFT JOIN Users u ON aal.changed_by = u.user_id
                WHERE aal.asset_id = @id
                ORDER BY aal.created_at DESC
            `, inputs)
            : { recordset: [] };

        res.json({
            success: true,
            asset,
            assignments: assignments.recordset,
            maintenance_logs: maintenance.recordset,
            tickets: tickets.recordset,
            activity_logs: activity.recordset
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/assets
router.post('/', authenticateToken, requireAssetManager, async (req, res) => {
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
        await logAssetActivity(assetId, 'Asset created', null, {
            asset_tag: req.body.asset_tag,
            asset_name: req.body.asset_name,
            status: req.body.status || 'Available'
        }, req.user.user_id);

        if (req.body.assigned_to) {
            await query(`
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
router.patch('/:id', authenticateToken, requireAssetManager, async (req, res) => {
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
        await logAssetActivity(req.params.id, 'Asset updated', oldAsset, body, req.user.user_id);

        if (body.status !== undefined && body.status !== oldAsset.status) {
            await logAssetActivity(req.params.id, 'Status changed', oldAsset.status, body.status, req.user.user_id);
        }

        if (body.assigned_to !== undefined && String(body.assigned_to || '') !== String(oldAsset.assigned_to || '')) {
            if (oldAsset.assigned_to && !body.assigned_to) {
                await query(`
                    UPDATE asset_assignments
                    SET returned_at = GETDATE(), return_condition = @condition, updated_at = GETDATE()
                    WHERE asset_id = @assetId AND assigned_to = @assignedTo AND returned_at IS NULL
                `, {
                    assetId: { type: sql.Int, value: req.params.id },
                    assignedTo: { type: sql.Int, value: oldAsset.assigned_to },
                    condition: { type: sql.NVarChar, value: body.return_condition || null }
                });
                await logAssetActivity(req.params.id, 'Asset returned', oldAsset.assigned_to, null, req.user.user_id);
            } else if (body.assigned_to) {
                if (oldAsset.assigned_to) {
                    await query(`
                        UPDATE asset_assignments
                        SET returned_at = GETDATE(), updated_at = GETDATE()
                        WHERE asset_id = @assetId AND returned_at IS NULL
                    `, {
                        assetId: { type: sql.Int, value: req.params.id }
                    });
                }
                await query(`
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

        await query(`
            UPDATE asset_assignments
            SET returned_at = GETDATE(), return_condition = @condition, updated_at = GETDATE()
            WHERE asset_id = @id AND returned_at IS NULL
        `, {
            id: { type: sql.Int, value: req.params.id },
            condition: { type: sql.NVarChar, value: 'Asset retired/deleted.' }
        });

        await logAssetActivity(req.params.id, 'Asset deleted', existing.recordset[0], 'Retired', req.user.user_id);
        res.json({ success: true, message: 'Asset retired.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
