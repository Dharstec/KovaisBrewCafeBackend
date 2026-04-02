const router = require("express").Router();
const c = require("../controllers/attendance");
const { verifyToken } = require("../middleware/auth.js");

router.get("/attendance/history", verifyToken, c.getAttendanceHistory);
router.get("/attendance",         verifyToken, c.getAttendanceByDate);
router.post("/attendance",        verifyToken, c.markAttendance);

module.exports = router;
