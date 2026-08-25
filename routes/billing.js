const express    = require("express");
const router     = express.Router();
const controller = require("../controllers/billing.js");
const { verifyToken } = require("../middleware/auth.js");

router.post("/bills",               verifyToken, controller.createBill);
router.post("/bills/check-stock",   verifyToken, controller.checkStock);
router.post("/bill/complete/:id",   verifyToken, controller.completeBill);
router.post("/bill/cancel/:id",     verifyToken, controller.cancelBill);
router.get("/pending",              verifyToken, controller.pendingBills);
router.get("/completed",            verifyToken, controller.completedBills);
router.put("/bills/completed/:id",    verifyToken, controller.editCompletedBill);    // must be before /bills/:id
router.delete("/bills/completed/:id", verifyToken, controller.deleteCompletedBill);
router.put("/bills/:id",            verifyToken, controller.updateBill);

module.exports = router;
