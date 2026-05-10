const express = require('express');
const router = express.Router();
const { verifyToken, requireAdminOrManager } = require('../middleware/auth');
const c = require('../controllers/stockCount');

router.get('/stock-count/today',     verifyToken, c.getTodayCount);
router.post('/stock-count/save',     verifyToken, c.saveCount);
router.get('/stock-count/history',   verifyToken, c.getHistory);
router.get('/stock-count/dates',     verifyToken, c.getDates);
router.post('/stock-count/unlock/:id', verifyToken, requireAdminOrManager, c.unlockRow);
router.post('/stock-count/quick-add-item', verifyToken, c.quickAddItem);

module.exports = router;
