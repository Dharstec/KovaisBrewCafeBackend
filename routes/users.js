const express = require('express');
const router = express.Router();
const { login, createUser, getShops, getUsers, updateUser, deleteUser, getRoles, createRole } = require('../controllers/users');
const { verifyToken, requireAdmin } = require('../middleware/auth');

// Public
router.post('/login', login);

// Admin-only
router.post('/create',        verifyToken, requireAdmin, createUser);
router.get('/users',          verifyToken, requireAdmin, getUsers);
router.put('/users/:id',      verifyToken, requireAdmin, updateUser);
router.delete('/users/:id',   verifyToken, requireAdmin, deleteUser);
router.get('/roles',          verifyToken, requireAdmin, getRoles);
router.post('/roles',         verifyToken, requireAdmin, createRole);

// Shop list (any authenticated user)
router.get('/shops', verifyToken, getShops);

module.exports = router;
