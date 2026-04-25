const express = require('express');
const router = express.Router();
const { login, createUser, getShops } = require('../controllers/users');
const { verifyToken, requireAdmin } = require('../middleware/auth');

// Public
router.post('/login', login);

// Admin-only
router.post('/create', verifyToken, requireAdmin, createUser);

// Shop list (any authenticated user)
router.get('/shops', verifyToken, getShops);

module.exports = router;
