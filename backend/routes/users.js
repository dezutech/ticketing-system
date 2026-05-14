// backend/routes/users.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query, sql } = require('../config/database');
const { authenticateToken, requirePermission } = require('../middleware/auth');

// GET /api/users
router.get('/', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const result = await query(`
            SELECT u.user_id, u.username, u.email, u.full_name, u.department, u.phone,
                u.position, u.branch, u.is_active, u.created_at, u.last_login, u.must_change_password,
                r.role_name, r.role_id
            FROM Users u JOIN Roles r ON u.role_id = r.role_id
            ORDER BY u.created_at DESC
        `);
        res.json({ success: true, users: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/users/all-users — for "Request by" dropdown (admin/staff only)
router.get('/all-users', authenticateToken, requirePermission('can_assign_tickets'), async (req, res) => {
    try {
        const result = await query(`
            SELECT user_id, full_name, email, department FROM Users
            WHERE is_active = 1 ORDER BY full_name
        `);
        res.json({ success: true, users: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/users/staff
router.get('/staff', authenticateToken, requirePermission('can_assign_tickets'), async (req, res) => {
    try {
        const result = await query(`
            SELECT u.user_id, u.full_name, u.email, r.role_name
            FROM Users u JOIN Roles r ON u.role_id = r.role_id
            WHERE u.is_active = 1 AND r.role_name IN ('Admin', 'Staff', 'Super Admin')
            ORDER BY u.full_name
        `);
        res.json({ success: true, staff: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/users
router.post('/', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const { username, email, password, full_name, role_id, department, phone, position, branch } = req.body;
        if (!username || !email || !password || !full_name) {
            return res.status(400).json({ success: false, message: 'All required fields must be filled.' });
        }

        const roleResult = await query(`SELECT * FROM Roles WHERE role_id = @id`, { id: { type: sql.Int, value: role_id } });
        if (!roleResult.recordset.length) return res.status(400).json({ success: false, message: 'Invalid role.' });

        if (roleResult.recordset[0].can_manage_roles && !req.user.can_manage_roles) {
            return res.status(403).json({ success: false, message: 'Cannot assign Super Admin role.' });
        }

        const hash = await bcrypt.hash(password, 10);
        await query(`
            INSERT INTO Users (username, email, password_hash, full_name, role_id, department, phone, position, branch)
            VALUES (@username, @email, @hash, @name, @role, @dept, @phone, @position, @branch)
        `, {
            username: { type: sql.NVarChar, value: username },
            email: { type: sql.NVarChar, value: email },
            hash: { type: sql.NVarChar, value: hash },
            name: { type: sql.NVarChar, value: full_name },
            role: { type: sql.Int, value: role_id },
            dept: { type: sql.NVarChar, value: department || null },
            phone: { type: sql.NVarChar, value: phone || null },
            position: { type: sql.NVarChar, value: position || null },
            branch: { type: sql.NVarChar, value: branch || null },
        });

        res.json({ success: true, message: 'User created successfully.' });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) return res.status(400).json({ success: false, message: 'Username or email already exists.' });
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/users/:id/reset-password — reset to "123"
router.post('/:id/reset-password', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const hash = await bcrypt.hash('123', 10);
        await query(`
            UPDATE Users SET password_hash = @hash, must_change_password = 1, updated_at = GETDATE()
            WHERE user_id = @id
        `, {
            hash: { type: sql.NVarChar, value: hash },
            id: { type: sql.Int, value: req.params.id }
        });
        res.json({ success: true, message: 'Password reset to 123. User must change on next login.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PATCH /api/users/:id
router.patch('/:id', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const { full_name, email, role_id, department, phone, position, branch, is_active, password } = req.body;
        const updates = [];
        const inputs = { id: { type: sql.Int, value: req.params.id } };

        if (full_name) { updates.push('full_name = @name'); inputs.name = { type: sql.NVarChar, value: full_name }; }
        if (email) { updates.push('email = @email'); inputs.email = { type: sql.NVarChar, value: email }; }
        if (role_id) {
            if (!req.user.can_manage_roles) {
                const roleRes = await query(`SELECT can_manage_roles FROM Roles WHERE role_id = @rid`, { rid: { type: sql.Int, value: role_id } });
                if (roleRes.recordset[0]?.can_manage_roles) return res.status(403).json({ success: false, message: 'Cannot assign this role.' });
            }
            updates.push('role_id = @role'); inputs.role = { type: sql.Int, value: role_id };
        }
        if (department !== undefined) { updates.push('department = @dept'); inputs.dept = { type: sql.NVarChar, value: department }; }
        if (phone !== undefined) { updates.push('phone = @phone'); inputs.phone = { type: sql.NVarChar, value: phone }; }
        if (position !== undefined) { updates.push('position = @position'); inputs.position = { type: sql.NVarChar, value: position }; }
        if (branch !== undefined) { updates.push('branch = @branch'); inputs.branch = { type: sql.NVarChar, value: branch }; }
        if (is_active !== undefined) { updates.push('is_active = @active'); inputs.active = { type: sql.Bit, value: is_active ? 1 : 0 }; }
        if (password) {
            const hash = await bcrypt.hash(password, 10);
            updates.push('password_hash = @hash', 'must_change_password = 0');
            inputs.hash = { type: sql.NVarChar, value: hash };
        }

        if (!updates.length) return res.status(400).json({ success: false, message: 'No updates provided.' });
        updates.push('updated_at = GETDATE()');

        await query(`UPDATE Users SET ${updates.join(', ')} WHERE user_id = @id`, inputs);
        res.json({ success: true, message: 'User updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE/deactivate user
router.delete('/:id', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        if (parseInt(req.params.id) === req.user.user_id) {
            return res.status(400).json({ success: false, message: 'Cannot deactivate your own account.' });
        }
        await query(`UPDATE Users SET is_active = 0 WHERE user_id = @id`, { id: { type: sql.Int, value: req.params.id } });
        res.json({ success: true, message: 'User deactivated.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ============ ROLES ============

router.get('/roles', authenticateToken, async (req, res) => {
    try {
        const result = await query(`SELECT * FROM Roles WHERE is_active = 1 ORDER BY role_id`);
        res.json({ success: true, roles: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.post('/roles', authenticateToken, requirePermission('can_manage_roles'), async (req, res) => {
    try {
        const { role_name, description, can_assign_tickets, can_manage_users, can_view_all_tickets } = req.body;
        if (!role_name) return res.status(400).json({ success: false, message: 'Role name required.' });

        await query(`
            INSERT INTO Roles (role_name, description, can_assign_tickets, can_manage_users, can_view_all_tickets, can_manage_roles)
            VALUES (@name, @desc, @assign, @manage, @view, 0)
        `, {
            name: { type: sql.NVarChar, value: role_name },
            desc: { type: sql.NVarChar, value: description || null },
            assign: { type: sql.Bit, value: can_assign_tickets ? 1 : 0 },
            manage: { type: sql.Bit, value: can_manage_users ? 1 : 0 },
            view: { type: sql.Bit, value: can_view_all_tickets ? 1 : 0 },
        });
        res.json({ success: true, message: 'Role created.' });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) return res.status(400).json({ success: false, message: 'Role name already exists.' });
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.patch('/roles/:id', authenticateToken, requirePermission('can_manage_roles'), async (req, res) => {
    try {
        const { role_name, description, can_assign_tickets, can_manage_users, can_view_all_tickets } = req.body;
        const updates = [];
        const inputs = { id: { type: sql.Int, value: req.params.id } };

        if (role_name) { updates.push('role_name = @name'); inputs.name = { type: sql.NVarChar, value: role_name }; }
        if (description !== undefined) { updates.push('description = @desc'); inputs.desc = { type: sql.NVarChar, value: description }; }
        if (can_assign_tickets !== undefined) { updates.push('can_assign_tickets = @assign'); inputs.assign = { type: sql.Bit, value: can_assign_tickets ? 1 : 0 }; }
        if (can_manage_users !== undefined) { updates.push('can_manage_users = @manage'); inputs.manage = { type: sql.Bit, value: can_manage_users ? 1 : 0 }; }
        if (can_view_all_tickets !== undefined) { updates.push('can_view_all_tickets = @view'); inputs.view = { type: sql.Bit, value: can_view_all_tickets ? 1 : 0 }; }

        if (!updates.length) return res.status(400).json({ success: false, message: 'No updates.' });
        await query(`UPDATE Roles SET ${updates.join(', ')} WHERE role_id = @id`, inputs);
        res.json({ success: true, message: 'Role updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ============ CATEGORIES ============

router.get('/categories', authenticateToken, async (req, res) => {
    try {
        const result = await query(`SELECT * FROM Categories ORDER BY is_active DESC, category_name`);
        res.json({ success: true, categories: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.post('/categories', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const { category_name, description, is_active } = req.body;
        if (!category_name) return res.status(400).json({ success: false, message: 'Category name required.' });
        await query(`
            INSERT INTO Categories (category_name, description, is_active)
            VALUES (@name, @desc, @active)
        `, {
            name: { type: sql.NVarChar, value: category_name },
            desc: { type: sql.NVarChar, value: description || null },
            active: { type: sql.Bit, value: is_active !== false ? 1 : 0 },
        });
        res.json({ success: true, message: 'Category created.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.patch('/categories/:id', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const { category_name, description, is_active } = req.body;
        const updates = [];
        const inputs = { id: { type: sql.Int, value: req.params.id } };
        if (category_name) { updates.push('category_name = @name'); inputs.name = { type: sql.NVarChar, value: category_name }; }
        if (description !== undefined) { updates.push('description = @desc'); inputs.desc = { type: sql.NVarChar, value: description }; }
        if (is_active !== undefined) { updates.push('is_active = @active'); inputs.active = { type: sql.Bit, value: is_active ? 1 : 0 }; }
        if (!updates.length) return res.status(400).json({ success: false, message: 'No updates.' });
        await query(`UPDATE Categories SET ${updates.join(', ')} WHERE category_id = @id`, inputs);
        res.json({ success: true, message: 'Category updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ============ DEPARTMENTS ============

router.get('/departments', authenticateToken, async (req, res) => {
    try {
        const result = await query(`SELECT * FROM Departments ORDER BY is_active DESC, department_name`);
        res.json({ success: true, departments: result.recordset });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.post('/departments', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const { department_name, description, is_active } = req.body;
        if (!department_name) return res.status(400).json({ success: false, message: 'Department name required.' });
        await query(`
            INSERT INTO Departments (department_name, description, is_active)
            VALUES (@name, @desc, @active)
        `, {
            name: { type: sql.NVarChar, value: department_name },
            desc: { type: sql.NVarChar, value: description || null },
            active: { type: sql.Bit, value: is_active !== false ? 1 : 0 },
        });
        res.json({ success: true, message: 'Department created.' });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) return res.status(400).json({ success: false, message: 'Department name already exists.' });
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.patch('/departments/:id', authenticateToken, requirePermission('can_manage_users'), async (req, res) => {
    try {
        const { department_name, description, is_active } = req.body;
        const updates = [];
        const inputs = { id: { type: sql.Int, value: req.params.id } };
        if (department_name) { updates.push('department_name = @name'); inputs.name = { type: sql.NVarChar, value: department_name }; }
        if (description !== undefined) { updates.push('description = @desc'); inputs.desc = { type: sql.NVarChar, value: description }; }
        if (is_active !== undefined) { updates.push('is_active = @active'); inputs.active = { type: sql.Bit, value: is_active ? 1 : 0 }; }
        if (!updates.length) return res.status(400).json({ success: false, message: 'No updates.' });
        await query(`UPDATE Departments SET ${updates.join(', ')} WHERE department_id = @id`, inputs);
        res.json({ success: true, message: 'Department updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
