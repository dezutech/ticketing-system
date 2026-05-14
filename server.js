// server.js — Main Entry Point
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./backend/routes/auth');
const ticketRoutes = require('./backend/routes/tickets');
const userRoutes = require('./backend/routes/users');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files (protected — you can add auth middleware here)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/users', userRoutes);

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🎫 Ticketing System running at http://localhost:${PORT}`);
    console.log(`📁 Upload path: ${process.env.UPLOAD_PATH || './uploads'}`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
