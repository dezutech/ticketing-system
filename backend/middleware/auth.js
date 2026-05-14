// backend/middleware/auth.js
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. Please login.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
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
