// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const { query, sql } = require('../config/database');

async function authenticateToken(req, res, next) {
    const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. Please login.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await query(`
            SELECT u.user_id, u.username, u.email, u.full_name, u.department, u.role_id,
                   u.must_change_password, r.role_name, r.can_assign_tickets,
                   r.can_manage_users, r.can_view_all_tickets, r.can_manage_roles
            FROM Users u
            JOIN Roles r ON u.role_id = r.role_id
            WHERE u.user_id = @id AND u.is_active = 1
        `, {
            id: { type: sql.Int, value: decoded.user_id }
        });

        if (!result.recordset.length) {
            return res.status(401).json({ success: false, message: 'Account is inactive or no longer exists.' });
        }

        const freshUser = result.recordset[0];
        req.user = {
            user_id: freshUser.user_id,
            username: freshUser.username,
            full_name: freshUser.full_name,
            email: freshUser.email,
            role_id: freshUser.role_id,
            role_name: freshUser.role_name,
            department: freshUser.department,
            can_assign_tickets: !!freshUser.can_assign_tickets,
            can_manage_users: !!freshUser.can_manage_users,
            can_view_all_tickets: !!freshUser.can_view_all_tickets,
            can_manage_roles: !!freshUser.can_manage_roles,
            must_change_password: !!freshUser.must_change_password
        };
        next();
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated.' });
        if (!roles.includes(req.user.role_name)) {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }
        next();
    };
}

function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated.' });
        if (!req.user[permission]) {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }
        next();
    };
}

module.exports = { authenticateToken, requireRole, requirePermission };
