const express = require('express');
const router = express.Router();
const {
  createTarget,
  getTargets,
  getTargetById,
  updateTarget,
  deleteTarget,
  addTargetItem,
  deleteTargetItem,
  getTargetAchievement
} = require('../controllers/targets');
const { verifyToken } = require('../middleware/auth');

router.get('/targets', verifyToken, getTargets);
router.post('/targets', verifyToken, createTarget);
router.get('/targets/:id', verifyToken, getTargetById);
router.put('/targets/:id', verifyToken, updateTarget);
router.delete('/targets/:id', verifyToken, deleteTarget);
router.post('/targets/:id/items', verifyToken, addTargetItem);
router.delete('/targets/:id/items/:itemId', verifyToken, deleteTargetItem);
router.get('/targets/:id/achievement', verifyToken, getTargetAchievement);

module.exports = router;
