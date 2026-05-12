const router = require('express').Router();
const ctrl = require('../controllers/employeeAdvance.js');
const { verifyToken } = require("../middleware/auth.js");

router.post('/employee-advance', verifyToken, ctrl.addAdvance);
router.get('/employee-advance', verifyToken, ctrl.getAdvanceHistory);
router.delete('/employee-advance/:id', verifyToken, ctrl.deleteAdvance);

module.exports = router;
