const router = require("express").Router();
const c = require("../controllers/salary");
const { verifyToken } = require("../middleware/auth.js");

router.get("/salary/preview",  verifyToken, c.previewSalary);
router.post("/salary/finalize", verifyToken, c.finalizeSalary);
router.get("/salary/history",  verifyToken, c.getSalaryHistory);
router.get("/salary/months",   verifyToken, c.getSalaryMonths);

module.exports = router;
