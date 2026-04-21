const express = require('express');
const router = express.Router();
const {
  getAllRecords,
  addRecord,
  updateRecord,
  deleteRecord,
  getUniqueReasons,
  getPayments,
  addPayment,
  deletePayment
} = require('../controllers/spend.js');
const { verifyToken } = require("../middleware/auth.js");

router.get('/shop_spend/reasons',                    verifyToken, getUniqueReasons);
router.get('/shop_spend',                            verifyToken, getAllRecords);
router.post('/shop_spend',                           verifyToken, addRecord);
router.put('/shop_spend/:id',                        verifyToken, updateRecord);
router.delete('/shop_spend/:id',                     verifyToken, deleteRecord);

/* Split payments */
router.get('/shop_spend/:id/payments',               verifyToken, getPayments);
router.post('/shop_spend/:id/payments',              verifyToken, addPayment);
router.delete('/shop_spend/:id/payments/:payment_id', verifyToken, deletePayment);

module.exports = router;