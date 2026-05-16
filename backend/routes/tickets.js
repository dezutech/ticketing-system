// backend/routes/tickets.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query, sql } = require('../config/database');
const { authenticateToken, requirePermission } = require('../middleware/auth');

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = process.env.UPLOAD_PATH || './uploads';
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
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt|zip/;
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
        if (allowed.test(ext)) cb(null, true);
        else cb(new Error('File type not allowed'));
    }
});

// Helper: generate ticket number
async function generateTicketNumber() {
    const year = new Date().getFullYear();
    const result = await query(`SELECT COUNT(*) as cnt FROM Tickets WHERE YEAR(created_at) = ${year}`);
    const count = result.recordset[0].cnt + 1;
    return `TKT-${year}-${String(count).padStart(4, '0')}`;
}

function canManageAssets(user) {
    return ['Super Admin', 'Admin', 'Staff'].includes(user?.role_name);
}

function isMissingObjectError(err) {
    return err?.number === 208 || /invalid object name/i.test(err?.message || '');
}

async function linkTicketAsset(ticketId, assetId, user) {
    if (assetId && !Number.isInteger(Number(assetId))) {
        throw new Error('Invalid asset selected.');
    }

    const existing = await query(`
        SELECT ta.asset_id, a.asset_tag, a.asset_name, a.assigned_to
        FROM ticket_assets ta
        LEFT JOIN assets a ON ta.asset_id = a.asset_id
        WHERE ta.ticket_id = @ticketId
    `, {
        ticketId: { type: sql.Int, value: ticketId }
    });

    const oldAsset = existing.recordset[0] || null;

    if (!assetId) {
        if (oldAsset) {
            if (!canManageAssets(user) && oldAsset.assigned_to !== user.user_id) {
                throw new Error('You can only update tickets for assets assigned to your account.');
            }
            await query(`DELETE FROM ticket_assets WHERE ticket_id = @ticketId`, {
                ticketId: { type: sql.Int, value: ticketId }
            });
            await query(`
                INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value)
                VALUES (@ticketId, @userId, 'asset', @oldValue, NULL)
            `, {
                ticketId: { type: sql.Int, value: ticketId },
                userId: { type: sql.Int, value: user.user_id },
                oldValue: { type: sql.NVarChar, value: `${oldAsset.asset_tag} - ${oldAsset.asset_name}` }
            });
        }
        return;
    }

    const asset = await query(`SELECT asset_id, asset_tag, asset_name, assigned_to FROM assets WHERE asset_id = @assetId`, {
        assetId: { type: sql.Int, value: assetId }
    });
    if (!asset.recordset.length) throw new Error('Selected asset not found.');

    const newAsset = asset.recordset[0];
    if (!canManageAssets(user) && newAsset.assigned_to !== user.user_id) {
        throw new Error('You can only create tickets for assets assigned to your account.');
    }

    if (oldAsset && oldAsset.asset_id === parseInt(assetId)) return;

    if (oldAsset) {
        await query(`
            UPDATE ticket_assets SET asset_id = @assetId, linked_by = @userId, linked_at = GETDATE()
            WHERE ticket_id = @ticketId
        `, {
            ticketId: { type: sql.Int, value: ticketId },
            assetId: { type: sql.Int, value: assetId },
            userId: { type: sql.Int, value: user.user_id }
        });
    } else {
        await query(`
            INSERT INTO ticket_assets (ticket_id, asset_id, linked_by)
            VALUES (@ticketId, @assetId, @userId)
        `, {
            ticketId: { type: sql.Int, value: ticketId },
            assetId: { type: sql.Int, value: assetId },
            userId: { type: sql.Int, value: user.user_id }
        });
    }

    await query(`
        INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value)
        VALUES (@ticketId, @userId, 'asset', @oldValue, @newValue)
    `, {
        ticketId: { type: sql.Int, value: ticketId },
        userId: { type: sql.Int, value: user.user_id },
        oldValue: { type: sql.NVarChar, value: oldAsset ? `${oldAsset.asset_tag} - ${oldAsset.asset_name}` : null },
        newValue: { type: sql.NVarChar, value: `${newAsset.asset_tag} - ${newAsset.asset_name}` }
    });
}

// GET /api/tickets — list tickets
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { status, priority, assigned, search, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = [];
        let inputs = {};

        if (!req.user.can_view_all_tickets) {
            conditions.push('(t.created_by = @userId OR t.assigned_to = @userId)');
            inputs.userId = { type: sql.Int, value: req.user.user_id };
        }
        if (status) {
            conditions.push('t.status = @status');
            inputs.status = { type: sql.NVarChar, value: status };
        }
        if (priority) {
            conditions.push('t.priority = @priority');
            inputs.priority = { type: sql.NVarChar, value: priority };
        }
        if (assigned === 'unassigned') {
            conditions.push('t.assigned_to IS NULL');
        } else if (assigned === 'assigned') {
            conditions.push('t.assigned_to IS NOT NULL');
        }
        if (search) {
            conditions.push('(t.title LIKE @search OR t.ticket_number LIKE @search)');
            inputs.search = { type: sql.NVarChar, value: `%${search}%` };
        }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const countResult = await query(`SELECT COUNT(*) as total FROM Tickets t ${where}`, inputs);
        const total = countResult.recordset[0].total;

        const result = await query(`
            SELECT TOP ${limit} * FROM (
                SELECT ROW_NUMBER() OVER (ORDER BY t.created_at DESC) AS rn,
                    t.ticket_id, t.ticket_number, t.title, t.priority, t.status,
                    t.created_at, t.updated_at, t.resolved_at, t.due_date,
                    c.category_name,
                    creator.full_name AS created_by_name,
                    assignee.full_name AS assigned_to_name,
                    assignee.user_id AS assigned_to_id,
                    t.department,
                    (SELECT COUNT(*) FROM TicketAttachments ta WHERE ta.ticket_id = t.ticket_id) AS attachment_count,
                    (SELECT COUNT(*) FROM TicketComments tc WHERE tc.ticket_id = t.ticket_id) AS comment_count
                FROM Tickets t
                LEFT JOIN Categories c ON t.category_id = c.category_id
                LEFT JOIN Users creator ON t.created_by = creator.user_id
                LEFT JOIN Users assignee ON t.assigned_to = assignee.user_id
                ${where}
            ) sub WHERE rn > ${offset}
        `, inputs);

        res.json({ success: true, tickets: result.recordset, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/tickets/stats — dashboard stats
router.get('/stats', authenticateToken, async (req, res) => {
    try {
        let userFilter = req.user.can_view_all_tickets ? '' : `AND (created_by = ${req.user.user_id} OR assigned_to = ${req.user.user_id})`;
        
        const result = await query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) as open_count,
                SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) as in_progress_count,
                SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved_count,
                SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) as closed_count,
                SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_count,
                SUM(CASE WHEN priority = 'Urgent' AND status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END) as urgent_open,
                SUM(CASE WHEN assigned_to IS NULL AND status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END) as unassigned_count
            FROM Tickets WHERE 1=1 ${userFilter}
        `);
        res.json({ success: true, stats: result.recordset[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/tickets/attachment/:id/download
router.get('/attachment/:id/download', authenticateToken, async (req, res) => {
    try {
        const result = await query(`SELECT * FROM TicketAttachments WHERE attachment_id = @id`, { id: { type: sql.Int, value: req.params.id } });
        if (!result.recordset.length) return res.status(404).json({ success: false, message: 'File not found.' });
        const file = result.recordset[0];
        res.download(file.file_path, file.original_name);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/tickets/:id
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const result = await query(`
            SELECT t.*, c.category_name,
                creator.full_name AS created_by_name, creator.email AS created_by_email,
                assignee.full_name AS assigned_to_name, assignee.email AS assigned_to_email, assignee.user_id AS assigned_to_id
            FROM Tickets t
            LEFT JOIN Categories c ON t.category_id = c.category_id
            LEFT JOIN Users creator ON t.created_by = creator.user_id
            LEFT JOIN Users assignee ON t.assigned_to = assignee.user_id
            WHERE t.ticket_id = @id
        `, { id: { type: sql.Int, value: req.params.id } });

        if (!result.recordset.length) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        const ticket = result.recordset[0];

        if (!req.user.can_view_all_tickets && ticket.created_by !== req.user.user_id && ticket.assigned_to_id !== req.user.user_id) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        // Get attachments
        const attachments = await query(`SELECT * FROM TicketAttachments WHERE ticket_id = @id ORDER BY uploaded_at DESC`, { id: { type: sql.Int, value: req.params.id } });
        // Get comments
        const comments = await query(`
            SELECT tc.*, u.full_name, u.role_id FROM TicketComments tc
            JOIN Users u ON tc.user_id = u.user_id
            WHERE tc.ticket_id = @id ORDER BY tc.created_at ASC
        `, { id: { type: sql.Int, value: req.params.id } });
        // Get history
        const history = await query(`
            SELECT th.*, u.full_name FROM TicketHistory th
            JOIN Users u ON th.changed_by = u.user_id
            WHERE th.ticket_id = @id ORDER BY th.changed_at DESC
        `, { id: { type: sql.Int, value: req.params.id } });

        let linkedAssets = [];
        try {
            const assets = await query(`
                SELECT a.*, ac.category_name, u.full_name AS assigned_to_name
                FROM ticket_assets ta
                JOIN assets a ON ta.asset_id = a.asset_id
                LEFT JOIN asset_categories ac ON a.category_id = ac.category_id
                LEFT JOIN Users u ON a.assigned_to = u.user_id
                WHERE ta.ticket_id = @id
                ORDER BY ta.linked_at DESC
            `, { id: { type: sql.Int, value: req.params.id } });
            linkedAssets = assets.recordset;
        } catch (err) {
            if (!isMissingObjectError(err)) throw err;
            console.warn('Asset tables not found; returning ticket without linked assets.');
        }

        res.json({
            success: true,
            ticket,
            attachments: attachments.recordset,
            comments: comments.recordset,
            history: history.recordset,
            assets: linkedAssets,
            linked_assets: linkedAssets
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/tickets — create ticket
router.post('/', authenticateToken, upload.array('attachments', 5), async (req, res) => {
    try {
        const { title, description, category_id, priority, department, due_date, asset_id } = req.body;
        if (!title || !description) return res.status(400).json({ success: false, message: 'Title and description required.' });

        const ticketNumber = await generateTicketNumber();

        const result = await query(`
            INSERT INTO Tickets (ticket_number, title, description, category_id, priority, department, due_date, created_by, status)
            OUTPUT INSERTED.ticket_id
            VALUES (@num, @title, @desc, @cat, @priority, @dept, @due, @createdBy, 'Open')
        `, {
            num: { type: sql.NVarChar, value: ticketNumber },
            title: { type: sql.NVarChar, value: title },
            desc: { type: sql.NVarChar, value: description },
            cat: { type: sql.Int, value: category_id || null },
            priority: { type: sql.NVarChar, value: priority || 'Normal' },
            dept: { type: sql.NVarChar, value: department || req.user.department },
            due: { type: sql.DateTime, value: due_date || null },
            createdBy: { type: sql.Int, value: req.user.user_id }
        });

        const ticketId = result.recordset[0].ticket_id;

        if (asset_id) {
            await linkTicketAsset(ticketId, Number(asset_id), req.user);
        }

        // Save attachments
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                await query(`
                    INSERT INTO TicketAttachments (ticket_id, file_name, original_name, file_type, file_size, file_path, uploaded_by)
                    VALUES (@tid, @fname, @oname, @ftype, @fsize, @fpath, @uid)
                `, {
                    tid: { type: sql.Int, value: ticketId },
                    fname: { type: sql.NVarChar, value: file.filename },
                    oname: { type: sql.NVarChar, value: file.originalname },
                    ftype: { type: sql.NVarChar, value: file.mimetype },
                    fsize: { type: sql.BigInt, value: file.size },
                    fpath: { type: sql.NVarChar, value: file.path },
                    uid: { type: sql.Int, value: req.user.user_id }
                });
            }
        }

        // History
        await query(`
            INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value)
            VALUES (@tid, @uid, 'status', NULL, 'Open')
        `, { tid: { type: sql.Int, value: ticketId }, uid: { type: sql.Int, value: req.user.user_id } });

        res.json({ success: true, message: 'Ticket created.', ticket_id: ticketId, ticket_number: ticketNumber });
    } catch (err) {
        if (err.message?.toLowerCase().includes('asset')) {
            return res.status(400).json({ success: false, message: err.message });
        }
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PATCH /api/tickets/:id — update ticket (status, assign, etc.)
router.patch('/:id', authenticateToken, async (req, res) => {
    try {
        const { status, assigned_to, resolution_notes, priority, due_date, asset_id } = req.body;
        const ticketId = req.params.id;

        const existing = await query(`SELECT * FROM Tickets WHERE ticket_id = @id`, { id: { type: sql.Int, value: ticketId } });
        if (!existing.recordset.length) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        const ticket = existing.recordset[0];

        if (!req.user.can_assign_tickets && ticket.created_by !== req.user.user_id) {
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        const updates = [];
        const inputs = { id: { type: sql.Int, value: ticketId } };

        if (status) {
            updates.push('status = @status');
            inputs.status = { type: sql.NVarChar, value: status };
            if (status === 'Resolved') { updates.push('resolved_at = GETDATE()'); }
            await query(`INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (@id, @uid, 'status', @old, @new)`,
                { id: { type: sql.Int, value: ticketId }, uid: { type: sql.Int, value: req.user.user_id }, old: { type: sql.NVarChar, value: ticket.status }, new: { type: sql.NVarChar, value: status } });
        }
        if (assigned_to !== undefined && req.user.can_assign_tickets) {
            updates.push('assigned_to = @assignedTo');
            inputs.assignedTo = { type: sql.Int, value: assigned_to || null };
            await query(`INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (@id, @uid, 'assigned_to', @old, @new)`,
                { id: { type: sql.Int, value: ticketId }, uid: { type: sql.Int, value: req.user.user_id }, old: { type: sql.NVarChar, value: ticket.assigned_to }, new: { type: sql.NVarChar, value: assigned_to } });
        }
        if (resolution_notes) { updates.push('resolution_notes = @notes'); inputs.notes = { type: sql.NVarChar, value: resolution_notes }; }
        if (priority) { updates.push('priority = @priority'); inputs.priority = { type: sql.NVarChar, value: priority }; }
        if (due_date) { updates.push('due_date = @due'); inputs.due = { type: sql.DateTime, value: due_date }; }
        if (asset_id !== undefined) {
            await linkTicketAsset(ticketId, asset_id ? Number(asset_id) : null, req.user);
        }

        if (!updates.length && asset_id === undefined) return res.status(400).json({ success: false, message: 'No updates provided.' });

        if (updates.length) {
            updates.push('updated_at = GETDATE()');
            await query(`UPDATE Tickets SET ${updates.join(', ')} WHERE ticket_id = @id`, inputs);
        } else {
            await query(`UPDATE Tickets SET updated_at = GETDATE() WHERE ticket_id = @id`, inputs);
        }

        res.json({ success: true, message: 'Ticket updated.' });
    } catch (err) {
        if (err.message?.toLowerCase().includes('asset')) {
            return res.status(400).json({ success: false, message: err.message });
        }
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/tickets/:id/comments
router.post('/:id/comments', authenticateToken, async (req, res) => {
    try {
        const { comment, is_internal } = req.body;
        if (!comment) return res.status(400).json({ success: false, message: 'Comment required.' });

        await query(`INSERT INTO TicketComments (ticket_id, user_id, comment, is_internal) VALUES (@tid, @uid, @comment, @internal)`, {
            tid: { type: sql.Int, value: req.params.id },
            uid: { type: sql.Int, value: req.user.user_id },
            comment: { type: sql.NVarChar, value: comment },
            internal: { type: sql.Bit, value: is_internal ? 1 : 0 }
        });

        await query(`UPDATE Tickets SET updated_at = GETDATE() WHERE ticket_id = @id`, { id: { type: sql.Int, value: req.params.id } });
        res.json({ success: true, message: 'Comment added.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/tickets/:id/attachments
router.post('/:id/attachments', authenticateToken, upload.array('attachments', 5), async (req, res) => {
    try {
        if (!req.files || !req.files.length) return res.status(400).json({ success: false, message: 'No files uploaded.' });
        for (const file of req.files) {
            await query(`INSERT INTO TicketAttachments (ticket_id, file_name, original_name, file_type, file_size, file_path, uploaded_by) VALUES (@tid, @fname, @oname, @ftype, @fsize, @fpath, @uid)`, {
                tid: { type: sql.Int, value: req.params.id },
                fname: { type: sql.NVarChar, value: file.filename },
                oname: { type: sql.NVarChar, value: file.originalname },
                ftype: { type: sql.NVarChar, value: file.mimetype },
                fsize: { type: sql.BigInt, value: file.size },
                fpath: { type: sql.NVarChar, value: file.path },
                uid: { type: sql.Int, value: req.user.user_id }
            });
        }
        res.json({ success: true, message: `${req.files.length} file(s) uploaded.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
