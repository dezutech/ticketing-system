// backend/routes/tickets.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query, sql } = require('../config/database');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');
const { notifyUsers, getAdminNotificationRecipients, getUsersByRoles } = require('../utils/notificationService');

const TICKET_PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'];
const TICKET_STATUSES = ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed'];
const ACKNOWLEDGED_STATUSES = ['In Progress', 'Pending', 'Resolved', 'Closed'];
const RESOLVED_STATUSES = ['Resolved', 'Closed'];
const SLA_ACK_TARGET_MINUTES = 4 * 60;
const SLA_RESOLVE_TARGET_MINUTES = 72 * 60;
const SLA_WARNING_RATIO = 0.8;
const passwordResetLookups = new Map();
const passwordResetVerifications = new Map();
const passwordResetRateLimits = new Map();
const PASSWORD_RESET_TOKEN_TTL = 10 * 60 * 1000;
const PASSWORD_RESET_RATE_WINDOW = 15 * 60 * 1000;
const PASSWORD_RESET_RATE_MAX = 8;

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
    const result = await query(`
        SELECT MAX(TRY_CONVERT(INT, RIGHT(ticket_number, 4))) AS lastNumber
        FROM Tickets
        WHERE ticket_number LIKE @prefix
    `, {
        prefix: { type: sql.NVarChar, value: `TKT-${year}-%` }
    });
    const count = (result.recordset[0].lastNumber || 0) + 1;
    return `TKT-${year}-${String(count).padStart(4, '0')}`;
}

function isDuplicateTicketNumberError(err) {
    return err?.number === 2627 && /UQ__Tickets|duplicate key/i.test(err?.message || '');
}

async function createTicketWithGeneratedNumber(insertTicket) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const ticketNumber = await generateTicketNumber();
        try {
            const result = await insertTicket(ticketNumber);
            return { ticketNumber, result };
        } catch (err) {
            if (!isDuplicateTicketNumberError(err)) throw err;
            lastError = err;
        }
    }
    throw lastError || new Error('Unable to generate a unique ticket number.');
}

function canManageAssets(user) {
    return ['Super Admin', 'Admin', 'Staff'].includes(user?.role_name);
}

function isMissingObjectError(err) {
    return err?.number === 208 || /invalid object name/i.test(err?.message || '');
}

function nullableString(value) {
    return value === undefined || value === null || value === '' ? null : String(value);
}

function nullableInt(value) {
    return value === undefined || value === null || value === '' ? null : Number(value);
}

function parsePositiveInt(value, fallback, max = null) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return max ? Math.min(parsed, max) : parsed;
}

function ticketLink(ticketId) {
    return `ticket:${ticketId}`;
}

function ticketNotificationOptions(type, ticketId, title) {
    return { title, type, relatedTicketId: Number(ticketId) };
}

function cleanText(value, max = 4000) {
    const text = String(value || '').trim();
    return text.length > max ? text.slice(0, max) : text;
}

async function getOrCreatePasswordResetCategory() {
    const existing = await query(`
        SELECT TOP 1 category_id, category_name
        FROM Categories
        WHERE is_active = 1
          AND LOWER(category_name) = 'account access'
    `);
    if (existing.recordset.length) return existing.recordset[0];

    const created = await query(`
        INSERT INTO Categories (category_name, description, is_active)
        OUTPUT INSERTED.category_id, INSERTED.category_name
        VALUES ('Account Access', 'Self-service account access and password reset requests', 1)
    `);
    return created.recordset[0];
}

function buildPasswordResetDescription(body) {
    const rows = [
        ['Full Name', cleanText(body.full_name, 150)],
        ['Username/Email', cleanText(body.username_or_email, 150)],
        ['Department', cleanText(body.department, 120)],
        ['Branch', cleanText(body.branch, 120)],
        ['Contact Number', cleanText(body.contact_number, 60)],
        ['Account/System', cleanText(body.account_system, 150)],
        ['Reason', cleanText(body.reason, 1000)],
        ['Additional Notes', cleanText(body.additional_notes, 2000) || 'None provided']
    ];

    return [
        'Self-Service Password Reset Request',
        '',
        ...rows.map(([label, value]) => `${label}: ${value || 'Not provided'}`),
        '',
        'Security note: This ticket records the request only. Passwords must be verified and reset manually by authorized support staff.'
    ].join('\n');
}

function randomToken() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function cleanupPasswordResetTokens() {
    const now = Date.now();
    for (const [token, data] of passwordResetLookups) {
        if (data.expiresAt <= now) passwordResetLookups.delete(token);
    }
    for (const [token, data] of passwordResetVerifications) {
        if (data.expiresAt <= now) passwordResetVerifications.delete(token);
    }
}

function rateLimitPasswordReset(key) {
    const now = Date.now();
    const current = passwordResetRateLimits.get(key);
    if (!current || current.resetAt <= now) {
        passwordResetRateLimits.set(key, { count: 1, resetAt: now + PASSWORD_RESET_RATE_WINDOW });
        return false;
    }
    current.count += 1;
    return current.count > PASSWORD_RESET_RATE_MAX;
}

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '').replace(/^0/, '63');
}

function maskPhone(value) {
    const digits = normalizePhone(value);
    const last4 = digits.slice(-4).padStart(4, '*');
    return `+63 ***** ${last4}`;
}

async function findPasswordResetUser(identifier) {
    const lookup = cleanText(identifier, 150);
    if (!lookup) return null;
    const numericId = Number.parseInt(lookup, 10);
    const inputs = {
        lookup: { type: sql.NVarChar, value: lookup }
    };
    if (Number.isInteger(numericId) && String(numericId) === lookup) {
        inputs.userId = { type: sql.Int, value: numericId };
    }
    const result = await query(`
        SELECT TOP 1 u.user_id, u.username, u.email, u.full_name, u.department, u.phone, u.branch, r.role_name
        FROM Users u
        JOIN Roles r ON u.role_id = r.role_id
        WHERE u.is_active = 1
          AND (
              LOWER(u.username) = LOWER(@lookup)
              OR LOWER(u.email) = LOWER(@lookup)
              ${inputs.userId ? 'OR u.user_id = @userId' : ''}
          )
        ORDER BY u.user_id
    `, inputs);
    return result.recordset[0] || null;
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
        const { status, priority, assigned, search, created_by, mine } = req.query;
        const page = parsePositiveInt(req.query.page, 1);
        const limit = parsePositiveInt(req.query.limit, 20, 100);
        const offset = (page - 1) * limit;
        let conditions = [];
        let inputs = {};

        if (mine === '1' || mine === 'true') {
            conditions.push('(t.created_by = @userId OR t.assigned_to = @userId)');
            inputs.userId = { type: sql.Int, value: req.user.user_id };
        } else if (!req.user.can_view_all_tickets) {
            conditions.push(req.user.can_assign_tickets ? '(t.created_by = @userId OR t.assigned_to = @userId)' : 't.created_by = @userId');
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
        if (created_by !== undefined) {
            const createdBy = nullableInt(created_by);
            if (createdBy === null || !Number.isInteger(createdBy)) {
                return res.status(400).json({ success: false, message: 'Invalid created by user.' });
            }
            if (!req.user.can_view_all_tickets && createdBy !== req.user.user_id) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
            }
            conditions.push('t.created_by = @createdBy');
            inputs.createdBy = { type: sql.Int, value: createdBy };
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
                    t.created_at, t.updated_at, t.acknowledged_at, t.resolved_at, t.due_date,
                    CASE WHEN t.acknowledged_at IS NOT NULL THEN DATEDIFF(MINUTE, t.created_at, t.acknowledged_at) END AS time_to_acknowledge_minutes,
                    CASE WHEN t.resolved_at IS NOT NULL THEN DATEDIFF(MINUTE, t.created_at, t.resolved_at) END AS time_to_resolve_minutes,
                    CASE
                        WHEN t.acknowledged_at IS NULL AND GETDATE() > DATEADD(MINUTE, ${SLA_ACK_TARGET_MINUTES}, t.created_at) THEN 'Overdue'
                        WHEN t.acknowledged_at IS NOT NULL AND DATEDIFF(MINUTE, t.created_at, t.acknowledged_at) > ${SLA_ACK_TARGET_MINUTES} THEN 'Overdue'
                        WHEN t.status IN ('Resolved', 'Closed') THEN
                            CASE
                                WHEN t.resolved_at <= COALESCE(t.due_date, DATEADD(MINUTE, ${SLA_RESOLVE_TARGET_MINUTES}, t.created_at)) THEN 'On Time'
                                ELSE 'Overdue'
                            END
                        WHEN GETDATE() > COALESCE(t.due_date, DATEADD(MINUTE, ${SLA_RESOLVE_TARGET_MINUTES}, t.created_at)) THEN 'Overdue'
                        WHEN t.acknowledged_at IS NULL AND GETDATE() >= DATEADD(MINUTE, CAST(${SLA_ACK_TARGET_MINUTES * SLA_WARNING_RATIO} AS INT), t.created_at) THEN 'Warning'
                        WHEN GETDATE() >= DATEADD(MINUTE, CAST(DATEDIFF(MINUTE, t.created_at, COALESCE(t.due_date, DATEADD(MINUTE, ${SLA_RESOLVE_TARGET_MINUTES}, t.created_at))) * ${SLA_WARNING_RATIO} AS INT), t.created_at) THEN 'Warning'
                        ELSE 'On Time'
                    END AS sla_status,
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
        let userFilter = '';
        if (!req.user.can_view_all_tickets) {
            userFilter = req.user.can_assign_tickets
                ? 'AND (created_by = @userId OR assigned_to = @userId)'
                : 'AND created_by = @userId';
        }
        const inputs = req.user.can_view_all_tickets ? {} : { userId: { type: sql.Int, value: req.user.user_id } };
        
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
        `, inputs);
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

// POST /api/tickets/password-reset/find-account - public account lookup
router.post('/password-reset/find-account', async (req, res) => {
    try {
        cleanupPasswordResetTokens();
        const rateKey = `find:${req.ip}`;
        if (rateLimitPasswordReset(rateKey)) {
            return res.status(429).json({ success: false, message: 'Too many attempts. Please try again later.' });
        }

        const identifier = cleanText(req.body.identifier, 150);
        if (!identifier) return res.status(400).json({ success: false, message: 'Please enter your Employee ID, username, or email.' });

        const user = await findPasswordResetUser(identifier);
        if (!user || !cleanText(user.phone, 60)) {
            return res.json({ success: false, message: 'No user or email found.' });
        }

        const lookupToken = randomToken();
        passwordResetLookups.set(lookupToken, {
            userId: user.user_id,
            attempts: 0,
            expiresAt: Date.now() + PASSWORD_RESET_TOKEN_TTL
        });

        res.json({
            success: true,
            lookup_token: lookupToken,
            display_name: user.full_name || user.username,
            masked_phone: maskPhone(user.phone)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/tickets/password-reset/verify-phone - verify registered phone number
router.post('/password-reset/verify-phone', async (req, res) => {
    try {
        cleanupPasswordResetTokens();
        const lookupToken = cleanText(req.body.lookup_token, 200);
        const phone = cleanText(req.body.phone, 60);
        const lookup = passwordResetLookups.get(lookupToken);
        if (!lookup) {
            return res.status(400).json({ success: false, message: 'Verification expired. Please search again.' });
        }
        if (lookup.attempts >= 3) {
            passwordResetLookups.delete(lookupToken);
            return res.status(429).json({ success: false, message: 'Too many attempts. Please search again later.' });
        }

        const result = await query(`
            SELECT TOP 1 user_id, username, email, full_name, department, phone, branch
            FROM Users
            WHERE user_id = @userId AND is_active = 1
        `, {
            userId: { type: sql.Int, value: lookup.userId }
        });
        const user = result.recordset[0];
        if (!user) {
            passwordResetLookups.delete(lookupToken);
            return res.status(400).json({ success: false, message: 'Verification expired. Please search again.' });
        }

        if (normalizePhone(phone) !== normalizePhone(user.phone)) {
            lookup.attempts += 1;
            return res.status(400).json({ success: false, message: 'Phone number does not match our records.' });
        }

        passwordResetLookups.delete(lookupToken);
        const verifiedToken = randomToken();
        passwordResetVerifications.set(verifiedToken, {
            userId: user.user_id,
            expiresAt: Date.now() + PASSWORD_RESET_TOKEN_TTL
        });

        res.json({
            success: true,
            verified_token: verifiedToken,
            user: {
                full_name: user.full_name || user.username,
                username_or_email: user.email || user.username,
                department: user.department || '',
                branch: user.branch || '',
                contact_number: user.phone || ''
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/tickets/password-reset-request - create verified self-service request
router.post('/password-reset-request', async (req, res) => {
    try {
        cleanupPasswordResetTokens();
        const verifiedToken = cleanText(req.body.verified_token, 200);
        const verified = passwordResetVerifications.get(verifiedToken);
        if (!verified) {
            return res.status(400).json({ success: false, message: 'Phone verification is required before submitting a request.' });
        }

        const accountSystem = cleanText(req.body.account_system, 150);
        const reason = cleanText(req.body.reason, 1000);
        const additionalNotes = cleanText(req.body.additional_notes, 2000);
        if (!accountSystem || !reason) {
            return res.status(400).json({ success: false, message: 'Please complete all required fields.' });
        }

        const [category, userResult] = await Promise.all([
            getOrCreatePasswordResetCategory(),
            query(`
                SELECT TOP 1 u.user_id, u.username, u.email, u.full_name, u.department, u.phone, u.branch, r.role_name
                FROM Users u
                JOIN Roles r ON u.role_id = r.role_id
                WHERE u.user_id = @userId AND u.is_active = 1
            `, {
                userId: { type: sql.Int, value: verified.userId }
            })
        ]);
        const creator = userResult.recordset[0];
        if (!creator) {
            passwordResetVerifications.delete(verifiedToken);
            return res.status(400).json({ success: false, message: 'Verified user is no longer available.' });
        }

        const fullName = creator.full_name || creator.username;
        const usernameOrEmail = creator.email || creator.username;
        const department = creator.department || '';
        const branch = creator.branch || '';
        const contactNumber = creator.phone || '';
        const title = `Password Reset Request - ${fullName}`;
        const description = buildPasswordResetDescription({
            full_name: fullName,
            username_or_email: usernameOrEmail,
            department,
            branch,
            contact_number: contactNumber,
            account_system: accountSystem,
            reason,
            additional_notes: additionalNotes
        });

        const { ticketNumber, result } = await createTicketWithGeneratedNumber(ticketNumber => query(`
                INSERT INTO Tickets (ticket_number, title, description, category_id, priority, department, created_by, status)
                OUTPUT INSERTED.ticket_id
                VALUES (@num, @title, @desc, @cat, 'Normal', @dept, @createdBy, 'Open')
            `, {
                num: { type: sql.NVarChar, value: ticketNumber },
                title: { type: sql.NVarChar, value: title },
                desc: { type: sql.NVarChar, value: description },
                cat: { type: sql.Int, value: category.category_id },
                dept: { type: sql.NVarChar, value: department },
                createdBy: { type: sql.Int, value: creator.user_id }
            })
        );

        const ticketId = result.recordset[0].ticket_id;

        await query(`
            INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value)
            VALUES (@tid, @uid, 'status', NULL, 'Open')
        `, {
            tid: { type: sql.Int, value: ticketId },
            uid: { type: sql.Int, value: creator.user_id }
        });

        await logActivity(
            creator,
            'Password reset request created',
            'Tickets',
            ticketId,
            {
                ticket_number: ticketNumber,
                category: category.category_name,
                department,
                branch,
                account_system: accountSystem,
                created_by_user_id: creator.user_id
            }
        );

        const recipients = (await getUsersByRoles(['Super Admin', 'Admin', 'Staff'])).map(user => user.user_id);
        await notifyUsers(
            recipients,
            `Self-service password reset request: ${ticketNumber} - ${fullName}`,
            'Tickets',
            ticketId,
            ticketLink(ticketId),
            ticketNotificationOptions('password_reset_request', ticketId, 'Password reset request')
        );
        passwordResetVerifications.delete(verifiedToken);

        res.json({
            success: true,
            message: 'Password reset request created.',
            ticket_id: ticketId,
            ticket_number: ticketNumber
        });
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
                CASE WHEN t.acknowledged_at IS NOT NULL THEN DATEDIFF(MINUTE, t.created_at, t.acknowledged_at) END AS time_to_acknowledge_minutes,
                CASE WHEN t.resolved_at IS NOT NULL THEN DATEDIFF(MINUTE, t.created_at, t.resolved_at) END AS time_to_resolve_minutes,
                CASE
                    WHEN t.acknowledged_at IS NULL AND GETDATE() > DATEADD(MINUTE, ${SLA_ACK_TARGET_MINUTES}, t.created_at) THEN 'Overdue'
                    WHEN t.acknowledged_at IS NOT NULL AND DATEDIFF(MINUTE, t.created_at, t.acknowledged_at) > ${SLA_ACK_TARGET_MINUTES} THEN 'Overdue'
                    WHEN t.status IN ('Resolved', 'Closed') THEN
                        CASE
                            WHEN t.resolved_at <= COALESCE(t.due_date, DATEADD(MINUTE, ${SLA_RESOLVE_TARGET_MINUTES}, t.created_at)) THEN 'On Time'
                            ELSE 'Overdue'
                        END
                    WHEN GETDATE() > COALESCE(t.due_date, DATEADD(MINUTE, ${SLA_RESOLVE_TARGET_MINUTES}, t.created_at)) THEN 'Overdue'
                    WHEN t.acknowledged_at IS NULL AND GETDATE() >= DATEADD(MINUTE, CAST(${SLA_ACK_TARGET_MINUTES * SLA_WARNING_RATIO} AS INT), t.created_at) THEN 'Warning'
                    WHEN GETDATE() >= DATEADD(MINUTE, CAST(DATEDIFF(MINUTE, t.created_at, COALESCE(t.due_date, DATEADD(MINUTE, ${SLA_RESOLVE_TARGET_MINUTES}, t.created_at))) * ${SLA_WARNING_RATIO} AS INT), t.created_at) THEN 'Warning'
                    ELSE 'On Time'
                END AS sla_status,
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
        if (priority && !TICKET_PRIORITIES.includes(priority)) {
            return res.status(400).json({ success: false, message: 'Invalid ticket priority.' });
        }

        const { ticketNumber, result } = await createTicketWithGeneratedNumber(ticketNumber => query(`
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
            })
        );

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

        await logActivity(req.user, 'Ticket created', 'Tickets', ticketId, {
            ticket_number: ticketNumber,
            title,
            priority: priority || 'Normal'
        });

        const adminRecipients = await getAdminNotificationRecipients([req.user.user_id]);
        await notifyUsers(
            adminRecipients,
            `New unassigned ticket created: ${ticketNumber} - ${title}`,
            'Tickets',
            ticketId,
            ticketLink(ticketId),
            ticketNotificationOptions('ticket_unassigned', ticketId, 'New unassigned ticket')
        );
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

        if (status && !TICKET_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid ticket status.' });
        }
        if (priority && !TICKET_PRIORITIES.includes(priority)) {
            return res.status(400).json({ success: false, message: 'Invalid ticket priority.' });
        }

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
            if (ACKNOWLEDGED_STATUSES.includes(status) && !ticket.acknowledged_at) {
                updates.push('acknowledged_at = GETDATE()');
            }
            if (RESOLVED_STATUSES.includes(status) && !ticket.resolved_at) {
                updates.push('resolved_at = GETDATE()');
            }
            await query(`INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (@id, @uid, 'status', @old, @new)`,
                { id: { type: sql.Int, value: ticketId }, uid: { type: sql.Int, value: req.user.user_id }, old: { type: sql.NVarChar, value: ticket.status }, new: { type: sql.NVarChar, value: status } });
            await logActivity(req.user, 'Ticket status changed', 'Tickets', ticketId, {
                from: ticket.status,
                to: status
            });
            const adminRecipients = await getAdminNotificationRecipients([req.user.user_id]);
            await notifyUsers(
                [ticket.created_by, ticket.assigned_to, ...adminRecipients],
                `Ticket ${ticket.ticket_number} status changed from ${ticket.status} to ${status}`,
                'Tickets',
                ticketId,
                ticketLink(ticketId),
                ticketNotificationOptions(['Resolved', 'Closed'].includes(status) ? 'ticket_closed' : 'ticket_status', ticketId, 'Ticket status changed')
            );
        }
        if (assigned_to !== undefined && req.user.can_assign_tickets) {
            const assignedTo = nullableInt(assigned_to);
            if (assignedTo !== null && !Number.isInteger(assignedTo)) {
                return res.status(400).json({ success: false, message: 'Invalid assigned user.' });
            }

            updates.push('assigned_to = @assignedTo');
            inputs.assignedTo = { type: sql.Int, value: assignedTo };
            await query(`INSERT INTO TicketHistory (ticket_id, changed_by, field_changed, old_value, new_value) VALUES (@id, @uid, 'assigned_to', @old, @new)`,
                { id: { type: sql.Int, value: ticketId }, uid: { type: sql.Int, value: req.user.user_id }, old: { type: sql.NVarChar, value: nullableString(ticket.assigned_to) }, new: { type: sql.NVarChar, value: nullableString(assignedTo) } });
            await logActivity(req.user, 'Ticket assigned', 'Tickets', ticketId, {
                from: ticket.assigned_to,
                to: assignedTo
            });
            const adminRecipients = await getAdminNotificationRecipients([req.user.user_id]);
            if (assignedTo && String(assignedTo) !== String(ticket.assigned_to || '')) {
                await notifyUsers(
                    [assignedTo],
                    `You have been assigned ${ticket.ticket_number} - ${ticket.title}`,
                    'Tickets',
                    ticketId,
                    ticketLink(ticketId),
                    ticketNotificationOptions('ticket_assigned', ticketId, 'Ticket assigned to you')
                );
            }
            if (ticket.assigned_to && String(ticket.assigned_to) !== String(assignedTo || '')) {
                await notifyUsers(
                    [ticket.assigned_to],
                    `${ticket.ticket_number} - ${ticket.title} was reassigned away from you`,
                    'Tickets',
                    ticketId,
                    ticketLink(ticketId),
                    ticketNotificationOptions('ticket_reassigned_away', ticketId, 'Ticket reassigned')
                );
            }
            await notifyUsers(
                adminRecipients,
                assignedTo
                    ? `${ticket.ticket_number} - ${ticket.title} was assigned`
                    : `${ticket.ticket_number} - ${ticket.title} was unassigned`,
                'Tickets',
                ticketId,
                ticketLink(ticketId),
                ticketNotificationOptions('ticket_assignment_update', ticketId, 'Ticket assignment updated')
            );
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
            await logActivity(req.user, 'Ticket updated', 'Tickets', ticketId, {
                fields: updates.filter(field => field !== 'updated_at = GETDATE()').map(field => field.split('=')[0].trim())
            });
        } else {
            await query(`UPDATE Tickets SET updated_at = GETDATE() WHERE ticket_id = @id`, inputs);
            await logActivity(req.user, 'Ticket updated', 'Tickets', ticketId, { fields: ['asset'] });
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
