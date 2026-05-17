// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, sql } = require('../config/database');
const { authenticateToken, ensureUserThemeColumn } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');

const THEME_PREFERENCES = ['modern', 'classic', 'luna'];

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required.' });
        }

        await ensureUserThemeColumn();
        const result = await query(`
            SELECT u.*, r.role_name, r.can_assign_tickets, r.can_manage_users, 
                   r.can_view_all_tickets, r.can_manage_roles
            FROM Users u
            JOIN Roles r ON u.role_id = r.role_id
            WHERE (u.username = @username OR u.email = @username) AND u.is_active = 1
        `, {
            username: { type: sql.NVarChar, value: username }
        });

        if (result.recordset.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        const user = result.recordset[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        // Update last login
        await query(`UPDATE Users SET last_login = GETDATE() WHERE user_id = @id`, {
            id: { type: sql.Int, value: user.user_id }
        });

        const tokenPayload = {
            user_id: user.user_id,
            username: user.username,
            full_name: user.full_name,
            email: user.email,
            role_id: user.role_id,
            role_name: user.role_name,
            department: user.department,
            can_assign_tickets: user.can_assign_tickets,
            can_manage_users: user.can_manage_users,
            can_view_all_tickets: user.can_view_all_tickets,
            can_manage_roles: user.can_manage_roles,
            must_change_password: user.must_change_password ? true : false,
            theme_preference: user.theme_preference || 'modern'
        };

        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '8h' });

        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 8 * 60 * 60 * 1000 // 8 hours
        });

        await logActivity(tokenPayload, 'User login', 'Authentication', user.user_id, 'Successful login');
        return res.json({ success: true, message: 'Login successful.', user: tokenPayload });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
    const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            await logActivity(decoded, 'User logout', 'Authentication', decoded.user_id, 'User signed out');
        } catch (err) {
            console.warn('Logout activity log skipped:', err.message);
        }
    }
    res.clearCookie('token');
    res.json({ success: true, message: 'Logged out.' });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// PATCH /api/auth/theme
router.patch('/theme', authenticateToken, async (req, res) => {
    try {
        const { theme_preference } = req.body;
        if (!THEME_PREFERENCES.includes(theme_preference)) {
            return res.status(400).json({ success: false, message: 'Invalid theme selected.' });
        }

        await ensureUserThemeColumn();
        await query(`UPDATE Users SET theme_preference = @theme, updated_at = GETDATE() WHERE user_id = @id`, {
            theme: { type: sql.NVarChar, value: theme_preference },
            id: { type: sql.Int, value: req.user.user_id }
        });

        res.json({ success: true, message: 'Theme updated.', theme_preference });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ success: false, message: 'All fields required.' });
        }
        if (new_password.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
        }

        const result = await query(`SELECT password_hash FROM Users WHERE user_id = @id`, {
            id: { type: sql.Int, value: req.user.user_id }
        });

        const valid = await bcrypt.compare(current_password, result.recordset[0].password_hash);
        if (!valid) return res.status(400).json({ success: false, message: 'Current password incorrect.' });

        const hash = await bcrypt.hash(new_password, 10);
        await query(`UPDATE Users SET password_hash = @hash, updated_at = GETDATE() WHERE user_id = @id`, {
            hash: { type: sql.NVarChar, value: hash },
            id: { type: sql.Int, value: req.user.user_id }
        });

        res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
